from fastapi import FastAPI, HTTPException, File, UploadFile, Header, Request, Form
from fastapi.middleware.cors import CORSMiddleware # YENİ EKLENDİ
from fastapi.responses import Response
from pydantic import BaseModel
from operator import itemgetter
from typing import Optional, Tuple
import base64
import concurrent.futures
import gc
import ipaddress
import json
import os
import re
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_community.embeddings.fastembed import FastEmbedEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage
from db_pool import get_db
from gorsel_servisi import init_image_cache, replace_image_tags
from kullanim_servisi import (
    init_cache as init_llm_cache,
    make_cache_key,
    cache_get,
    cache_set,
    hash_bytes,
    check_rate_limit,
    increment_rate_limit,
    SERVER_KEY_DAILY_LIMIT,
)
from auth_servisi import (
    init_auth,
    create_user,
    authenticate,
    create_session,
    get_user_by_token,
    invalidate_session,
    refresh_session,
    revoke_all_user_sessions,
    find_oauth_user,
    register_oauth_user,
    create_or_replace_verification,
    verify_email_code,
    is_email_verified,
    get_user_by_id,
    get_user_by_email,
    create_password_reset,
    verify_and_execute_password_reset,
)
from email_servisi import send_verification_email, send_password_reset_email
from kavram_servisi import (
    init_kavram,
    klasor_listele,
    klasor_olustur,
    klasor_sil,
    klasor_sahibi_mi,
    kart_listele,
    kart_ekle,
    kart_sil,
)
import httpx as _httpx
import rq_queue  # Multi-worker job tracking (REDIS_URL set ise aktif, değilse no-op)

load_dotenv()

# ─── Sentry (hata izleme + APM) ─────────────────────────────────────
#
# Üretimde unhandled exception'ları, 5xx'leri ve performans verilerini Sentry'ye
# gönderir. SENTRY_DSN env'i boşsa devre dışı kalır (dev ortamı için).
#
# ENV:
#   SENTRY_DSN                  → https://xxx@oXXXX.ingest.sentry.io/YYYY
#   SENTRY_ENVIRONMENT          → production/staging/dev (default APP_ENV'den)
#   SENTRY_RELEASE              → ör. "lostick-ai@1.2.3" (release tracking için)
#   SENTRY_TRACES_SAMPLE_RATE   → 0.0–1.0 (default 0.0 = APM kapalı)
#   SENTRY_SEND_PII             → "true" ise IP + cookie gönderilir (KVKK için default false)
#
# Custom header'lar (X-User-Api-Key) before_send hook'unda redact edilir.

_SENTRY_SENSITIVE_HEADERS = {
    "authorization", "cookie", "x-user-api-key", "x-api-key",
    "x-session-id",  # tracking ID — leak'i sorun değil ama yine de tem temiz tut
    "set-cookie",
}


def _sentry_before_send(event, hint):
    """Sentry'ye gitmeden önce hassas header'ları ve query param'ları temizle."""
    req = event.get("request") if isinstance(event, dict) else None
    if not isinstance(req, dict):
        return event
    headers = req.get("headers")
    if isinstance(headers, dict):
        for k in list(headers.keys()):
            if k.lower() in _SENTRY_SENSITIVE_HEADERS:
                headers[k] = "[Filtered]"
    # Authorization query string'de gelirse (nadir) onu da temizle
    qs = req.get("query_string")
    if isinstance(qs, str) and ("api_key" in qs.lower() or "token" in qs.lower()):
        req["query_string"] = "[Filtered]"
    return event


_sentry_dsn = (os.getenv("SENTRY_DSN") or "").strip()
if _sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.fastapi import FastApiIntegration

        sentry_sdk.init(
            dsn=_sentry_dsn,
            environment=(
                os.getenv("SENTRY_ENVIRONMENT")
                or os.getenv("APP_ENV")
                or "development"
            ).strip().lower(),
            release=(os.getenv("SENTRY_RELEASE") or "").strip() or None,
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.0") or 0.0),
            # KVKK/GDPR: kullanıcı IP'si ve cookie'ler default olarak gönderilmez
            send_default_pii=(os.getenv("SENTRY_SEND_PII", "").strip().lower() == "true"),
            integrations=[
                StarletteIntegration(),
                FastApiIntegration(),
            ],
            before_send=_sentry_before_send,
            # Aşırı hata fırtınasında Sentry'yi boğmamak için lokal buffer
            max_breadcrumbs=50,
        )
        print(
            f"📊 Sentry aktif — environment="
            f"{(os.getenv('SENTRY_ENVIRONMENT') or os.getenv('APP_ENV') or 'development')}, "
            f"traces_sample_rate={os.getenv('SENTRY_TRACES_SAMPLE_RATE', '0.0')}"
        )
    except ImportError:
        print("⚠️  SENTRY_DSN tanımlı ama sentry-sdk kurulu değil. `pip install sentry-sdk` çalıştırın.")
    except Exception as e:
        print(f"⚠️  Sentry init başarısız: {e}")
else:
    print("📊 Sentry: SENTRY_DSN tanımsız — hata izleme devre dışı (dev için normal).")

app = FastAPI(title="Lostick-ai ile ders API")

# Aynı PDF'i tekrar yükleyen kullanıcılar için FAISS index disk cache'i.
# Hash bazlı dizin altında saklanır; cache hit'te embedding API'sine HİÇ gidilmez
# → Google'ın embedding rate limit'i (free tier: 100/dk) bypass'lanır.
# Serverless (salt-okunur/geçici disk) durumlarında /tmp klasörünü kullan
import tempfile
USE_SERVERLESS_TMP = os.getenv("USE_SERVERLESS_TMP", "false").lower() == "true"
if USE_SERVERLESS_TMP or not os.access(Path(__file__).parent, os.W_OK):
    _cache_root = Path(tempfile.gettempdir()) / "lostick_cache"
else:
    _cache_root = Path(__file__).parent

FAISS_CACHE_DIR = _cache_root / "faiss_cache"
FAISS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Çeviri sonuçları diske yazılır → sunucu yeniden başlasa bile indirilebilir, RAM dolmaz.
CEVIRI_CACHE_DIR = _cache_root / "ceviri_cache"
CEVIRI_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── OOM KORUMASI: Bellek Sınırları & LRU FAISS Önbelleği ────────────
# Bellekteki FAISS index sayısını sınırlar. LRU (Least Recently Used) politikasıyla
# eski ve az kullanılan index'ler otomatik olarak RAM'den atılır.
_MAX_CACHED_FAISS = int(os.getenv("MAX_CACHED_FAISS", "50"))

# Kullanıcı başına toplam karakter sınırı (~250 sayfa A4)
MAX_TOTAL_CHARS = int(os.getenv("MAX_TOTAL_CHARS", "500000"))

# Tek dosya yükleme boyutu sınırı (byte cinsinden, varsayılan 25 MB)
MAX_UPLOAD_SIZE_BYTES = int(os.getenv("MAX_UPLOAD_SIZE_MB", "25")) * 1024 * 1024

# Arka plan job sonuçları bellekte değil diske yazılır → OOM riski düşer
_JOB_RESULT_DIR = _cache_root / "job_results"
_JOB_RESULT_DIR.mkdir(parents=True, exist_ok=True)


class _FAISSLRUCache:
    """Thread-safe LRU önbelleği — FAISS index'lerini bellekte tutar.

    Aynı hash'e sahip dosyalar ortak FAISS nesnesini paylaşır.
    Kapasite aşıldığında en az kullanılan index RAM'den atılır.
    """

    def __init__(self, maxsize: int = 50):
        self._cache: OrderedDict = OrderedDict()  # hash -> FAISS db
        self._lock = threading.Lock()
        self._maxsize = maxsize

    def get(self, file_hash: str):
        """Cache hit → nesneyi döner ve LRU sırasını günceller. Miss → None."""
        with self._lock:
            if file_hash in self._cache:
                self._cache.move_to_end(file_hash)
                return self._cache[file_hash]
            return None

    def put(self, file_hash: str, db) -> None:
        """Yeni FAISS index'i cache'e ekler. Kapasite aşılırsa en eski atılır."""
        with self._lock:
            if file_hash in self._cache:
                self._cache.move_to_end(file_hash)
                return
            self._cache[file_hash] = db
            while len(self._cache) > self._maxsize:
                evicted_hash, evicted_db = self._cache.popitem(last=False)
                del evicted_db
                print(f"--- FAISS LRU: {evicted_hash[:8]}... bellekten atıldı (kapasite: {self._maxsize}) ---")
            gc.collect()

    def remove(self, file_hash: str) -> None:
        """Belirli bir hash'i cache'ten kaldırır."""
        with self._lock:
            db = self._cache.pop(file_hash, None)
            if db is not None:
                del db

    def clear(self) -> None:
        """Tüm cache'i temizler."""
        with self._lock:
            self._cache.clear()
        gc.collect()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._cache)


_faiss_lru = _FAISSLRUCache(maxsize=_MAX_CACHED_FAISS)


# ─── Arka plan test üretim job'ları ──────────────────────────────────
# Test üretimi uzun sürdüğü için arka planda (thread) çalıştırılır. Kullanıcı modalı
# kapatıp gezebilir, F5 atabilir; client job_id'yi localStorage'da tutup polling ile
# durumu sorar. Job'lar sunucu belleğinde tutulur (sunucu restart'ında kaybolur —
# bu kabul edilebilir; F5/sekme kapatma sunucuyu etkilemez).
_test_jobs: dict = {}
_test_jobs_lock = threading.Lock()
# Biten/iptal edilen job'ları ne kadar süre bellekte tutalım (client almaya gelene dek)
_JOB_TTL_SECONDS = 1800  # 30 dk


def _job_set(job_id: str, **fields) -> None:
    with _test_jobs_lock:
        if job_id in _test_jobs:
            _test_jobs[job_id].update(fields)
            # OOM Koruması: Bitmiş job'un büyük sonuçlarını diske taşı, bellekten sil
            if fields.get("status") == "done" and _test_jobs[job_id].get("test"):
                try:
                    result_file = _JOB_RESULT_DIR / f"test_{job_id}.json"
                    result_file.write_text(
                        json.dumps(_test_jobs[job_id]["test"], ensure_ascii=False),
                        encoding="utf-8",
                    )
                    _test_jobs[job_id]["test"] = None  # RAM'den sil
                    _test_jobs[job_id]["_result_on_disk"] = True
                except Exception as e:
                    print(f"--- JOB RESULT DISK WRITE ERROR: {e} ---")


def _job_get(job_id: str) -> Optional[dict]:
    with _test_jobs_lock:
        job = _test_jobs.get(job_id)
        if job is None:
            return None
        result = dict(job)
    # Sonucu diskten oku (bellekte değil)
    if result.get("_result_on_disk") and result.get("test") is None:
        try:
            result_file = _JOB_RESULT_DIR / f"test_{job_id}.json"
            if result_file.exists():
                result["test"] = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"--- JOB RESULT DISK READ ERROR: {e} ---")
    result.pop("_result_on_disk", None)
    return result


def _job_cleanup() -> None:
    """TTL'i geçmiş bitmiş/iptal/hatalı job'ları bellekten ve diskten temizle."""
    now = time.time()
    with _test_jobs_lock:
        silinecek = [
            jid for jid, j in _test_jobs.items()
            if j["status"] in ("done", "error", "cancelled")
            and now - j.get("finished_at", now) > _JOB_TTL_SECONDS
        ]
        for jid in silinecek:
            _test_jobs.pop(jid, None)
            try:
                result_file = _JOB_RESULT_DIR / f"test_{jid}.json"
                if result_file.exists():
                    result_file.unlink()
            except Exception:
                pass


# ─── Arka plan konu anlatımı job'ları ─────────────────────────────────
# Konu anlatımı LLM'den uzun çıktı ürettiği için (uzun modda 30-60sn) test-olustur
# ile aynı pattern uygulanır: thread'de üret, polling ile durumu izle, F5 dayanıklı.
_anlatim_jobs: dict = {}
_anlatim_jobs_lock = threading.Lock()


def _ajob_set(job_id: str, **fields) -> None:
    with _anlatim_jobs_lock:
        if job_id in _anlatim_jobs:
            _anlatim_jobs[job_id].update(fields)
            # OOM Koruması: Bitmiş anlatım sonuçlarını diske taşı
            if fields.get("status") == "done" and _anlatim_jobs[job_id].get("anlatim"):
                try:
                    result_file = _JOB_RESULT_DIR / f"anlatim_{job_id}.txt"
                    result_file.write_text(
                        _anlatim_jobs[job_id]["anlatim"], encoding="utf-8",
                    )
                    _anlatim_jobs[job_id]["anlatim"] = None
                    _anlatim_jobs[job_id]["_result_on_disk"] = True
                except Exception as e:
                    print(f"--- AJOB RESULT DISK WRITE ERROR: {e} ---")


def _ajob_get(job_id: str) -> Optional[dict]:
    with _anlatim_jobs_lock:
        job = _anlatim_jobs.get(job_id)
        if job is None:
            return None
        result = dict(job)
    if result.get("_result_on_disk") and result.get("anlatim") is None:
        try:
            result_file = _JOB_RESULT_DIR / f"anlatim_{job_id}.txt"
            if result_file.exists():
                result["anlatim"] = result_file.read_text(encoding="utf-8")
        except Exception as e:
            print(f"--- AJOB RESULT DISK READ ERROR: {e} ---")
    result.pop("_result_on_disk", None)
    return result


def _ajob_cleanup() -> None:
    now = time.time()
    with _anlatim_jobs_lock:
        silinecek = [
            jid for jid, j in _anlatim_jobs.items()
            if j["status"] in ("done", "error", "cancelled")
            and now - j.get("finished_at", now) > _JOB_TTL_SECONDS
        ]
        for jid in silinecek:
            _anlatim_jobs.pop(jid, None)
            try:
                result_file = _JOB_RESULT_DIR / f"anlatim_{jid}.txt"
                if result_file.exists():
                    result_file.unlink()
            except Exception:
                pass


# ─── Arka plan öğrenme kartı (flashcard) job'ları ─────────────────────
_kart_jobs: dict = {}
_kart_jobs_lock = threading.Lock()


def _kjob_set(job_id: str, **fields) -> None:
    with _kart_jobs_lock:
        if job_id in _kart_jobs:
            _kart_jobs[job_id].update(fields)
            # OOM Koruması: Bitmiş kart sonuçlarını diske taşı
            if fields.get("status") == "done" and _kart_jobs[job_id].get("kartlar"):
                try:
                    result_file = _JOB_RESULT_DIR / f"kart_{job_id}.json"
                    result_file.write_text(
                        json.dumps(_kart_jobs[job_id]["kartlar"], ensure_ascii=False),
                        encoding="utf-8",
                    )
                    _kart_jobs[job_id]["kartlar"] = None
                    _kart_jobs[job_id]["_result_on_disk"] = True
                except Exception as e:
                    print(f"--- KJOB RESULT DISK WRITE ERROR: {e} ---")


def _kjob_get(job_id: str) -> Optional[dict]:
    with _kart_jobs_lock:
        job = _kart_jobs.get(job_id)
        if job is None:
            return None
        result = dict(job)
    if result.get("_result_on_disk") and result.get("kartlar") is None:
        try:
            result_file = _JOB_RESULT_DIR / f"kart_{job_id}.json"
            if result_file.exists():
                result["kartlar"] = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"--- KJOB RESULT DISK READ ERROR: {e} ---")
    result.pop("_result_on_disk", None)
    return result


def _kjob_cleanup() -> None:
    now = time.time()
    with _kart_jobs_lock:
        silinecek = [
            jid for jid, j in _kart_jobs.items()
            if j["status"] in ("done", "error", "cancelled")
            and now - j.get("finished_at", now) > _JOB_TTL_SECONDS
        ]
        for jid in silinecek:
            _kart_jobs.pop(jid, None)
            try:
                result_file = _JOB_RESULT_DIR / f"kart_{jid}.json"
                if result_file.exists():
                    result_file.unlink()
            except Exception:
                pass

# ─── CORS — Üretim-güvenli yapılandırma ─────────────────────────────
#
# GÜVENLİK NOTLARI:
# - `allow_origins=["*"]` + `allow_credentials=True` kombinasyonu **GÜVENSİZDİR**.
#   Tarayıcı spec'i wildcard'la credentials'a izin vermez, ama Starlette bu durumda
#   isteyen origin'i ECHO eder → fiilen herkes credentialed istek atabilir.
# - Bu yüzden her zaman origin listesini AÇIK olarak tanımlıyoruz.
# - Method ve header listeleri de daraltıldı (`*` yerine sadece kullanılanlar).
#
# ENV YAPILANDIRMASI:
#   ALLOWED_ORIGINS         → virgül ayrılmış tam origin listesi
#                             (ör: "https://lostick.ai,https://www.lostick.ai")
#   ALLOWED_ORIGIN_REGEX    → opsiyonel regex (Vercel preview vb. için)
#                             (ör: r"^https://lostick-[a-z0-9-]+\.vercel\.app$")
#   APP_ENV / ENV           → "production" ise ve ALLOWED_ORIGINS tanımlı değilse
#                             FAIL-FAST: sunucu açılmaz (kazara açık CORS riskini önler)

_DEFAULT_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]


def _parse_cors_origins(raw: str) -> list[str]:
    """Virgülle ayrılmış origin listesini güvenli şekilde parse eder.

    - Boşlukları kırpar, boş öğeleri atar
    - Trailing slash'i kaldırır (https://x.com/ → https://x.com — CORS tam eşleşme yapar)
    - '*' wildcard'ı sessizce DROP eder + uyarı yazar (credentials ile uyumsuz)
    """
    out: list[str] = []
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        if item == "*":
            print(
                "⚠️  CORS: ALLOWED_ORIGINS içinde '*' bulundu ve ATILDI. "
                "Credentials ile wildcard güvensizdir; her origin'i açıkça listeleyin."
            )
            continue
        # Trailing slash CORS karşılaştırmasında eşleşmeyi bozar
        out.append(item.rstrip("/"))
    return out


_allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "").strip()
_allowed_origins = _parse_cors_origins(_allowed_origins_raw)
_allowed_origin_regex = (os.getenv("ALLOWED_ORIGIN_REGEX") or "").strip() or None

_app_env = (os.getenv("APP_ENV") or os.getenv("ENV") or "development").strip().lower()
_is_production = _app_env in ("prod", "production")

if _is_production and not _allowed_origins and not _allowed_origin_regex:
    # FAIL-FAST: prod'da CORS env'i unutulduysa sessizce açık-kapı bırakmaktansa hata ver
    raise RuntimeError(
        "❌ CORS: APP_ENV=production ancak ALLOWED_ORIGINS / ALLOWED_ORIGIN_REGEX tanımsız. "
        "Güvenlik gereği sunucu başlatılmıyor. .env'ye şunu ekleyin:\n"
        "   ALLOWED_ORIGINS=https://lostick.ai,https://www.lostick.ai"
    )

if not _allowed_origins and not _allowed_origin_regex:
    # Geliştirme ortamı: localhost Next.js dev server'larına izin ver
    _allowed_origins = list(_DEFAULT_DEV_ORIGINS)
    print(
        f"🔓 CORS (dev mode): ALLOWED_ORIGINS env'i tanımsız → varsayılan dev origin'ler "
        f"kullanılıyor: {_allowed_origins}"
    )
else:
    parts = []
    if _allowed_origins:
        parts.append(f"origins={_allowed_origins}")
    if _allowed_origin_regex:
        parts.append(f"regex={_allowed_origin_regex!r}")
    print(f"🔒 CORS aktif: {' + '.join(parts)}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=_allowed_origin_regex,
    allow_credentials=True,
    # Sadece kullanılan method'lar (önceden "*" idi)
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    # Sadece kullanılan header'lar (önceden "*" idi)
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-User-Api-Key",
        "X-Session-Id",
    ],
    # Preflight cevabını tarayıcı 10 dk cache'lesin (gereksiz OPTIONS azalır)
    max_age=600,
)


# ─── Trusted Proxy IP Resolver (Rate Limit + Audit Logging için) ────
#
# Sorun: `X-Forwarded-For` / `CF-Connecting-IP` header'larına KÖRÜ KÖRÜNE güvenmek
# = IP SPOOFING. Saldırgan `curl -H "X-Forwarded-For: 1.2.3.4"` ile rate limit'i
# bypass'lar ya da başka bir IP'yi banlayabilir.
#
# Çözüm: Sadece TRUSTED_PROXIES env'inde tanımlı IP'lerden gelen istekler için
# header'lara güveniyoruz. Diğerleri için doğrudan socket IP'si kullanılıyor.
#
# ENV:
#   TRUSTED_PROXIES = "10.0.0.0/8,173.245.48.0/20,2400:cb00::/32"
#   Cloudflare arkasındaysanız → CF'in IP listesinden: https://www.cloudflare.com/ips/
#   AWS ALB arkasındaysanız → VPC CIDR'ı
#   Tek host (Nginx aynı makinede) → "127.0.0.1,::1"
#   Boş bırakırsa: hiçbir proxy trust edilmez, sadece socket IP kullanılır.


def _parse_trusted_proxies(raw: str) -> list:
    """CIDR/IP listesini ipaddress.ip_network nesnelerine dönüştürür."""
    nets = []
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            if "/" not in item:
                # Tek IP → /32 (IPv4) ya da /128 (IPv6)
                addr = ipaddress.ip_address(item)
                item = f"{item}/{32 if addr.version == 4 else 128}"
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            print(f"⚠️  TRUSTED_PROXIES: '{item}' parse edilemedi, atlandı.")
    return nets


_TRUSTED_PROXIES = _parse_trusted_proxies(os.getenv("TRUSTED_PROXIES", "").strip())

if _is_production and not _TRUSTED_PROXIES:
    # Prod'da proxy arkasındaysanız (Cloudflare/Nginx/LB) tanımsız bırakmak
    # rate limit'in spoof edilebilir hale gelmesi demek. Loud warning veriyoruz —
    # fail-fast değil çünkü "doğrudan internete açık tek host" da geçerli bir senaryo.
    print(
        "⚠️  TRUSTED_PROXIES tanımsız ama APP_ENV=production. Eğer Cloudflare / Nginx / "
        "yük dengeleyici arkasındaysanız client IP spoof edilebilir → rate limit BYPASS riski. "
        "Proxy'nin IP aralığını TRUSTED_PROXIES env'ine ekleyin."
    )
elif _TRUSTED_PROXIES:
    print(f"🛡️  Trusted proxies: {[str(n) for n in _TRUSTED_PROXIES]}")


def _is_trusted_proxy(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return any(ip in net for net in _TRUSTED_PROXIES)


def resolve_client_ip(request: Request) -> str:
    """
    Gerçek client IP'sini güvenli şekilde çözer.

    - Doğrudan bağlanan IP trusted proxy DEĞİLSE → header'ları YOK SAY, socket IP'sini kullan
    - Trusted proxy ise → CF-Connecting-IP > X-Forwarded-For'un soldan ilki > socket IP

    Bu sayede saldırgan kendi header'ını uydursa bile (proxy'den gelmediği için)
    header'lar görmezden gelinir.
    """
    direct_ip = request.client.host if request.client else None
    if not direct_ip:
        return "unknown"

    if not _is_trusted_proxy(direct_ip):
        # Header'lara güvenme — direkt socket IP'si
        return direct_ip

    # Trusted proxy arkasındayız, header'lar güvenilir
    cf_ip = (request.headers.get("CF-Connecting-IP") or "").strip()
    if cf_ip:
        return cf_ip
    xff = (request.headers.get("X-Forwarded-For") or "").strip()
    if xff:
        # XFF formatı: "client, proxy1, proxy2" — soldan ilki orijinal client
        return xff.split(",")[0].strip()
    return direct_ip

class SoruIstegi(BaseModel):
    soru: str
    gecmis: str = "" # YENİ: Frontend'den gelecek geçmiş sohbet metni

class TestIstegi(BaseModel):
    soru_sayisi: int = 5
    zorluk: str = "Orta"
    sik_sayisi: int = 4  # 3, 4 veya 5 — çoktan seçmeli sorulardaki şık sayısı (D/Y her zaman 2)
    soru_tipi: str = "klasik"  # "klasik" (sadece çoktan seçmeli) | "karma" (ÇS + boşluk doldurma + D/Y)

class AnlatimIstegi(BaseModel):
    konu_basligi: str # Kullanıcının "bana şunu anlat" dediği spesifik yer veya "Genel Özet"
    # Yeni alanlar — eski client çağrıları kırılmasın diye default'larla
    uzunluk: str = "uzun"   # "kisa" | "orta" | "uzun"
    mod: str = "ogretici"   # "ogretici" | "sinav_odakli"

class KartIstegi(BaseModel):
    kart_sayisi: int = 15  # üretilecek interaktif öğrenme kartı sayısı

class KlasorIstegi(BaseModel):
    ad: str  # yeni klasör adı

class KavramEkleIstegi(BaseModel):
    kavram: str  # eklenmek istenen kavram/terim (AI gardiyandan geçer)

class KayitIstegi(BaseModel):
    username: str
    password: str
    email: str  # ARTIK ZORUNLU — doğrulama kodu için gerekli

class GirisIstegi(BaseModel):
    username: str
    password: str

class EmailVerifyIstegi(BaseModel):
    user_id: int
    code: str

class ResendVerificationIstegi(BaseModel):
    user_id: int

class GoogleOAuthIstegi(BaseModel):
    # İki flow desteklenir — birinin dolu olması yeterli:
    #   credential   → Google Identity Services (GIS) ID token (JWT)
    #   access_token → google.accounts.oauth2.initTokenClient'tan gelen access token
    credential: Optional[str] = None
    access_token: Optional[str] = None
    mode: str = "login"  # "login" veya "register"

class GithubOAuthIstegi(BaseModel):
    code: str  # GitHub authorization code — callback URL'inden gelir
    mode: str = "login"  # "login" veya "register"

class ForgotPasswordIstegi(BaseModel):
    email: str

class ResetPasswordIstegi(BaseModel):
    user_id: int
    code: str
    new_password: str

class RefreshTokenIstegi(BaseModel):
    refresh_token: str

# ─── ÇOK KULLANICILI OTURUM İZOLASYONU ───────────────────────────────
# Dosya/retriever durumu ARTIK GLOBAL DEĞİL — her oturuma (kullanıcı veya anonim
# tarayıcı) özeldir. Böylece A kullanıcısının yüklediği dosyaları B göremez.
#
# Oturum anahtarı:
#   - Giriş yapılmışsa  → "user:<id>"        (Authorization: Bearer <token>)
#   - Anonimse          → "anon:<sessionId>" (X-Session-Id header'ı, tarayıcı başına)
#
# Her oturum veritabanında saklanır (user_sessions tablosu).
# Vektör veri tabanları sorgu anında dinamik (on-the-fly) kurulur ve işlem bitince RAM'den temizlenir.

# Sunucuyla gelen ön-yüklü "default" bilgi tabanı — paylaşımlı, salt-okunur fallback
# (chat'te dosya yüklenmemişse kullanılır; kullanıcı yüklemeleri buna karışmaz).
_default_retriever = None


def _session_key(authorization: Optional[str], x_session_id: Optional[str]) -> str:
    """İstekten oturum anahtarını çözer. Giriş varsa user:<id>, yoksa anon:<sid>."""
    token = _extract_token(authorization)
    if token:
        user = get_user_by_token(token)
        if user:
            return f"user:{user['id']}"
    sid = (x_session_id or "").strip()
    if sid:
        return f"anon:{sid}"
    # Eski/başlıksız client — ortak anonim alan (izolasyon yok ama kırılmaz)
    return "anon:_shared_"


def _get_session(key: str) -> dict:
    """Oturum durumunu veri tabanından getirir; yoksa oluşturur."""
    import json
    with get_db() as conn:
        row = conn.execute(
            "SELECT current_pdf_hash, active_files FROM user_sessions WHERE session_key = ?",
            (key,)
        ).fetchone()
        
        if row:
            try:
                active_files = json.loads(row[1])
            except Exception:
                active_files = []
            return {
                "current_pdf_hash": row[0],
                "active_files": active_files,
                "retriever": None
            }
        
        # Yoksa oluştur ve DB'ye yaz
        now = time.time()
        conn.execute(
            "INSERT OR IGNORE INTO user_sessions (session_key, current_pdf_hash, active_files, updated_at) VALUES (?, ?, ?, ?)",
            (key, "default", "[]", now)
        )
        conn.commit()
        return {
            "current_pdf_hash": "default",
            "active_files": [],
            "retriever": None
        }


def _save_session(key: str, session: dict) -> None:
    """Oturum durumunu veri tabanına kaydeder."""
    import json
    now = time.time()
    active_files_json = json.dumps(session.get("active_files", []), ensure_ascii=False)
    current_pdf_hash = session.get("current_pdf_hash", "default")
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_sessions (session_key, current_pdf_hash, active_files, updated_at) VALUES (?, ?, ?, ?)",
            (key, current_pdf_hash, active_files_json, now)
        )
        conn.commit()


def _get_cached_faiss(file_hash: str, embeddings):
    """LRU cache'ten FAISS index'i döner; cache miss'te diskten yükleyip cache'e ekler."""
    db = _faiss_lru.get(file_hash)
    if db is not None:
        return db
    cache_dir = FAISS_CACHE_DIR / file_hash
    if not cache_dir.exists():
        return None
    db = _load_faiss_with_integrity(cache_dir, embeddings)
    if db is not None:
        _faiss_lru.put(file_hash, db)
    return db


def _get_active_retriever(api_key: str, active_files: list):
    """Oturumdaki aktif dökümanlar için on-the-fly (anlık) birleşik FAISS retriever oluşturur.

    LRU cache kullanır — aynı hash'e sahip indeksler bellekten paylaşılır.
    """
    if not active_files:
        return None
    embeddings = _make_embeddings(api_key)
    merged = None
    for f in active_files:
        db = _get_cached_faiss(f["hash"], embeddings)
        if db is None:
            continue
        if merged is None:
            merged = db
        else:
            merged.merge_from(db)
    return merged.as_retriever(search_kwargs={"k": 4}) if merged else None

# Çok dosya limiti
MAX_FILES = 10  # en fazla dosya sayısı (hard limit)

# ─── Helper fonksiyonlar ──────────────────────────────────────────

def _tek_key(api_key: str) -> str:
    """
    Eğer api_key virgüllü bir havuz ise veritabanındaki durumlarına göre (api_key_status)
    en iyi durumdaki (aktif, cooldown'ı bitmiş veya en az cooldown süresi kalmış) anahtarı döner.
    """
    if not api_key:
        return ""
    
    keys = [k.strip() for k in api_key.split(",") if k.strip()]
    if not keys:
        return ""
    if len(keys) == 1:
        return keys[0]
        
    try:
        from kullanim_servisi import get_keys_status
        statuses = get_keys_status(keys)
    except Exception as e:
        print(f"[WARN] _tek_key: get_keys_status error: {e}")
        return keys[0]
        
    # Sınıflandır: aktifler, cooldown'dakiler, limit dolmuşlar, geçersizler
    active_keys = []
    cooldown_keys = []  # tuple of (key, cooldown_until)
    exhausted_keys = []
    
    import time
    now = time.time()
    
    for k in keys:
        stat = statuses.get(k)
        if not stat:
            active_keys.append(k)
            continue
            
        status = stat.get("status", "active")
        cooldown_until = stat.get("cooldown_until", 0.0)
        
        if status == "invalid":
            continue # Geçersiz anahtarları tamamen ele
        elif status == "exhausted":
            exhausted_keys.append(k)
        elif status == "cooldown":
            if cooldown_until <= now:
                active_keys.append(k)
            else:
                cooldown_keys.append((k, cooldown_until))
        else: # active
            active_keys.append(k)
            
    # Seçim önceliği:
    # 1. İlk aktif anahtar
    if active_keys:
        return active_keys[0]
        
    # 2. Cooldown bitişi en yakın olan anahtar
    if cooldown_keys:
        cooldown_keys.sort(key=lambda x: x[1])
        return cooldown_keys[0][0]
        
    # 3. Eğer hepsi exhausted ise, en azından ilk exhausted anahtarı dene (belki günü dolmuştur)
    if exhausted_keys:
        return exhausted_keys[0]
        
    # Fallback
    return keys[0]



def _init_llm_tracking_monkeypatch():
    """
    ChatGoogleGenerativeAI ve ChatVertexAI sınıflarının invoke metotlarını sınıf seviyesinde sarmalar.
    Pydantic __setattr__ engellemesini aşarak tüm model çağrılarında API anahtarı başarısını/hatasını izler.
    """
    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
        orig_invoke = ChatGoogleGenerativeAI.invoke
        
        def tracked_invoke(self, *args, **kwargs):
            key_str = ""
            if hasattr(self, "google_api_key"):
                val = self.google_api_key
                if val:
                    if hasattr(val, "get_secret_value"):
                        key_str = val.get_secret_value()
                    else:
                        key_str = str(val)
            
            try:
                res = orig_invoke(self, *args, **kwargs)
                try:
                    from kullanim_servisi import record_key_success
                    record_key_success(key_str)
                except Exception as ex:
                    print(f"Error tracking key success: {ex}")
                return res
            except Exception as e:
                try:
                    from kullanim_servisi import record_key_failure
                    record_key_failure(key_str, str(e))
                except Exception as ex:
                    print(f"Error tracking key failure: {ex}")
                raise e
                
        ChatGoogleGenerativeAI.invoke = tracked_invoke
        print("[OK] API: ChatGoogleGenerativeAI sinif seviyesinde izleme sarmalayicisi yuklendi.")
    except Exception as e:
        print(f"[WARN] API: ChatGoogleGenerativeAI sarmalayicisi yuklenemedi: {e}")

    try:
        from langchain_google_vertexai import ChatVertexAI
        orig_vertex_invoke = ChatVertexAI.invoke
        
        def tracked_vertex_invoke(self, *args, **kwargs):
            key_str = ""
            if hasattr(self, "project"):
                key_str = f"vertex_project:{self.project}"
                
            try:
                res = orig_vertex_invoke(self, *args, **kwargs)
                try:
                    from kullanim_servisi import record_key_success
                    record_key_success(key_str)
                except Exception as ex:
                    print(f"Error tracking vertex success: {ex}")
                return res
            except Exception as e:
                try:
                    from kullanim_servisi import record_key_failure
                    record_key_failure(key_str, str(e))
                except Exception as ex:
                    print(f"Error tracking vertex failure: {ex}")
                raise e
                
        ChatVertexAI.invoke = tracked_vertex_invoke
        print("[OK] API: ChatVertexAI sinif seviyesinde izleme sarmalayicisi yuklendi.")
    except Exception:
        pass



def _make_llm(
    api_key: str,
    temperature: Optional[float] = None,
    json_mode: bool = False,
    max_output_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    model_name: Optional[str] = None,
):
    """Verilen API key'le veya Vertex AI SDK ile bir Gemini LLM örneği döner.

    `USE_VERTEX_AI=true` ortam değişkeni tanımlanırsa resmi Google Cloud Vertex AI SDK'sına bağlanır.
    Aksi takdirde varsayılan olarak Google AI Studio (ChatGoogleGenerativeAI) kullanır.
    """
    use_vertex = os.getenv("USE_VERTEX_AI", "false").lower() == "true"
    clean_key = _tek_key(api_key)
    
    if use_vertex:
        try:
            from langchain_google_vertexai import ChatVertexAI
            
            kwargs = {
                # Vertex AI model formatı (varsayılan: gemini-1.5-flash)
                "model": model_name or "gemini-1.5-flash",
            }
            if temperature is not None:
                kwargs["temperature"] = temperature
            if max_output_tokens is not None:
                kwargs["max_output_tokens"] = max_output_tokens
            if timeout is not None:
                kwargs["timeout"] = timeout
            if json_mode:
                kwargs["model_kwargs"] = {"response_mime_type": "application/json"}
                
            project_id = os.getenv("VERTEX_PROJECT_ID")
            location = os.getenv("VERTEX_LOCATION", "us-central1")
            if project_id:
                kwargs["project"] = project_id
            kwargs["location"] = location
            
            return ChatVertexAI(**kwargs)
        except ImportError:
            print("⚠️  langchain_google_vertexai kütüphanesi yüklü değil! Standart ChatGoogleGenerativeAI modeline geri dönülüyor.")

    kwargs = dict(
        model=model_name or "gemini-3.5-flash",
        google_api_key=clean_key,
        transport="rest",
    )
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_output_tokens is not None:
        kwargs["max_output_tokens"] = max_output_tokens
    if timeout is not None:
        kwargs["timeout"] = timeout
    if json_mode:
        kwargs["model_kwargs"] = {"response_mime_type": "application/json"}
    return ChatGoogleGenerativeAI(**kwargs)



# ─── Global, API-key-başına hız sınırlayıcı (429 koruması) ───────────
# Ücretsiz sunucu anahtarı tüm kullanıcılar arasında PAYLAŞIMLI olduğundan, eşzamanlı
# istekler 15 RPM'i aşıp 429 yiyebilir. Bu kapı, AYNI anahtara giden TÜM Gemini
# çağrılarının başlangıçlarını min aralıkla aralar → kaç kullanıcı olursa olsun RPM aşılmaz.
# BYOK kullanıcıları kendi anahtarlarıyla ayrı kapıdan geçer, birbirlerini etkilemez.
_RATE_MIN_INTERVAL = 4.5  # saniye (≈13 istek/dk < 15 RPM)
_rate_locks: dict = {}
_rate_last: dict = {}
_rate_meta_lock = threading.Lock()


def _rate_gate(api_key: str, using_user_key: bool = False) -> None:
    """Verilen API anahtarı için çağrılar arası minimum aralığı zorlar (thread-safe, global)."""
    if not api_key:
        return
    # Çoklu veya tekil anahtar ayrımı
    clean_key = _tek_key(api_key)
    # BYOK kullanıcıları veya kendi API anahtarına sahip olanlar için hız sınırını 0.2 saniyeye düşürerek
    # inanılmaz derecede hızlı paralel çeviri yapılması sağlanır.
    min_interval = 0.2 if using_user_key else _RATE_MIN_INTERVAL
    with _rate_meta_lock:
        lk = _rate_locks.get(clean_key)
        if lk is None:
            lk = threading.Lock()
            _rate_locks[clean_key] = lk
    with lk:
        bekle = min_interval - (time.time() - _rate_last.get(clean_key, 0.0))
        if bekle > 0:
            time.sleep(bekle)
        _rate_last[clean_key] = time.time()


# ─── API Anahtarı Havuzu ve Akıllı Rotasyon Mimarisi (API Key Pooling & Rotation) ───
import hashlib

class APIKeyPool:
    def __init__(self):
        self.lock = threading.Lock()
        self.keys = []
        self.cooldowns = {}  # key -> float (cooldown bitiş zamanı)
        self.index = 0
        self.load_keys()

    def load_keys(self):
        # Env dosyasından virgülle ayrılmış anahtarları yükler
        keys_env = os.getenv("GEMINI_API_KEYS")
        if keys_env:
            self.keys = [k.strip() for k in keys_env.split(",") if k.strip()]
        
        # Eğer havuzda hiç anahtar yoksa GOOGLE_API_KEY'e düşer
        if not self.keys:
            single_key = os.getenv("GOOGLE_API_KEY")
            if single_key:
                self.keys = [single_key.strip()]
                
        print(f"--- APIKeyPool: {len(self.keys)} adet API anahtarı başarıyla yüklendi. ---")

    def get_key(self) -> str:
        """Havuzdan soğuma modunda olmayan sıradaki API anahtarını döner.
        Eğer tüm anahtarlar soğuma modundaysa, soğuma süresi en erken bitecek anahtarı bekler.
        """
        with self.lock:
            if not self.keys:
                # Havuzda hiç anahtar yoksa, GOOGLE_API_KEY'e tekrar bak
                single_key = os.getenv("GOOGLE_API_KEY")
                if single_key:
                    self.keys = [single_key.strip()]
                else:
                    raise RuntimeError("API anahtarı havuzunda (GEMINI_API_KEYS / GOOGLE_API_KEY) hiçbir anahtar bulunamadı.")
                
            now = time.time()
            for _ in range(len(self.keys)):
                key = self.keys[self.index]
                self.index = (self.index + 1) % len(self.keys)
                
                cooldown_until = self.cooldowns.get(key, 0.0)
                if now >= cooldown_until:
                    return key
                    
            # Hepsi soğuma modunda ise en kısa süreli olanı bulup bekle
            shortest_key = min(self.keys, key=lambda k: self.cooldowns.get(k, 0.0))
            wait_time = self.cooldowns[shortest_key] - now
            if wait_time > 0:
                print(f"--- APIKeyPool: Tüm anahtarlar soğumada! {wait_time:.1f}sn bekleme yapılıyor... ---")
                time.sleep(wait_time)
            return shortest_key

    def set_cooldown(self, key: str, duration: float = 60.0):
        """Hata alan bir anahtarı belirli bir süre (varsayılan 60sn) boyunca soğumaya alır."""
        with self.lock:
            if key in self.keys:
                self.cooldowns[key] = time.time() + duration
                print(f"--- APIKeyPool: Anahtar ({key[:8]}...) {duration} saniye boyunca soğumaya alındı. ---")


_api_key_pool = APIKeyPool()


# ─── Akıllı Çeviri Önbelleği (Chunk-Level Translation Cache) ─────────────────
def _get_translation_from_cache(text: str, target_lang: str = "tr", glossary: str = "") -> Optional[str]:
    """Metin bloğunun çevirisi disk önbelleğinde varsa anında döner."""
    try:
        clean_text = text.strip()
        if not clean_text:
            return ""
        # MD5 Hash üret (text + hedef dil + sözlük birleşimiyle tam tutarlılık sağla, çakışmayı önle)
        h = hashlib.md5((clean_text + target_lang + glossary).encode("utf-8")).hexdigest()
        cache_file = CEVIRI_CACHE_DIR / "chunks" / f"{h}.txt"
        if cache_file.exists():
            content = cache_file.read_text(encoding="utf-8")
            if content.strip():
                return content.strip()
    except Exception as e:
        print(f"--- Çeviri Önbellek Okuma Hatası: {e} ---")
    return None


def _save_translation_to_cache(text: str, translation: str, target_lang: str = "tr", glossary: str = "") -> None:
    """Metin bloğunun çevirisini disk önbelleğine kaydeder."""
    try:
        clean_text = text.strip()
        clean_tr = translation.strip()
        if not clean_text or not clean_tr:
            return
        
        chunks_dir = CEVIRI_CACHE_DIR / "chunks"
        chunks_dir.mkdir(exist_ok=True)
        
        h = hashlib.md5((clean_text + target_lang + glossary).encode("utf-8")).hexdigest()
        cache_file = chunks_dir / f"{h}.txt"
        cache_file.write_text(clean_tr, encoding="utf-8")
    except Exception as e:
        print(f"--- Çeviri Önbellek Yazma Hatası: {e} ---")


def _extract_text(content) -> str:
    """ChatGoogleGenerativeAI `.content`'ı string veya content-block listesi olabilir.

    Yeni Gemini sürümleri (3.x+, "signed thinking" özelliği) `.content`'ı şu formatta
    döner: [{'type': 'text', 'text': '...', 'extras': {'signature': '...'}}, ...]
    Eski sürümler düz string dönüyordu. Bu helper iki formatı da düz string'e çevirir.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if "text" in block:
                    parts.append(block["text"])
                elif "content" in block:
                    parts.append(str(block["content"]))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content)


def _parse_json_array(ham_cevap) -> list:
    """LLM çıktısından JSON array çıkarır — toleranslı parser.

    Sırasıyla şunları dener:
      1) Düz json.loads (JSON mode açıkken bu hemen geçer)
      2) Markdown fence temizleyip parse
      3) İlk '[' ile son ']' arasını alıp parse
      4) Trailing comma temizleyip parse
      5) Son bozuk objesini atıp (']' ile kapatarak) parse — kısmi kurtarma

    Hiçbiri çalışmazsa son istisnayı fırlatır.
    """
    # Önce content'i düz string'e çevir (list-of-blocks formatını desteklemek için)
    ham_cevap = _extract_text(ham_cevap)
    son_hata: Optional[Exception] = None

    # 1) Direkt parse
    try:
        sonuc = json.loads(ham_cevap)
        if isinstance(sonuc, list):
            return sonuc
    except Exception as e:
        son_hata = e

    # 2) Markdown fence + whitespace temizle
    temiz = ham_cevap.replace("```json", "").replace("```", "").strip()
    try:
        sonuc = json.loads(temiz)
        if isinstance(sonuc, list):
            return sonuc
    except Exception as e:
        son_hata = e

    # 3) İlk '[' - son ']' arası
    start_idx = temiz.find('[')
    end_idx = temiz.rfind(']')
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        kesilmis = temiz[start_idx:end_idx + 1]
        try:
            sonuc = json.loads(kesilmis)
            if isinstance(sonuc, list):
                return sonuc
        except Exception as e:
            son_hata = e

        # 4) Trailing comma temizle (}, ] veya ,] gibi yaygın hatalar)
        trailing_comma_temiz = re.sub(r',(\s*[\]}])', r'\1', kesilmis)
        try:
            sonuc = json.loads(trailing_comma_temiz)
            if isinstance(sonuc, list):
                return sonuc
        except Exception as e:
            son_hata = e

        # 5) Son bozuk objesini atıp kurtar: son tam '}' karakterine kadar al, sonra ']' ekle
        son_obje_sonu = kesilmis.rfind('}')
        if son_obje_sonu > start_idx:
            kurtarma = kesilmis[:son_obje_sonu + 1] + ']'
            kurtarma = re.sub(r',(\s*[\]}])', r'\1', kurtarma)
            try:
                sonuc = json.loads(kurtarma)
                if isinstance(sonuc, list) and len(sonuc) > 0:
                    return sonuc
            except Exception as e:
                son_hata = e

    if son_hata:
        raise son_hata
    raise ValueError("JSON array bulunamadı")


_embeddings_cache = None

def _make_embeddings(api_key: Optional[str] = None) -> FastEmbedEmbeddings:
    """Local multilingual embedding modeli (paraphrase-multilingual-MiniLM-L12-v2).

    fastembed (ONNX runtime) üzerinden çalışır — torch GEREKMEZ, Gemini API'sine GİTMEZ.
    İlk çağrıda ~470 MB model fastembed cache'ine iner, sonraki çağrılarda anlık.
    50+ dil destekler (Türkçe dahil), embedding boyutu 384.

    `api_key` parametresi backward-compat için tutuluyor, kullanılmıyor.
    """
    global _embeddings_cache
    if _embeddings_cache is None:
        _embeddings_cache = FastEmbedEmbeddings(
            model_name="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        )
    return _embeddings_cache


# ─── Çok formatlı dosya metin çıkarma ────────────────────────────────
# PDF haricindeki tipler de aynı pipeline'a (chunk → embed → FAISS) beslensin diye
# hepsinden düz metin çıkarıp langchain Document listesine sarıyoruz.
_CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
    ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift", ".sql", ".sh", ".bat",
    ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".md", ".r", ".scala",
    ".pl", ".lua", ".dart", ".vue", ".json",
}
_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg"
}


def _extract_docx(path: str) -> str:
    import docx  # python-docx
    d = docx.Document(path)
    parts = [p.text for p in d.paragraphs if p.text.strip()]
    for table in d.tables:
        for row in table.rows:
            hucreler = [c.text.strip() for c in row.cells if c.text.strip()]
            if hucreler:
                parts.append(" | ".join(hucreler))
    return "\n".join(parts)


def _extract_pptx(path: str) -> str:
    from pptx import Presentation
    prs = Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f"--- Slayt {i} ---")
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    txt = "".join(run.text for run in para.runs).strip()
                    if txt:
                        parts.append(txt)
            if shape.has_table:
                for row in shape.table.rows:
                    hucreler = [c.text.strip() for c in row.cells if c.text.strip()]
                    if hucreler:
                        parts.append(" | ".join(hucreler))
    return "\n".join(parts)


def _extract_xlsx(temp_path: str) -> str:
    import zipfile
    import xml.etree.ElementTree as ET
    try:
        with zipfile.ZipFile(temp_path, 'r') as z:
            shared_strings = []
            if "xl/sharedStrings.xml" in z.namelist():
                xml_content = z.read("xl/sharedStrings.xml")
                root = ET.fromstring(xml_content)
                for t in root.iter():
                    if t.tag.endswith('}t') or t.tag == 't':
                        shared_strings.append(t.text or "")
            sheets_data = []
            sheet_nums = [f for f in z.namelist() if f.startswith("xl/worksheets/sheet")]
            for sheet_file in sorted(sheet_nums):
                xml_content = z.read(sheet_file)
                root = ET.fromstring(xml_content)
                rows_text = []
                for row in root.iter():
                    if row.tag.endswith('}row') or row.tag == 'row':
                        cells = []
                        for c in row.iter():
                            if c.tag.endswith('}c') or c.tag == 'c':
                                t_type = c.get('t')
                                v_val = ""
                                for v in c.iter():
                                    if v.tag.endswith('}v') or v.tag == 'v':
                                        v_val = v.text or ""
                                if t_type == 's' and v_val.isdigit():
                                    idx = int(v_val)
                                    if 0 <= idx < len(shared_strings):
                                        cells.append(shared_strings[idx])
                                    else:
                                        cells.append("")
                                elif t_type == 'inlineStr':
                                    inline_parts = []
                                    for t in c.iter():
                                        if t.tag.endswith('}t') or t.tag == 't':
                                            if t.text:
                                                inline_parts.append(t.text)
                                    cells.append("".join(inline_parts))
                                else:
                                    cells.append(v_val)
                        if any(cells):
                            rows_text.append(" | ".join(cells))
                if rows_text:
                    sheets_data.append("\n".join(rows_text))
            return "\n".join(sheets_data)
    except Exception as e:
        print(f"--- Excel Okuma Hatası: {e} ---")
        return ""


def _extract_odt(temp_path: str) -> str:
    import zipfile
    import xml.etree.ElementTree as ET
    try:
        with zipfile.ZipFile(temp_path, 'r') as z:
            if "content.xml" in z.namelist():
                xml_content = z.read("content.xml")
                root = ET.fromstring(xml_content)
                paragraphs = []
                for elem in root.iter():
                    if elem.tag.endswith('}p') or elem.tag == 'p':
                        text = "".join(elem.itertext()).strip()
                        if text:
                            paragraphs.append(text)
                return "\n".join(paragraphs)
    except Exception:
        pass
    return ""


def _extract_epub(temp_path: str) -> str:
    """EPUB e-kitaptan metin çıkarır — CSS/JS gürültüsü temizlenir."""
    import zipfile
    import re
    import html
    try:
        with zipfile.ZipFile(temp_path, 'r') as z:
            html_files = [f for f in z.namelist() if f.endswith((".html", ".xhtml", ".htm"))]
            text_parts = []
            for hf in sorted(html_files):
                content = z.read(hf).decode("utf-8", errors="replace")
                # Önce <style> ve <script> bloklarını içerikleriyle birlikte sil
                # (tag stripping bunların içini bırakır: "body { font: 12px }" gibi)
                content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL | re.IGNORECASE)
                content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r'<[^>]+>', '', content)
                text = html.unescape(text)
                if text.strip():
                    text_parts.append(text.strip())
            return "\n\n".join(text_parts)
    except Exception:
        pass
    return ""


def _extract_rtf(file_bytes: bytes) -> str:
    """RTF dosyasından düz metin çıkarır — Unicode ve Türkçe karakter desteğiyle.

    Eski parser Türkçe karakterleri (\\u351? → ş gibi) kaybediyordu çünkü
    \\uN kaçışını sayıya dönüştürmeden siliyordu. Yeni parser:
      1) \\uN Unicode kaçışlarını gerçek karakterlere dönüştürür
      2) \\'XX hex kaçışlarını Windows-1254 (Türkçe) code page ile çözer
      3) \\par/\\line kontrol kelimelerini newline'a dönüştürür
      4) İç içe (nested) süslü parantez gruplarını iteratif olarak temizler
    """
    import re
    text = file_bytes.decode("utf-8", errors="replace")

    # 1) \uN Unicode kaçışlarını gerçek karakterlere dönüştür
    # Örn: \u351? → ş (U+015F), \u252? → ü (U+00FC)
    # N'den sonraki tek karakter ANSI fallback'tir ve silinir.
    def _uc(m):
        try:
            cp = int(m.group(1))
            if cp < 0:
                cp += 65536  # RTF işaretli 16-bit tam sayı kullanır
            return chr(cp)
        except (ValueError, OverflowError):
            return ""
    text = re.sub(r'\\u(-?\d+)\s?.?', _uc, text)

    # 2) \'XX hex kaçışlarını Türkçe code page (Windows-1254) ile çöz
    # Örn: \'fe → ş, \'f0 → ğ, \'dd → İ
    def _hx(m):
        try:
            return bytes([int(m.group(1), 16)]).decode("cp1254", errors="replace")
        except (ValueError, OverflowError):
            return ""
    text = re.sub(r"\\'([0-9a-fA-F]{2})", _hx, text)

    # 3) Paragraf/satır sonu kontrol kelimelerini newline'a dönüştür
    text = re.sub(r'\\par\b\s*', '\n', text)
    text = re.sub(r'\\line\b\s*', '\n', text)
    text = re.sub(r'\\tab\b\s*', '\t', text)

    # 4) Kalan RTF kontrol kelimelerini temizle
    text = re.sub(r'\\([a-z]{1,32})(-?\d+)? ?', '', text)

    # 5) İç içe süslü parantez gruplarını iteratif temizle (gömülü resim verileri dahil)
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r'\{[^{}]*\}', '', text)

    # 6) Son kalan süslü parantezleri ve ters eğik çizgileri temizle
    text = text.replace('{', '').replace('}', '').replace('\\', '')
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


def _extract_binary_strings(data: bytes) -> str:
    import re
    pattern = re.compile(rb'[\x20-\x7E\xA0-\xFF]{4,}')
    words = []
    for match in pattern.finditer(data):
        try:
            word = match.group(0).decode("utf-8", errors="ignore").strip()
            if word:
                words.append(word)
        except Exception:
            pass
    return "\n".join(words)


_OLD_OFFICE_EXTENSIONS = {".doc", ".ppt", ".xls"}


def _extract_old_office_text(data: bytes) -> str:
    """Eski ikili Office formatlarından (.doc, .ppt, .xls) UTF-16LE kodlu metni çıkarır.

    Bu formatlar OLE2 Compound Binary yapısındadır. Slayt metinleri, paragraflar
    ve hücre değerleri genellikle UTF-16LE kodlamasıyla saklanır.

    Mevcut _extract_binary_strings yalnızca tek-byte ASCII dizilerini aradığı için
    gömülü görsellerin format başlıklarını (JFIF, 8BIM, TIFF, EXIF vb.) yakalar
    ama asıl Türkçe slayt metnini (UTF-16LE) göremez. Bu fonksiyon 2-byte
    UTF-16LE karakter dizilerini tarayarak dosyanın gerçek metin içeriğini
    çıkarır ve OLE yapısal meta verilerini / görsel başlıklarını filtreler.
    """
    parts: list = []
    n = len(data)
    i = 0
    current: list = []

    while i < n - 1:
        lo, hi = data[i], data[i + 1]
        cp = lo | (hi << 8)
        # Yazdırılabilir Unicode aralığı:
        # U+0009 (tab), U+000A (LF), U+000D (CR)
        # U+0020..U+024F (Basic Latin + Latin-1 Supp + Latin Extended-A/B)
        # Bu aralık Türkçe karakterleri (ğ,ş,ı,ö,ü,ç,İ,Ğ,Ş) kapsar.
        if (0x0020 <= cp <= 0x024F) or cp in (0x0009, 0x000A, 0x000D):
            current.append(chr(cp))
            i += 2
        else:
            if len(current) >= 5:
                text = "".join(current).strip()
                if text and any(c.isalpha() for c in text):
                    parts.append(text)
            current = []
            i += 1  # 1 byte ilerle — byte hizalama kaymasını tolere et

    # Son kalan bloğu ekle
    if len(current) >= 5:
        text = "".join(current).strip()
        if text and any(c.isalpha() for c in text):
            parts.append(text)

    # ── Gürültü filtreleme ──
    # OLE yapısal meta verileri, gömülü görsel format başlıkları, font adları.
    # Bunlar asıl belge içeriği değildir ve yapay zekayı yanıltır.
    _NOISE_LOWER = {
        "jfif", "tiff", "exif", "8bim", "jpeg", "png", "gif", "bmp", "rgb",
        "cmyk", "adobe", "photoshop", "arial", "times new roman", "calibri",
        "root entry", "current user", "summary information", "power point",
        "powerpoint", "document summary information", "microsoft office",
        "theme manager", "default design", "click to edit",
    }

    filtered = []
    for p in parts:
        p_stripped = p.strip()
        if not p_stripped:
            continue
        if p_stripped.lower() in _NOISE_LOWER:
            continue
        # Çoğunluğu özel karakter olan satırları atla (ikili artık / gürültü)
        alpha_count = sum(1 for c in p_stripped if c.isalpha() or c.isspace())
        if alpha_count < len(p_stripped) * 0.4:
            continue
        filtered.append(p_stripped)

    return "\n".join(filtered)


def _extract_ipynb(file_bytes: bytes) -> str:
    nb = json.loads(file_bytes.decode("utf-8", errors="replace"))
    parts = []
    for cell in nb.get("cells", []):
        src = cell.get("source", [])
        if isinstance(src, list):
            src = "".join(src)
        if not src.strip():
            continue
        if cell.get("cell_type") == "code":
            parts.append(f"```\n{src}\n```")
        else:
            parts.append(src)
    return "\n\n".join(parts)


def _extract_image_ocr(file_bytes: bytes, ext: str, api_key: str) -> str:
    """Görselden metni Gemini Vision ile çıkarır (tahta fotosu, taranmış not, el yazısı)."""
    b64 = base64.b64encode(file_bytes).decode("ascii")
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else f"image/{ext.lstrip('.')}"
    llm = _make_llm(api_key)  # gemini-3.5-flash — vision destekli
    msg = HumanMessage(content=[
        {
            "type": "text",
            "text": (
                "Bu görseldeki TÜM metni, notları, formülleri, diyagram etiketlerini ve "
                "içeriği eksiksiz çıkar. Tahta yazısı, el yazısı veya taranmış ders notu olabilir. "
                "Sadece çıkardığın içeriği döndür — yorum, başlık veya açıklama EKLEME."
            ),
        },
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ])
    _rate_gate(api_key)
    return _extract_text(llm.invoke([msg]).content)


def _smart_decode(file_bytes: bytes) -> str:
    """Metin dosyalarını akıllı kodlama tespitiyle çözümler (UTF-8 -> Windows-1254 -> Latin-1)."""
    # 1) UTF-8 dene (en yaygın ve modern varsayılan)
    try:
        return file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        pass
        
    # 2) Windows-1254 dene (Türkçe Windows Excel/Text vb.)
    try:
        return file_bytes.decode("cp1254")
    except UnicodeDecodeError:
        pass
        
    # 3) ISO-8859-9 dene (Türkçe ISO)
    try:
        return file_bytes.decode("iso-8859-9")
    except UnicodeDecodeError:
        pass
        
    # 4) Latin-1 dene (asla hata vermez ama en son çare)
    return file_bytes.decode("latin-1", errors="replace")


def _extract_pdf(temp_path: str, file_bytes: bytes, api_key: str) -> list:
    """PDF'ten metin çıkarır. Eğer PDF taranmış/görsel tabanlı ise (metin bulunamazsa)
    her sayfayı görsele çevirip Gemini Vision ile OCR fallback yapar.
    """
    import fitz
    from langchain_community.document_loaders import PyPDFLoader
    
    # 1) Normal metin çıkarma dene
    try:
        docs = PyPDFLoader(temp_path).load()
    except Exception as e:
        docs = []
        print(f"--- PyPDFLoader hatası: {e}, OCR'a geçiliyor ---")
        
    # Toplam metin uzunluğunu ve sayfa sayısını kontrol et
    total_chars = sum(len(d.page_content.strip()) for d in docs if hasattr(d, "page_content"))
    
    # Eğer hiç doküman yoksa veya sayfa başına ortalama metin çok azsa (< 40 karakter)
    # veya toplam metin çok kısaysa (< 100 karakter) OCR fallback yap
    is_scanned = False
    if not docs:
        is_scanned = True
    else:
        avg_chars = total_chars / len(docs)
        if avg_chars < 40 or total_chars < 100:
            is_scanned = True
            
    if is_scanned:
        print(f"--- Taranmış PDF tespit edildi (Toplam karakter: {total_chars}). Gemini Vision ile OCR yapılıyor... ---")
        ocr_docs = []
        try:
            doc = fitz.open(stream=file_bytes, filetype="pdf")
            for p in range(doc.page_count):
                page = doc.load_page(p)
                pix = page.get_pixmap(dpi=150)
                ocr_text = _extract_image_ocr(pix.tobytes("png"), ".png", api_key)
                if ocr_text and ocr_text.strip():
                    ocr_docs.append(Document(page_content=ocr_text.strip(), metadata={"source": temp_path, "page": p}))
                else:
                    ocr_docs.append(Document(page_content="", metadata={"source": temp_path, "page": p}))
            doc.close()
            if ocr_docs and any(d.page_content.strip() for d in ocr_docs):
                return ocr_docs
        except Exception as e:
            print(f"--- PDF OCR Fallback hatası: {e} ---")
            
    return docs


def _extract_documents(temp_path: str, filename: str, file_bytes: bytes, api_key: str) -> list:
    """Dosya tipine göre metni çıkarıp langchain Document listesi döner.

    PDF için sayfa-bazlı PyPDFLoader ve OCR fallback; diğerleri tek Document'a sarılır.
    Sonraki adımlar (chunk → embed → FAISS) tip-bağımsız çalıştığı için tüm tipler aynı yoldan ilerler.
    """
    ext = os.path.splitext(filename)[1].lower()

    docs = []
    if ext == ".pdf":
        docs = _extract_pdf(temp_path, file_bytes, api_key)
    elif ext in (".docx", ".docm", ".dotx"):
        docs = [Document(page_content=_extract_docx(temp_path))]
    elif ext in (".pptx", ".pptm", ".potx", ".ppsx"):
        docs = [Document(page_content=_extract_pptx(temp_path))]
    elif ext == ".ipynb":
        docs = [Document(page_content=_extract_ipynb(file_bytes))]
    elif ext in _IMAGE_EXTENSIONS:
        docs = [Document(page_content=_extract_image_ocr(file_bytes, ext, api_key))]
    elif ext in (".xlsx", ".xlsm", ".xltx"):
        docs = [Document(page_content=_extract_xlsx(temp_path))]
    elif ext == ".odt":
        docs = [Document(page_content=_extract_odt(temp_path))]
    elif ext == ".epub":
        docs = [Document(page_content=_extract_epub(temp_path))]
    elif ext == ".rtf":
        docs = [Document(page_content=_extract_rtf(file_bytes))]
    elif ext in (".csv", ".tsv"):
        docs = [Document(page_content=_smart_decode(file_bytes))]
    elif ext in (".ods", ".odp"):
        metin = _extract_odt(temp_path)
        docs = [Document(page_content=metin)] if metin.strip() else []
    elif ext == ".txt" or ext == ".md" or ext in _CODE_EXTENSIONS:
        docs = [Document(page_content=_smart_decode(file_bytes))]
    elif ext in _OLD_OFFICE_EXTENSIONS:
        metin = _extract_old_office_text(file_bytes)
        docs = [Document(page_content=metin)] if metin.strip() else []
    else:
        metin = _extract_binary_strings(file_bytes)
        if not metin.strip():
            metin = _smart_decode(file_bytes)
        docs = [Document(page_content=metin)] if metin.strip() else []

    if not docs:
        raise HTTPException(status_code=400, detail=f"Desteklenmeyen veya boş dosya tipi: {ext or '(uzantısız)'}")

    # Her dökümanın metadatasındaki source alanını gerçek dosya ismiyle güncelle
    for d in docs:
        d.metadata["source"] = filename

    return docs


# ─── Çok dosyalı bilgi tabanı (merge) ────────────────────────────────

def _gecici_dosya(file_bytes: bytes, filename: str) -> str:
    """file_bytes'ı İŞLETİM SİSTEMİ geçici klasörüne yazar, yolu döner.

    Proje klasörüne ASLA yazmaz — böylece backend `uvicorn --reload` ile çalışırken
    geçici dosyalar dosya izleyiciyi tetikleyip sunucuyu yeniden başlatmaz (reload fırtınası).
    """
    suffix = os.path.splitext(filename)[1] or ".bin"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="lostick_")
    with os.fdopen(fd, "wb") as f:
        f.write(file_bytes)
    return path


def _get_faiss_integrity_key() -> bytes:
    # Google API Key veya sistemdeki mevcut anahtarlardan güvenli ve sabit bir bütünlük anahtarı türet
    key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEYS", "lostick_secure_default_faiss_key")
    return hashlib.sha256(key.encode("utf-8")).digest()


def _save_faiss_with_integrity(db, cache_dir: Path) -> None:
    # 1) FAISS save_local yap
    db.save_local(str(cache_dir))
    
    # 2) Dosyaların içeriğini oku ve HMAC-SHA256 hesapla
    import hmac
    h = hmac.new(_get_faiss_integrity_key(), digestmod=hashlib.sha256)
    
    faiss_path = cache_dir / "index.faiss"
    pkl_path = cache_dir / "index.pkl"
    
    if faiss_path.exists() and pkl_path.exists():
        h.update(faiss_path.read_bytes())
        h.update(pkl_path.read_bytes())
        signature = h.hexdigest()
        
        # 3) Bütünlük dosyasını kaydet
        integrity_path = cache_dir / "integrity.sha256"
        integrity_path.write_text(signature, encoding="utf-8")
        
        # Obje depolama (S3) ile senkronize et
        try:
            from storage_servisi import sync_faiss_to_s3
            sync_faiss_to_s3(cache_dir, cache_dir.name)
        except Exception as e:
            print(f"⚠️ S3 FAISS Senkronizasyon Hatası: {e}")


def _load_faiss_with_integrity(cache_dir: Path, embeddings) -> Optional[FAISS]:
    faiss_path = cache_dir / "index.faiss"
    pkl_path = cache_dir / "index.pkl"
    integrity_path = cache_dir / "integrity.sha256"
    
    if not (faiss_path.exists() and pkl_path.exists() and integrity_path.exists()):
        try:
            from storage_servisi import sync_faiss_from_s3
            sync_faiss_from_s3(cache_dir, cache_dir.name)
        except Exception as e:
            print(f"⚠️ S3 FAISS Geri Yükleme Hatası: {e}")

    if not (faiss_path.exists() and pkl_path.exists()):
        return None
        
    # Bütünlük kontrolü
    if not integrity_path.exists():
        print(f"⚠️  FAISS Güvenlik Riski: {cache_dir.name} dizininde bütünlük imzası (integrity.sha256) bulunamadı! Yükleme reddedildi.")
        return None
        
    import hmac
    h = hmac.new(_get_faiss_integrity_key(), digestmod=hashlib.sha256)
    h.update(faiss_path.read_bytes())
    h.update(pkl_path.read_bytes())
    expected_signature = h.hexdigest()
    
    actual_signature = integrity_path.read_text(encoding="utf-8").strip()
    
    if not hmac.compare_digest(expected_signature, actual_signature):
        print(f"❌ FAISS Bütünlük Hatası: {cache_dir.name} dizinindeki vektör dosyaları manipüle edilmiş veya imza uyuşmuyor! Yükleme engellendi.")
        return None
        
    # Her şey yolunda, güvenle deserialize edebiliriz
    return FAISS.load_local(str(cache_dir), embeddings, allow_dangerous_deserialization=True)


def _ensure_file_cached(file_bytes: bytes, filename: str, file_hash: str, api_key: str) -> int:
    """Dosyanın FAISS index'ini disk cache'ine yazar (yoksa üretir). Karakter sayısını döner.

    Cache hit'te embedding hiç yapılmaz — sadece yüklenip char sayısı hesaplanır.
    """
    cache_dir = FAISS_CACHE_DIR / file_hash
    embeddings = _make_embeddings(api_key)
    db = _get_cached_faiss(file_hash, embeddings)
    
    if db is None:
        temp_dosya = _gecici_dosya(file_bytes, filename)
        try:
            dokumanlar = _extract_documents(temp_dosya, filename, file_bytes, api_key)
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
            parcalar = text_splitter.split_documents(dokumanlar)
            if not parcalar:
                raise HTTPException(status_code=400, detail="Dosyadan metin çıkarılamadı (boş veya okunamayan içerik).")
            db = FAISS.from_documents(parcalar, embeddings)
        finally:
            if os.path.exists(temp_dosya):
                os.remove(temp_dosya)
        _save_faiss_with_integrity(db, cache_dir)
        _faiss_lru.put(file_hash, db)  # Yeni üretilen index'i LRU cache'e ekle
    char_count = sum(len(d.page_content) for d in db.docstore._dict.values())
    return char_count


def _aktif_dosya_tam_metni(api_key: str, session: dict) -> str:
    """Oturumdaki aktif dosyaların TAM metnini birleştirip döner (konu anlatımı için).

    Konu anlatımı 'tüm konulara değin' gerektirdiğinden k=4 retriever yetersiz kalır;
    bunun yerine belgenin tamamını bağlam olarak veririz (test üretimiyle aynı yaklaşım).
    LRU cache kullanır — disk I/O tekrarını önler.
    """
    embeddings = _make_embeddings(api_key)
    parcalar = []
    for f in session["active_files"]:
        db = _get_cached_faiss(f["hash"], embeddings)
        if db is None:
            continue
        metin = "\n\n".join(d.page_content for d in db.docstore._dict.values())
        if metin.strip():
            parcalar.append(f"### Dosya: {f['name']}\n\n{metin}")
    return "\n\n".join(parcalar)


def _rebuild_merged_retriever(api_key: str, session: dict) -> None:
    """Oturumun aktif dosyalarındaki FAISS index'lerini birleştirip oturum retriever'ını kurar.

    Ekleme ve silmede çağrılır. LRU cache kullanır — diskten tekrar yüklemez.
    """
    embeddings = _make_embeddings(api_key)
    merged = None
    for f in session["active_files"]:
        db = _get_cached_faiss(f["hash"], embeddings)
        if db is None:
            continue
        if merged is None:
            merged = db
        else:
            merged.merge_from(db)
    session["retriever"] = merged.as_retriever(search_kwargs={"k": 4}) if merged else None
    # Cache scope = aktif dosya kümesinin birleşik hash'i (konu-anlatımı cache'i için)
    if session["active_files"]:
        birlesik = "|".join(sorted(f["hash"] for f in session["active_files"]))
        session["current_pdf_hash"] = hash_bytes(birlesik.encode("utf-8"))
    else:
        session["current_pdf_hash"] = "default"


def _resolve_api_key(user_key: Optional[str]) -> Tuple[str, bool]:
    """
    Aktif API key'i belirler.
    Herkes kendi key'ini girmek zorundadır. Ortak sunucu havuzu devre dışı bırakılmıştır.
    """
    if user_key and user_key.strip():
        return user_key.strip(), True
        
    raise HTTPException(
        status_code=400,
        detail="Lütfen kullanmaya başlamak için ayarlardan kendi Gemini API anahtarınızı (API Key) ekleyin.",
    )



def _enforce_quota(request: Request, using_user_key: bool) -> Optional[str]:
    """
    Sunucu key'i kullanılıyorsa IP başına günlük limit uygula.
    Returns: çağıran IP (sonradan increment için), user key'i ise None.
    """
    if using_user_key:
        return None
    # Spoof'a karşı TRUSTED_PROXIES whitelist'ine göre güvenli IP çözümü
    client_ip = resolve_client_ip(request)

    allowed, _remaining = check_rate_limit(client_ip)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Günlük istek limiti doldu ({SERVER_KEY_DAILY_LIMIT} istek). "
                "Kendi Gemini API key'ini ayarlardan ekleyip sınırsız kullanabilirsin "
                "(aistudio.google.com → Get API Key, tamamen ücretsiz)."
            ),
        )
    return client_ip


def _record_usage(client_ip: Optional[str]) -> int:
    """Sunucu key kullanıldıysa sayacı artırır, kalan istekleri döner."""
    if client_ip is None:
        return -1  # User kendi key'iyle çalışıyor, limit yok
    new_count = increment_rate_limit(client_ip)
    return max(0, SERVER_KEY_DAILY_LIMIT - new_count)


def _kullanim_blok(using_user_key: bool, kalan: int, cached: bool) -> dict:
    """Response içine kullanım bilgisi (frontend bunu yorumlayıp banner gösterebilir)."""
    return {
        "sunucu_key": not using_user_key,
        "kalan": kalan,
        "limit": SERVER_KEY_DAILY_LIMIT if not using_user_key else None,
        "cached": cached,
    }


# ─── Chain inşaatçıları (her istekte API key'iyle yeniden) ────────

def _dokumanlari_birlestir(docs):
    return "\n\n".join(doc.page_content for doc in docs)


def _faiss_arama_metni(girdiler):
    return girdiler["history"] + "\n" + girdiler["question"]


RAG_PROMPT = ChatPromptTemplate.from_template("""
Sen akademik düzeyde bir bilgisayar mühendisliği asistanısın. Görevin, sağlanan PDF dokümanlarını analiz ederek detaylı, teknik ve akademik derinliği olan yanıtlar üretmektir.

KURALLAR:
1. Kişisel persona kullanma (asla 'sevgili öğrencim', 'baş öğretmen' vb. ifadeler kullanma).
2. Sadece doğrudan, net ve akademik bir dil kullan.
3. Konuları maddeler halinde, alt başlıklarla ve detaylı açıklamalarla işle.
4. Sınavlarda çıkabilecek kritik noktalara ve mantıksal çıkarımlara (kavramlar arası bağlantılar) özel vurgu yap.
5. Görselleştirme gerektiğinde mantıksal şemaları veya akış diyagramlarını metin tabanlı (markdown tabloları veya diyagram blokları) olarak tasvir et.
6. Eğer bir kavramın mantığını anlatıyorsan, sadece tanımını yapma; o kavramın arkasındaki mühendislik problemini ve çözümünü açıkla.

Yanıtını SADECE aşağıdaki ders notlarına dayandır. Notlarda olmayan bir konu sorulursa "Bu bilgi mevcut ders notlarında bulunmuyor" de ve uydurma.

Geçmiş Sohbet:
{history}

Ders Notları:
{context}

Soru: {question}

Cevap:
""")


CHAT_PROMPT = ChatPromptTemplate.from_template("""
Sen Lostick AI'nin yapay zeka asistanısın. Akıllı, samimi ve dost canlısı bir tonla konuşursun.

KURALLAR:
1. Kullanıcıya zeki bir arkadaş gibi davran. Doğal, içten ve günlük bir dille cevap ver.
2. ASLA "sevgili öğrencim", "değerli kullanıcı", "baş öğretmen", "ben senin hocanım" gibi yapay veya yumuşatılmış hitaplar kullanma.
3. Soru teknik veya akademik içerikse net ve doğru bilgi ver; ama dilin akıcı ve samimi kalsın.
4. Cevapları gereksiz uzun tutma; sorunun kapsamına göre doğal uzunlukta yanıtla.

Geçmiş Sohbet:
{history}

Soru: {question}

Cevap:
""")


def _build_rag_chain(api_key: str, retriever_obj):
    """RAG zinciri: PDF context + history-aware retrieval + Gemini."""
    llm = _make_llm(api_key)
    return (
        {
            "context": _faiss_arama_metni | retriever_obj | _dokumanlari_birlestir,
            "question": itemgetter("question"),
            "history": itemgetter("history"),
        }
        | RAG_PROMPT
        | llm
        | StrOutputParser()
    )


def _build_chat_chain(api_key: str):
    """PDF'siz genel sohbet zinciri."""
    llm = _make_llm(api_key)
    return CHAT_PROMPT | llm | StrOutputParser()

def _start_session_cleanup_worker():
    def cleanup_loop():
        from auth_servisi import cleanup_expired_sessions
        # Sunucu yeni başlamışken hemen bir kez temizlik yap
        try:
            count = cleanup_expired_sessions()
            if count > 0:
                print(f"🧹 GC: {count} adet süresi geçmiş oturum veritabanından temizlendi.")
        except Exception as e:
            print(f"❌ GC: Oturum temizleme hatası: {e}")
            
        while True:
            time.sleep(3600)  # Her 1 saatte bir çalış
            try:
                count = cleanup_expired_sessions()
                if count > 0:
                    print(f"🧹 GC: {count} adet süresi geçmiş oturum veritabanından temizlendi.")
            except Exception as e:
                print(f"❌ GC: Oturum temizleme hatası: {e}")
                
    t = threading.Thread(target=cleanup_loop, daemon=True, name="SessionCleanupWorker")
    t.start()


# 3. Sunucu Başlarken Çalışacak Fonksiyon (Motoru Isıtma)
@app.on_event("startup")
def sistem_baslat():
    global _default_retriever
    print("[INFO] API: Zeka ve Hafiza modulleri uyaniyor, lutfen bekleyin...")
    _init_llm_tracking_monkeypatch() # İzleme sarmalayıcısını sınıf seviyesinde yükle
    init_image_cache() # Wikimedia görsel cache tablosunu hazırla
    init_llm_cache()   # LLM cevap cache + rate limit tablosu

    init_auth()        # Users + sessions tabloları + admin seed
    init_kavram()      # Kavram Kütüphanesi: klasör + kart tabloları
    init_translation_jobs()  # Yapay Zeka Çeviri Merkezi veritabanı tablosu
    _start_session_cleanup_worker()  # Süresi dolan oturumları temizleyen arka plan görevini başlat
    try:
        # Default (paylaşımlı, salt-okunur) FAISS hafızasını yükle — chat fallback'i
        server_key = os.getenv("GOOGLE_API_KEY")
        if not server_key:
            print("[WARN] GOOGLE_API_KEY tanimsiz — default FAISS hafiza yuklenmedi. Kullanicilar kendi key'leriyle PDF yukleyebilir.")
            return
        embeddings = _make_embeddings(server_key)
        vektor_veri_tabani = FAISS.load_local("lostick_faiss_hafiza", embeddings, allow_dangerous_deserialization=True)
        _default_retriever = vektor_veri_tabani.as_retriever(search_kwargs={"k": 2})
        print("[OK] API: Sistem basariyla yuklendi ve isteklere hazir!")
    except Exception as e:
        print(f"[ERROR] API Baslatma Hatasi: {e}")


# 4. Soru-Cevap Uç Noktası (Endpoint)
@app.post("/api/soru-sor")
async def soru_sor_endpoint(
    istek: SoruIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    skey = _session_key(authorization, x_session_id)
    session = _get_session(skey)
    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    # Oturumun yüklü dosyaları varsa onları on-the-fly birleştir, yoksa paylaşımlı default hafızayı kullan
    aktif_retriever = _get_active_retriever(api_key, session["active_files"]) or _default_retriever
    if aktif_retriever is None:
        raise HTTPException(status_code=500, detail="Sistem henüz hazır değil, hafıza yüklenemedi.")
    client_ip = _enforce_quota(request, using_user_key)

    # Cache lookup — oturumun dosya kümesine scope'lu
    ckey = make_cache_key(session["current_pdf_hash"], "soru-sor", f"{istek.soru}||{istek.gecmis}")
    cached = cache_get(ckey)
    if cached is not None:
        import json
        cevap_str = cached
        sources_list = []
        try:
            parsed = json.loads(cached)
            if isinstance(parsed, dict) and "cevap" in parsed:
                cevap_str = _extract_text(parsed["cevap"])
                sources_list = parsed.get("sources", [])
        except Exception:
            pass
            
        return {
            "durum": "basarili",
            "soru": istek.soru,
            "cevap": cevap_str,
            "sources": sources_list,
            "kullanim": _kullanim_blok(using_user_key, -1 if using_user_key else SERVER_KEY_DAILY_LIMIT, cached=True),
        }

    try:
        # Sohbet geçmişi ve soruyu birleştirip FAISS'ta aratmak için sorgu metnini çıkarıyoruz
        arama_metni = _faiss_arama_metni({"question": istek.soru, "history": istek.gecmis})
        
        # İlgili döküman parçalarını (chunks) geri çağırıyoruz
        if hasattr(aktif_retriever, "invoke"):
            source_docs = aktif_retriever.invoke(arama_metni)
        else:
            source_docs = aktif_retriever.get_relevant_documents(arama_metni)
            
        if not source_docs:
            source_docs = []
        
        # Döküman metinlerini birleştirip bağlamı hazırlıyoruz
        context_str = _dokumanlari_birlestir(source_docs)
        
        # Prompt şablonunu dolduruyoruz
        prompt_val = RAG_PROMPT.format(
            history=istek.gecmis,
            context=context_str,
            question=istek.soru
        )
        
        # LLM'i çağırıyoruz
        llm = _make_llm(api_key)
        _rate_gate(api_key)
        cevap_obj = llm.invoke(prompt_val)
        cevap_raw = cevap_obj.content if hasattr(cevap_obj, "content") else str(cevap_obj)
        cevap = _extract_text(cevap_raw)
        
        # Kaynak kartlarını hazırlıyoruz
        sources = []
        seen_sources = set()
        for doc in source_docs:
            # Metadata'dan source alanını güvenli alalım (None veya boş string olmasını engelleyelim)
            doc_name = doc.metadata.get("source")
            if not doc_name or not isinstance(doc_name, str):
                doc_name = "Bilinmeyen Belge"
            # Sadece dosya adını alalım, tam yolu değil
            doc_name = os.path.basename(doc_name)
            
            # Sayfa numarasını al (0-indexed sayfa numarasını 1-indexed sayfa olarak kullanıcıya gösteriyoruz)
            page = doc.metadata.get("page")
            page_num = (page + 1) if page is not None else None
            
            # Önizleme olarak ilk 120 karakteri kırpalım
            preview = doc.page_content.strip() if doc.page_content else ""
            if len(preview) > 120:
                preview = preview[:120] + "..."
                
            # Mükerrer kaynakları önlemek için unique bir anahtar kullanalım
            source_key = f"{doc_name}:{page_num}"
            if source_key not in seen_sources:
                seen_sources.add(source_key)
                sources.append({
                    "documentName": doc_name,
                    "pageNumber": page_num,
                    "preview": preview
                })
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

    import json
    cache_payload = json.dumps({"cevap": cevap, "sources": sources}, ensure_ascii=False)
    cache_set(ckey, cache_payload)
    
    kalan = _record_usage(client_ip)

    # RAM Temizliği: FAISS retriever nesnesini hemen serbest bırakıp çöp toplayıcıyı tetikle
    if "aktif_retriever" in locals():
        del aktif_retriever
    gc.collect()

    return {
        "durum": "basarili",
        "soru": istek.soru,
        "cevap": cevap,
        "sources": sources,
        "kullanim": _kullanim_blok(using_user_key, kalan, cached=False),
    }

# --- YENİ: SADECE SOHBET İÇİN BAĞIMSIZ UÇ NOKTA (PDF GEREKTİRMEZ) ---
@app.post("/api/genel-sohbet")
async def genel_sohbet_endpoint(
    istek: SoruIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
):
    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    # Cache lookup (no-pdf scope)
    ckey = make_cache_key("no-pdf", "genel-sohbet", f"{istek.soru}||{istek.gecmis}")
    cached = cache_get(ckey)
    if cached is not None:
        return {
            "durum": "basarili",
            "soru": istek.soru,
            "cevap": _extract_text(cached),
            "kullanim": _kullanim_blok(using_user_key, -1 if using_user_key else SERVER_KEY_DAILY_LIMIT, cached=True),
        }

    try:
        chain = _build_chat_chain(api_key)
        _rate_gate(api_key)
        cevap = chain.invoke({"question": istek.soru, "history": istek.gecmis})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    cache_set(ckey, cevap)
    kalan = _record_usage(client_ip)
    return {
        "durum": "basarili",
        "soru": istek.soru,
        "cevap": _extract_text(cevap),
        "kullanim": _kullanim_blok(using_user_key, kalan, cached=False),
    }

# --- ÇOK DOSYALI BİLGİ TABANI ---
def _dosyalar_payload(session: dict, using_user_key: bool, kalan: Optional[int] = None,
                      cached: bool = False, mesaj: Optional[str] = None) -> dict:
    """Oturumun aktif dosya listesini içeren standart yanıt."""
    active_files = session["active_files"]
    payload = {
        "durum": "basarili",
        "dosyalar": [
            {"name": f["name"], "hash": f["hash"], "chars": f["chars"]}
            for f in active_files
        ],
        "dosya_sayisi": len(active_files),
        "max_dosya": MAX_FILES,
        "toplam_karakter": sum(f["chars"] for f in active_files),
    }
    if mesaj is not None:
        payload["mesaj"] = mesaj
    if kalan is not None:
        payload["kullanim"] = _kullanim_blok(using_user_key, kalan, cached=cached)
    return payload


@app.post("/api/pdf-yukle")
async def pdf_yukle_endpoint(
    request: Request,
    file: UploadFile = File(...),
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Bir dosyayı OTURUMUN bilgi tabanına EKLER (mevcut dosyalarla birleştirir).

    Endpoint adı geriye uyumluluk için '/api/pdf-yukle' kaldı ama artık tüm dosya
    tiplerini kabul eder ve retriever'ı DEĞİŞTİRMEZ, ÜZERİNE EKLER (merge).
    """
    skey = _session_key(authorization, x_session_id)
    session = _get_session(skey)
    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    try:
        file_bytes = await file.read()

        # OOM Koruması 1: Tek dosya boyutu sınırı (varsayılan 25 MB)
        if len(file_bytes) > MAX_UPLOAD_SIZE_BYTES:
            boyut_mb = len(file_bytes) / (1024 * 1024)
            sinir_mb = MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)
            raise HTTPException(
                status_code=413,
                detail=f"Dosya çok büyük ({boyut_mb:.1f} MB). Maksimum {sinir_mb:.0f} MB yüklenebilir.",
            )

        file_hash = hash_bytes(file_bytes)

        # Aynı dosya zaten ekliyse tekrar embed etme
        if any(f["hash"] == file_hash for f in session["active_files"]):
            return _dosyalar_payload(session, using_user_key, mesaj=f"{file.filename} zaten ekli.")

        # Hard limit
        if len(session["active_files"]) >= MAX_FILES:
            raise HTTPException(
                status_code=400,
                detail=f"En fazla {MAX_FILES} dosya eklenebilir. Yeni dosya için önce birini kaldırın.",
            )

        chars = _ensure_file_cached(file_bytes, file.filename, file_hash, api_key)

        # OOM Koruması 2: Toplam karakter sınırı (varsayılan 500K karakter ≈ 250 sayfa)
        mevcut_toplam = sum(f["chars"] for f in session["active_files"])
        if mevcut_toplam + chars > MAX_TOTAL_CHARS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Toplam belge boyutu sınırı aşıldı. "
                    f"Mevcut: {mevcut_toplam:,} karakter, yeni dosya: {chars:,} karakter, "
                    f"sınır: {MAX_TOTAL_CHARS:,} karakter. Yeni dosya için önce birini kaldırın."
                ),
            )

        session["active_files"].append({"name": file.filename, "hash": file_hash, "chars": chars})
        _rebuild_merged_retriever(api_key, session)
        _save_session(skey, session)

        kalan = _record_usage(client_ip)
        return _dosyalar_payload(session, using_user_key, kalan=kalan, cached=False,
                                 mesaj=f"{file.filename} eklendi.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dosyalar")
async def dosyalar_listele(
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Oturumdaki aktif dosyaları döner (frontend listeyi göstermek/geri yüklemek için)."""
    session = _get_session(_session_key(authorization, x_session_id))
    return _dosyalar_payload(session, True)


@app.post("/api/dosya-sil/{file_hash}")
async def dosya_sil(
    file_hash: str,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Bir dosyayı OTURUMUN bilgi tabanından kaldırır ve birleşik index'i yeniden kurar."""
    skey = _session_key(authorization, x_session_id)
    session = _get_session(skey)
    api_key, _ = _resolve_api_key(x_user_api_key)
    onceki = len(session["active_files"])
    session["active_files"] = [f for f in session["active_files"] if f["hash"] != file_hash]
    if len(session["active_files"]) != onceki:
        _rebuild_merged_retriever(api_key, session)
    _save_session(skey, session)
    return _dosyalar_payload(session, True, mesaj="Dosya kaldırıldı.")


@app.post("/api/dosyalari-temizle")
async def dosyalari_temizle(
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Oturumdaki tüm dosyaları temizler."""
    skey = _session_key(authorization, x_session_id)
    session = _get_session(skey)
    session["active_files"] = []
    session["retriever"] = None
    session["current_pdf_hash"] = "default"
    _save_session(skey, session)
    return _dosyalar_payload(session, True, mesaj="Tüm dosyalar temizlendi.")

def _dagit_sorular(boyutlar: list, toplam_soru: int) -> list:
    """Soruları dosyalara boyut-oranlı dağıtır (her dosyaya en az 1, soru yeterse).

    Soru sayısı dosya sayısından azsa → en büyük dosyalara 1'er verilir, gerisi 0.
    Yeterse → her dosyaya min 1, kalanı boyut oranına göre (largest-remainder).
    """
    n = len(boyutlar)
    if n == 0 or toplam_soru <= 0:
        return [0] * n
    if toplam_soru <= n:
        sirali = sorted(range(n), key=lambda i: boyutlar[i], reverse=True)
        paylar = [0] * n
        for i in sirali[:toplam_soru]:
            paylar[i] = 1
        return paylar
    paylar = [1] * n
    kalan = toplam_soru - n
    toplam_boyut = sum(boyutlar) or 1
    ham = [kalan * b / toplam_boyut for b in boyutlar]
    ek = [int(x) for x in ham]
    for i in range(n):
        paylar[i] += ek[i]
    artiklar = sorted(range(n), key=lambda i: ham[i] - int(ham[i]), reverse=True)
    for i in artiklar[: (kalan - sum(ek))]:
        paylar[i] += 1
    return paylar


def _test_gorev_plani(dosya_metinleri: list, toplam_soru: int,
                      batch_size: int = 5, pencere: int = 40000) -> list:
    """Test üretimi için 'görev' listesi üretir.

    - Soruları dosyalara boyut-oranlı dağıtır (_dagit_sorular)
    - Her dosya içinde, o dosyaya düşen soruları dosyanın TÜM uzunluğuna yayar
      (baş/orta/son hepsi kapsanır — sabit kesme noktası yok)
    Döner: [(bu_partideki_soru_sayisi, modele_gonderilecek_metin), ...]
    """
    if not dosya_metinleri:
        return []
    boyutlar = [max(1, len(t)) for _, t in dosya_metinleri]
    paylar = _dagit_sorular(boyutlar, toplam_soru)

    gorevler = []
    for (_, metin), pay in zip(dosya_metinleri, paylar):
        if pay <= 0:
            continue
        dosya_metni = metin if metin else " "
        batch_sayisi = (pay + batch_size - 1) // batch_size
        bolge_boyutu = max(1, len(dosya_metni) // batch_sayisi)
        kalan = pay
        for b in range(batch_sayisi):
            bu_batch = min(batch_size, kalan)
            start = b * bolge_boyutu
            end = min(len(dosya_metni), (b + 1) * bolge_boyutu + 3000)
            aktif_baglam = dosya_metni[start:end][:pencere]
            gorevler.append((bu_batch, aktif_baglam))
            kalan -= bu_batch
    return gorevler


def _kota_hatasi_mi(msg: str) -> bool:
    """Hata mesajı API kota/limit hatası mı? (Google 429 / RESOURCE_EXHAUSTED)"""
    if not msg:
        return False
    m = msg.lower()
    return any(s in m for s in ("resource_exhausted", "429", "quota", "rate limit", "rate-limit"))


_KOTA_MESAJI = (
    "API günlük/dakikalık limitin doldu. Yarın tekrar dene veya ayarlardan "
    "farklı bir API key gir."
)


# --- YENİ: İNTERAKTİF TEST OLUŞTURMA MOTORU (arka plan job) ---
def _run_test_generation(job_id, dosya_metinleri, istek, api_key, client_ip, using_user_key):
    """Test üretimini arka plan thread'inde çalıştırır.

    İlerleme ve sonuç _test_jobs[job_id]'e yazılır. Client polling ile durumu sorar.
    Her batch öncesi iptal bayrağı kontrol edilir → kullanıcı 'Vazgeç' derse durur.
    Sorular dosyalara boyut-oranlı dağıtılır ve her dosyanın tüm uzunluğuna yayılır.
    """
    cancel_event = _test_jobs[job_id]["cancel_event"]
    try:
        # Not: LLM nesneleri, her denemede en güncel aktif API anahtarını dinamik olarak kullanmak üzere 
        # deneme döngüsünün içinde anlık olarak oluşturulacaktır. Bu sayede hata durumunda key rotasyonu anında devreye girer.

        soru_sayisi = istek.soru_sayisi
        batch_size = 5
        tum_sorular = []

        # Görev planı: soruları dosyalara boyut-oranlı dağıt + her dosya içinde tüm
        # uzunluğa yay. Her görev = (o partideki soru sayısı, modele gönderilecek metin).
        gorevler = _test_gorev_plani(dosya_metinleri, soru_sayisi, batch_size)

        for gorev_no, (bu_batch, aktif_baglam) in enumerate(gorevler):
            # İptal kontrolü — kullanıcı 'Vazgeç' dediyse üretimi durdur
            if cancel_event.is_set():
                _job_set(job_id, status="cancelled", finished_at=time.time())
                print(f"--- TEST JOB CANCELLED: {job_id[:8]} ({len(tum_sorular)} soru üretilmişti) ---")
                return

            ekstra_zorluk_kurali = ""
            if istek.zorluk in ["Orta", "Zor"]:
                ekstra_zorluk_kurali = "\n        KURAL ZORLUK (ÇELDİRİCİLER): Yanlış şıkları (çeldiricileri) belirlerken çok dikkatli ol. Yanlış şıklar, doğrulara ÇOK BENZEMELİ ve konuyla ilgili gerçek kavramlardan seçilmelidir. Zıt kavramları veya ufak detayları değiştirerek öğrenciyi şaşırtacak, ilk bakışta doğru sanılacak güçlü ve zorlayıcı çeldiriciler kullan."

            # ─── Şık sayısı + soru tipi ayarları ───
            sik_harfleri = ["A", "B", "C", "D", "E"][: istek.sik_sayisi]
            sik_listesi_str = ", ".join(sik_harfleri)
            ornek_siklar_block = "\n".join(
                f'                    "{h}": "Kısa, net ve birbirinden farklı uzunlukta {h} şıkkı",'
                for h in sik_harfleri
            )

            if istek.soru_tipi == "karma":
                tip_kurali = f"""
        KURAL TİP (KARMA MOD): Üreteceğin sorular ÜÇ farklı tipten KARIŞIK olmalı. Dağılım dengeli olsun (yaklaşık eşit oranda, ama tamamen serbest seçim):

        1) ÇOKTAN SEÇMELİ — Soru cümlesinde boşluk ('____') OLMAMALI. TAM {istek.sik_sayisi} şıklı ({sik_listesi_str}). "soru_tipi": "coktan_secmeli".

        2) BOŞLUK DOLDURMA — Soru metninde MUTLAKA "____" (4 alt çizgi) işareti olmalı (boşluğun yeri). Şıklar boşluğa girecek kısa ifadeler olmalı. TAM {istek.sik_sayisi} şıklı ({sik_listesi_str}). "soru_tipi": "bosluk_doldurma".

        3) DOĞRU/YANLIŞ — Soru tek bir önerme cümlesi (örn. "TCP, bağlantı-yönelimli bir protokoldür."). Sadece İKİ şık olmalı: "A": "Doğru" ve "B": "Yanlış". DİĞER ŞIKLAR (C/D/E) BU TİP İÇİN ÜRETİLMEYECEK — JSON'da o alanlar HİÇ olmayacak. dogru_cevap "A" veya "B". "soru_tipi": "dogru_yanlis".

        Her soru objesinde "soru_tipi" alanı ZORUNLU ve şu üç değerden biri olmalı: "coktan_secmeli" | "bosluk_doldurma" | "dogru_yanlis".
        """
                # Karma için 3 örnek
                cs_ornek = (
                    "{\n"
                    + '                    "soru": "TCP/IP modelinde yönlendirme hangi katmana aittir?",\n'
                    + ornek_siklar_block + "\n"
                    + f'                    "dogru_cevap": "{sik_harfleri[1]}",\n'
                    + '                    "aciklama": "Doğru cevap '
                    + sik_harfleri[1]
                    + ' çünkü ...\\n\\n- '
                    + ' şıkkı yanlıştır çünkü ...\\n\\n- '.join(
                        [h for h in sik_harfleri if h != sik_harfleri[1]]
                    )
                    + ' şıkkı yanlıştır çünkü ...",\n'
                    + '                    "soru_tipi": "coktan_secmeli"\n'
                    + "                }"
                )
                bd_ornek = (
                    "{\n"
                    + '                    "soru": "TCP protokolü, ____ katmanında çalışır ve verinin doğruluğunu garanti eder.",\n'
                    + ornek_siklar_block + "\n"
                    + f'                    "dogru_cevap": "{sik_harfleri[0]}",\n'
                    + '                    "aciklama": "Doğru cevap '
                    + sik_harfleri[0]
                    + ' çünkü TCP iletim katmanında çalışır...\\n\\n- '
                    + ' şıkkı yanlıştır çünkü ...\\n\\n- '.join(
                        [h for h in sik_harfleri if h != sik_harfleri[0]]
                    )
                    + ' şıkkı yanlıştır çünkü ...",\n'
                    + '                    "soru_tipi": "bosluk_doldurma"\n'
                    + "                }"
                )
                dy_ornek = (
                    "{\n"
                    '                    "soru": "TCP, bağlantı-yönelimli bir protokoldür.",\n'
                    '                    "A": "Doğru",\n'
                    '                    "B": "Yanlış",\n'
                    '                    "dogru_cevap": "A",\n'
                    '                    "aciklama": "Önerme DOĞRUDUR çünkü TCP, veri gönderiminden önce ...",\n'
                    '                    "soru_tipi": "dogru_yanlis"\n'
                    "                }"
                )
                ornek_block = f"{cs_ornek},\n                {bd_ornek},\n                {dy_ornek}"
            else:
                # Klasik mod — sadece çoktan seçmeli
                tip_kurali = f"""
        KURAL TİP (KLASİK MOD): TÜM sorular ÇOKTAN SEÇMELİ olmalı. Boşluk doldurma veya doğru/yanlış ASLA üretme.
        Her sorunun TAM {istek.sik_sayisi} şıkkı olmalı: {sik_listesi_str}. Şık sayısından az ya da fazla şık BIRAKMAYA.
        Her soru objesinde "soru_tipi" alanı MUTLAKA "coktan_secmeli" olmalı.
        """
                klasik_ornek = (
                    "{\n"
                    '                    "soru": "Doğrudan sorulan teknik soru metni?",\n'
                    + ornek_siklar_block + "\n"
                    + f'                    "dogru_cevap": "{sik_harfleri[1]}",\n'
                    + '                    "aciklama": "Doğru cevap '
                    + sik_harfleri[1]
                    + ' çünkü ...\\n\\n- '
                    + ' şıkkı yanlıştır çünkü ...\\n\\n- '.join(
                        [h for h in sik_harfleri if h != sik_harfleri[1]]
                    )
                    + ' şıkkı yanlıştır çünkü ...",\n'
                    + '                    "soru_tipi": "coktan_secmeli"\n'
                    + "                }"
                )
                ornek_block = klasik_ornek

            json_prompt = f"""
            Aşağıdaki ders notlarında yer alan SADECE AKADEMİK VE TEKNİK kavramlardan {istek.zorluk} zorluk seviyesinde tam {bu_batch} adet soru hazırla.
{tip_kurali}
            KURAL 1: Çıktın SADECE VE SADECE geçerli bir JSON dizisi (array) olmalıdır.
            KURAL 2: ASLA üniversite adı, bölüm adı, dersin kodu, hocanın adı gibi meta bilgilerden soru ÜRETME. Sadece PDF'in içindeki gerçek öğretici bilgiye ve bilimsel kavramlara odaklan.
            KURAL 3: Sorulara "Ders notlarına göre..." gibi giriş cümleleriyle BAŞLAMA. Doğrudan ve akademik bir dille sor.
            KURAL 4 (ŞIK UZUNLUKLARI): Şıkların metin uzunlukları BİRBİRİNDEN FARKLI OLABİLİR. Ancak DOĞRU CEVAP ASLA SÜREKLİ EN UZUN ŞIK OLMAMALIDIR. Çeldiricileri bilerek uzun ve detaylı yaz ki öğrenci sadece uzunluğa bakarak tahmin edemesin. (D/Y sorularda bu kural geçersiz — sadece "Doğru" / "Yanlış" yazılacak.)
            KURAL 5 (AÇIKLAMA FORMATI — ÇOK KRİTİK):
                - ÇOKTAN SEÇMELİ ve BOŞLUK DOLDURMA için: 'aciklama' ilk olarak "Doğru cevap [HARF] çünkü..." ile başlamalı. Sonra TÜM yanlış şıkları MUTLAKA harfiyle birlikte '\\n\\n- A şıkkı yanlıştır çünkü...', '\\n\\n- C şıkkı yanlıştır çünkü...' formatında alt alta listele. ASLA "- Şık:" yazma; her satırda hangi şıktan (HARF) bahsettiğini açıkça yaz. Şık sayısı kaç ise o kadar açıklama olmalı (doğru hariç).
                - DOĞRU/YANLIŞ için: 'aciklama' "Önerme DOĞRUDUR çünkü..." veya "Önerme YANLIŞTIR çünkü..." ile başlamalı ve önermeyi detaylı açıklamalı. Şık şık liste YAPMA.
                - ASLA "Bu bilgi notlarda geçmiyor" gibi tembel ifadeler KULLANMA. Kendi genel akademik zekanı kullanarak detaylı ve öğretici açıklama yap.{ekstra_zorluk_kurali}

            Beklenen Kesin JSON Formatı (örnek):
            [
                {ornek_block}
            ]
            """

            tam_prompt = f"""
            Aşağıda sağlanan ders notları metnini kullanarak, istenen kurallara göre {bu_batch} adet test sorusu üret.
            
            DERS NOTLARI:
            {aktif_baglam}

            GÖREV VE KURALLAR:
            {json_prompt}
            """

            # Her denemede farklı temperature ile çağırıyoruz: ilk deneme yaratıcı,
            # sonrakiler giderek daha kararlı/deterministik. JSON mode zaten açık olduğu
            # için %99 ilk denemede geçer; bu sadece sigortadır.
            batch_basarili = False
            son_hata = None
            son_cevap = ""
            for deneme in range(4):
                try:
                    _rate_gate(api_key)
                    # Her denemede en güncel aktif API anahtarını almak için LLM'i yeniden oluşturuyoruz.
                    # Bu sayede eğer bir anahtar hata verip soğumaya alınırsa, sıradaki deneme otomatik olarak diğer aktif anahtara geçer.
                    temp = 0.95 if deneme == 0 else (0.4 if deneme == 1 else 0.15)
                    aktif_llm = _make_llm(api_key, temperature=temp, json_mode=True)
                    ham_cevap = aktif_llm.invoke(tam_prompt).content
                    son_cevap = _extract_text(ham_cevap)
                    batch_sorulari = _parse_json_array(ham_cevap)
                    if isinstance(batch_sorulari, list) and len(batch_sorulari) > 0:
                        tum_sorular.extend(batch_sorulari)
                        batch_basarili = True
                        break
                    son_hata = "Boş veya geçersiz liste"
                except Exception as e:
                    son_hata = str(e)
                    if deneme == 3:
                        print(f"--- LLM BATCH PARSE ERROR (Görev {gorev_no}) ---")
                        print(f"Hata: {son_hata}")
                        print(f"Ham cevap (ilk 500 char): {son_cevap[:500]}")
                        print("----------------------------")

            if not batch_basarili:
                # Partial success: en az 1 batch başarılıysa eldekiyle dön — kullanıcı
                # 30 yerine 25 soru alsın, sıfır soru almasın. Hiçbir şey üretemediysek hata.
                if len(tum_sorular) == 0:
                    hata_mesaji = (
                        _KOTA_MESAJI if _kota_hatasi_mi(str(son_hata))
                        else "Yapay zeka geçerli bir JSON formatı üretemedi, lütfen tekrar deneyin."
                    )
                    _job_set(job_id, status="error", error=hata_mesaji, finished_at=time.time())
                    return
                print(f"--- PARTIAL SUCCESS: {len(tum_sorular)}/{soru_sayisi} soru üretildi, kalan görevler atlandı ---")
                break

            # İlerleme bildir — client polling'de 'X/Y soru hazır' gösterebilir
            _job_set(job_id, progress=len(tum_sorular))

        # Son bir iptal kontrolü (loop bittikten sonra iptal gelmiş olabilir)
        if cancel_event.is_set():
            _job_set(job_id, status="cancelled", finished_at=time.time())
            return

        kalan = _record_usage(client_ip)
        _job_set(
            job_id,
            status="done",
            test=tum_sorular,
            soru_sayisi=len(tum_sorular),
            kullanim=_kullanim_blok(using_user_key, kalan, cached=False),
            finished_at=time.time(),
        )

    except Exception as e:
        print(f"--- TEST JOB ERROR: {job_id[:8]} — {e} ---")
        mesaj = _KOTA_MESAJI if _kota_hatasi_mi(str(e)) else str(e)
        _job_set(job_id, status="error", error=mesaj, finished_at=time.time())
    finally:
        gc.collect()  # OOM Koruması: Worker bitince bellek temizliği


@app.post("/api/test-olustur")
async def test_olustur_endpoint(
    istek: TestIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Test üretimini arka planda başlatır, hemen job_id döner.

    Client bu job_id ile /api/test-durum/{job_id} polling yapar. Üretim sunucuda
    thread'de devam ettiği için kullanıcı modalı kapatıp gezebilir, F5 atabilir.
    """
    session = _get_session(_session_key(authorization, x_session_id))
    if not session["active_files"]:
        raise HTTPException(status_code=400, detail="Test oluşturmadan önce bir dosya yüklemelisiniz.")

    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    # Her dosyanın metnini AYRI yakala (boyut-oranlı dağıtım + tüm uzunluğa yayma için).
    # Job başlatılırken snapshot alınır — kullanıcı sonradan dosya ekler/çıkarırsa bu job
    # kendi anlık görüntüsüyle çalışır.
    embeddings = _make_embeddings(api_key)
    dosya_metinleri = []
    for f in session["active_files"]:
        db = _get_cached_faiss(f["hash"], embeddings)
        if db is None:
            continue
        metin = "\n\n".join(d.page_content for d in db.docstore._dict.values())
        dosya_metinleri.append((f["name"], metin))
    if not dosya_metinleri:
        raise HTTPException(status_code=400, detail="Aktif dosya bulunamadı, lütfen tekrar yükleyin.")

    _job_cleanup()  # Eski bitmiş job'ları temizle

    job_id = uuid.uuid4().hex
    with _test_jobs_lock:
        _test_jobs[job_id] = {
            "status": "running",
            "progress": 0,
            "hedef": istek.soru_sayisi,
            "zorluk": istek.zorluk,
            "test": None,
            "error": None,
            "kullanim": None,
            "cancel_event": threading.Event(),
            "created_at": time.time(),
            "finished_at": None,
        }

    thread = threading.Thread(
        target=_run_test_generation,
        args=(job_id, dosya_metinleri, istek, api_key, client_ip, using_user_key),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "durum": "baslatildi"}


@app.get("/api/test-durum/{job_id}")
async def test_durum_endpoint(job_id: str):
    """Bir test job'unun durumunu döner. Bitmişse test verisini de içerir."""
    job = _job_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job bulunamadı (süresi dolmuş veya sunucu yeniden başlamış olabilir).")
    return {
        "status": job["status"],          # running | done | error | cancelled
        "progress": job.get("progress", 0),
        "hedef": job.get("hedef", 0),
        "soru_sayisi": job.get("soru_sayisi", 0),
        "zorluk": job.get("zorluk"),
        "test": job.get("test"),
        "error": job.get("error"),
        "kullanim": job.get("kullanim"),
    }


@app.post("/api/test-iptal/{job_id}")
async def test_iptal_endpoint(job_id: str):
    """Çalışan bir test job'unu iptal eder (kullanıcı 'Vazgeç' dediğinde)."""
    job = _job_get(job_id)
    if job is None:
        return {"durum": "zaten_yok"}
    with _test_jobs_lock:
        j = _test_jobs.get(job_id)
        if j and j["status"] == "running":
            j["cancel_event"].set()
    return {"durum": "iptal_istendi"}

# --- YENİ: KONU ANLATIMI MOTORU (arka plan job + uzunluk/mod) ---

# Anlatım yapı kuralları — UZUNLUK seçeneğine göre prompt'a enjekte edilir
_ANLATIM_UZUNLUK = {
    "kisa": (
        "UZUNLUK (KISA): Dokümandaki TÜM ana konu başlıklarına ve kavramlara MUTLAKA değin — "
        "hiçbir bölümü veya konuyu atlama. Bu mod KISA OLANDIR ama YÜZEYSEL/İSKELET DEĞİL: "
        "her başlık altında EN AZ 3-4 dolu paragraf yaz. Her konunun ne olduğunu, temel mantığını, "
        "nasıl çalıştığını ve neden önemli olduğunu okuyan kişinin gerçekten kavrayacağı kadar açıkla; "
        "her önemli kavrama en az bir örnek ver. Sadece çok ince alt detaylara, uzun türetmelere ve "
        "kapsamlı karşılaştırma serilerine girme — onları UZUN moda bırak. "
        "Başlık sayısını SEN belirle — dokümandaki konu sayısına göre kaç başlık gerekiyorsa o kadar aç."
    ),
    "orta": (
        "UZUNLUK (ORTA — DENGELİ): Dokümandaki TÜM ana konu başlıklarına ve kavramlara MUTLAKA değin — "
        "hiçbir bölümü veya konuyu atlama. Bu mod KISA'dan belirgin şekilde DAHA UZUN ve DAHA DOYURUCU olmalı: "
        "her ana başlık altında gerekli alt başlıkları (###) aç ve HER alt başlık için EN AZ 4-6 paragraflık "
        "açıklayıcı içerik yaz. Her kavramı açık şekilde anlat, her birine 2-3 somut örnek ekle, gerektiğinde "
        "karşılaştırma tablosu veya şema kullan. Detaya in ama her kavramın en uç istisnasına kadar gitme — "
        "o seviyeyi UZUN moda bırak. Çıktı dolu dolu, kapsamlı bir ders notu hissi versin. "
        "Başlık sayısını SEN belirle — dokümandaki konu sayısına göre kaç başlık gerekiyorsa o kadar aç."
    ),
    "uzun": (
        "UZUNLUK (UZUN — MAKSİMUM): ÇOK ÇOK UZUN, son derece detaylı, kitap bölümü/kapsamlı ders notu "
        "niteliğinde devasa bir doküman üret. Bu en uzun moddur — kısa tutmaya çalışma, AKSİNE olabildiğince "
        "GENİŞLET. Dokümandaki konuyla ilgili NEREDEYSE HER ŞEYE değin: tüm ana başlıklar, alt konular, "
        "kavramlar, tanımlar, formüller, türetmeler, örnekler, karşı-örnekler, istisnalar, avantaj/dezavantajlar, "
        "tarihsel arka plan ve kavramlar arası ilişkiler EKSİKSİZ işlensin. Hiçbir kavramı atlama. "
        "Her ana başlık altında gerekli TÜM alt başlıkları (###) aç ve HER alt başlık için EN AZ 6-10 paragraflık "
        "derinlemesine açıklama yaz; bolca somut örnek, adım adım açıklama, karşılaştırma tablosu ve şema kullan. "
        "Her kavramın hem 'ne' hem 'neden' hem 'nasıl'ını açıkla. Uzunluktan ASLA çekinme; öğrenci bu tek dokümanı "
        "okuyarak konuya tamamen hâkim olabilmeli. Başlık sayısını SEN belirle — dokümandaki konu sayısına göre "
        "kaç başlık gerekiyorsa o kadar aç, ama her birini derinlemesine işle."
    ),
}

# Anlatım modu kuralları — ÖĞRETİCİ vs SINAV ODAKLI
_ANLATIM_MOD_OGRETICI = """\
ANLATIM MODU: ÖĞRETİCİ
Kullanıcının konuyu HİÇ BİLMEDİĞİNİ varsay. Sıfırdan, sindire sindire, MANTIĞINI kavratarak anlat.

STİL:
- Akademik ama açıklayıcı dil. Sade, hikayeleştirilmiş, akıcı.
- Her tanımın yanında MUTLAKA günlük hayattan somut bir BENZETME (analoji) veya örnek olsun.
  (örn: "TCP/IP, postacının paketi nasıl taşıdığına benzer şekilde...")
- "Neden gerekli? Hangi problemi çözüyor?" sorusuna ÖNCE cevap ver, sonra kavrama gir.

YAPI:
- Konuyu mantıksal küçük parçalara (chunk) böl.
- Paragraf akışı bol; hikaye/sezgi öne çıksın.
- Madde listesi yerine açıklayıcı paragraflar tercih et."""

_ANLATIM_MOD_SINAV = """\
ANLATIM MODU: SINAV ODAKLI
Kullanıcı konuyu kabaca BİLİR ve sınavla bilinmesi gereken NOKTA ATIŞI bilgilere ihtiyacı var. Vakit dar.

STİL:
- Net, kısa, %100 BİLGİ ve TANIM odaklı. Boş laf KESİNLİKLE YASAK.
- Akademik ve sınav diliyle yaz.

YAPI:
- Uzun paragraflar yerine TAMAMEN MADDELER halinde (- ile) listeleme yap.
- Vurgu başlıkları aç:
  * **📌 Buradan Soru Gelir** — sınavda doğrudan çıkabilecek noktalar
  * **⭐ Hocaların En Sevdiği Tanım** — klasik ezber tanımlar
  * **🔑 Kritik Formül / Tanım** — formüller, kurallar, sayısal değerler
  * **📝 Vize/Final Tüyosu** — uyarılar, sık karıştırılan noktalar
- Kritik TANIMLARI **bold** yap ve `>` blockquote ile vurgula.
- Karşılaştırmalar MUTLAKA markdown tablo halinde.
- Her ana bölümün sonuna **📋 Olası Sınav Soruları** başlığı altında 2-3 örnek sınav sorusu ekle (cevaplı, kısa, tanım/formül sorgulayan tarzda)."""


# Uzunluk seçeneğine göre çıktı token üst sınırı — UZUN mod modelin maksimumuna yaklaşsın
_ANLATIM_MAX_TOKENS = {
    "kisa": 8192,
    "orta": 16384,
    "uzun": 65536,
}


def _anlatim_max_tokens(uzunluk: str) -> int:
    return _ANLATIM_MAX_TOKENS.get(uzunluk, 16384)


def _build_anlatim_prompt(uzunluk: str, mod: str) -> ChatPromptTemplate:
    """Uzunluk ve mod seçeneklerine göre prompt template'i kurar."""
    uzunluk_kurali = _ANLATIM_UZUNLUK.get(uzunluk, _ANLATIM_UZUNLUK["uzun"])
    mod_kurali = _ANLATIM_MOD_SINAV if mod == "sinav_odakli" else _ANLATIM_MOD_OGRETICI

    return ChatPromptTemplate.from_template(r"""
        Sen detaylı bir akademik konu anlatım motorusun. Görevin, sağlanan PDF içeriğini analiz edip kullanıcıya konuyu öğretmektir.

        ═══════════════════════════════════════
        {mod_kurali}
        ═══════════════════════════════════════

        ═══════════════════════════════════════
        {uzunluk_kurali}
        ═══════════════════════════════════════

        ORTAK KURALLAR (her modda geçerli):

        1. META BİLGİYE ASLA DEĞİNME (UZUNLUK ne olursa olsun geçerli): PDF'in kapağında veya sayfa altlarında geçen üniversite adı, fakülte, bölüm, ders kodu (örn: DOK 422), ders adı, dönem bilgisi (Bahar/Güz 2025), öğretim üyesinin adı/unvanı, vize-final yüzdesi/ağırlıkları, hafta planı, ders işleyişi, devam zorunluluğu, sınav takvimi, ofis saatleri, kaynakça veya değerlendirme tablosu gibi META/İDARİ/SAÇMA bilgilerden ASLA bahsetme. "Neredeyse her şeye değin" kuralı SADECE gerçek teknik/akademik içerik içindir; bu idari bilgiler dokümanda geçse bile onları anlatma, var olduklarını bile dile getirme.

        2. KİŞİSEL PERSONA YOK: "sevgili öğrencim", "değerli öğrenci", "baş öğretmen", "ben senin hocanım" gibi ifadeler kullanma. Önsöz veya samimi giriş yapma; doğrudan konunun kendisinden başla.

        3. KAVRAMSAL DERİNLİK (UZUNLUK izin verdiği ölçüde): Her kavram için sadece tanım vermekle yetinme. Mümkünse şu açılardan ele al:
           (a) Hangi problemi çözüyor?
           (b) Alternatifleriyle karşılaştırması nedir?
           (c) Avantajları ve dezavantajları nelerdir?
           (d) Gerçek dünyada nerede kullanılıyor?
           (e) Sınavlarda nasıl sorulabilir, kritik noktaları nelerdir?

        4. GÖRSELLEŞTİRME:

           **MERMAID DİYAGRAMLARI** (frontend bunları gerçek SVG olarak çizer):
           Mermaid syntax'ı çok hassastır. Render hatası almamak için aşağıdaki KURALLARA HARFI HARFINE uy:

           a) İlk satır DAİMA `flowchart TD` veya `flowchart LR` olsun. Eski `graph TD` syntax'ı KULLANMA.
           b) Node ID'leri SADECE Latin harf + rakam içersin (A, B, C, N1, S2). Türkçe karakter, boşluk veya özel karakter KULLANMA.
           c) HER node etiketini DAİMA ÇİFT TIRNAK içinde yaz:
              - DOĞRU dikdörtgen: `A["ARPANET (1968)"]`
              - DOĞRU karar: `B{{"Karar Gerekli mi?"}}`
              - DOĞRU stadyum: `C(["Veri İletimi"])`
           d) Edge label DAİMA tırnak içinde olsun: `A -->|"Evet"| B`. Tırnaksız basit edge geçerlidir.
           e) Türkçe karakter sadece TIRNAK İÇİNDEKİ etiketlerde olabilir.

           ÖRNEK:
           ```mermaid
           flowchart TD
               A["Başlangıç Noktası"] --> B{{"Karar Gerekli mi?"}}
               B -->|"Evet"| C["İşlemi Uygula"]
               B -->|"Hayır"| D["Çıkış"]
           ```

           **GERÇEK GÖRSELLER** (İngilizce Wikipedia üzerinden otomatik):
           Format: `<gorsel q="english wikipedia article title">Türkçe Caption</gorsel>`
           - `q` MUTLAKA İNGİLİZCE ve kısa kanonik Wikipedia başlığı (örn: "OSI model", "Coaxial cable").
           - Türkçe caption görselin altına basılır.
           - Etiketi ayrı paragrafa koy. Her büyük başlık altında en fazla 1-2 görsel.

           **GENEL KURAL**: Süreç/akış → Mermaid, fiziksel/akademik şema → `<gorsel>` etiketi, karşılaştırma → tablo. ASCII art YASAK, inline SVG YASAK.

        5. MATEMATİKSEL FORMÜLLER VE TABLOLAR:
           a) Matematiksel formülleri yazarken DAİMA standart LaTeX formatını kullan. Satır içi formüller için tek dolar `$formül$`, ayrı paragrafta blok formüller için çift dolar `$$formül$$` kullan. Formül içindeki düz metinler için \text{{...}} kullan ve parantezlerin/süslü parantezlerin eksiksiz eşleştiğinden emin ol (örn: $$2^{{32}} \approx 4.3\text{{ Milyar (IPv4)}}$$).
           b) Karşılaştırmalı ve yapılandırılmış verileri sunarken DAİMA standart Markdown tablosu kullan. Tablonun satırları arasında MUTLAKA standart satır sonu (\n) karakteri bulunmalıdır. Tabloyu tek bir satırda veya satırlar arasında yeni satır karakteri olmadan üretme. Her satırın kendi başına ayrı bir satırda (\n ile ayrılmış olarak) başladığından kesinlikle emin ol.

        6. KAYNAK KULLANIMI: Temelini PDF içeriğinden al; ama kavramı tam açıklamak için genel akademik bilgini de devreye sokabilirsin (tarihsel arka plan, ilgili technologies, pratik kullanım). PDF'te konunun karşılığı tamamen yoksa "Bu konu yüklenen belgede bulunmuyor" de.

        PDF İçeriği:
        {context}

        İşlenecek Konu: '{konu_basligi}'

        Konu Anlatımı:
        """).partial(mod_kurali=mod_kurali, uzunluk_kurali=uzunluk_kurali)


def _run_anlatim_generation(
    job_id: str,
    konu_basligi: str,
    uzunluk: str,
    mod: str,
    api_key: str,
    client_ip: Optional[str],
    using_user_key: bool,
    ckey: str,
    tam_metin: str,
) -> None:
    """Konu anlatımını arka planda üret; sonucu job dict'ine yaz.

    Çağrı anında belgenin TAM metni snapshot olarak verilir (k=4 retriever yerine);
    böylece 'tüm konulara değin' kuralı gerçekten uygulanabilir. Kullanıcı job çalışırken
    dosya ekleyip çıkarırsa bu üretim kendi anlık metniyle devam eder.
    """
    try:
        cancel_event = _anlatim_jobs.get(job_id, {}).get("cancel_event")
        anlatim_prompt = _build_anlatim_prompt(uzunluk, mod)

        cevap = ""
        son_hata = None
        for deneme in range(4):
            if cancel_event is not None and cancel_event.is_set():
                _ajob_set(job_id, status="cancelled", finished_at=time.time())
                return
            try:
                _rate_gate(api_key)
                # Her denemede en güncel aktif API anahtarını almak için LLM'i yeniden oluşturuyoruz.
                # Bu sayede eğer bir anahtar hata verip soğumaya alınırsa, sıradaki deneme otomatik olarak diğer aktif anahtara geçer.
                llm = _make_llm(api_key, max_output_tokens=_anlatim_max_tokens(uzunluk))
                anlatim_zinciri = anlatim_prompt | llm | StrOutputParser()
                cevap = anlatim_zinciri.invoke({"context": tam_metin, "konu_basligi": konu_basligi})
                break
            except Exception as e:
                son_hata = e
                if deneme == 3:
                    raise e

        # İptal kontrolü — LLM bittikten sonra ama görsel çekiminden önce
        if cancel_event is not None and cancel_event.is_set():
            _ajob_set(job_id, status="cancelled", finished_at=time.time())
            return

        # <gorsel q="..."> etiketlerini Wikimedia Commons'tan çekilen gerçek görsellere dönüştür.
        # replace_image_tags async olduğu için thread içinde yeni bir event loop'ta çalıştır.
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            cevap = loop.run_until_complete(replace_image_tags(cevap))
        finally:
            loop.close()

        if cancel_event is not None and cancel_event.is_set():
            _ajob_set(job_id, status="cancelled", finished_at=time.time())
            return

        cache_set(ckey, cevap)
        kalan = _record_usage(client_ip)

        _ajob_set(
            job_id,
            status="done",
            anlatim=cevap,
            kullanim=_kullanim_blok(using_user_key, kalan, cached=False),
            finished_at=time.time(),
        )

    except Exception as e:
        print(f"--- ANLATIM JOB ERROR: {job_id[:8]} — {e} ---")
        mesaj = _KOTA_MESAJI if _kota_hatasi_mi(str(e)) else str(e)
        _ajob_set(job_id, status="error", error=mesaj, finished_at=time.time())
    finally:
        gc.collect()  # OOM Koruması: Worker bitince bellek temizliği


def _run_anlatim_generation_rq(
    konu_basligi: str,
    uzunluk: str,
    mod: str,
    api_key: str,
    client_ip: Optional[str],
    using_user_key: bool,
    ckey: str,
    tam_metin: str,
) -> dict:
    """RQ-uyumlu konu anlatımı task'i. RQ worker process'inde çalışır.

    Threading versiyonundan farkı:
    - job_id RQ context'inden çekilir (current_job_id)
    - cancellation threading.Event yerine Redis flag polling
    - Sonuç dict olarak DÖNER (RQ Redis'te saklar) — local dict'e yazılmaz
    - meta (konu/uzunluk/mod) RQ job meta'sında tutulur, status endpoint'inden okunur
    """
    job_id = rq_queue.current_job_id()
    # Status endpoint'inin "running" cevabını zenginleştirebilmesi için meta'ya yaz
    rq_queue.update_meta(
        job_id or "", konu=konu_basligi, uzunluk=uzunluk, mod=mod,
    )

    def _cancelled() -> bool:
        return bool(job_id) and rq_queue.is_cancelled(job_id)

    try:
        anlatim_prompt = _build_anlatim_prompt(uzunluk, mod)
        cevap = ""

        for deneme in range(4):
            if _cancelled():
                return {"status": "cancelled"}
            try:
                _rate_gate(api_key)
                llm = _make_llm(api_key, max_output_tokens=_anlatim_max_tokens(uzunluk))
                anlatim_zinciri = anlatim_prompt | llm | StrOutputParser()
                cevap = anlatim_zinciri.invoke(
                    {"context": tam_metin, "konu_basligi": konu_basligi}
                )
                break
            except Exception as e:
                if deneme == 3:
                    raise

        if _cancelled():
            return {"status": "cancelled"}

        import asyncio
        loop = asyncio.new_event_loop()
        try:
            cevap = loop.run_until_complete(replace_image_tags(cevap))
        finally:
            loop.close()

        if _cancelled():
            return {"status": "cancelled"}

        cache_set(ckey, cevap)
        kalan = _record_usage(client_ip)

        return {
            "status": "done",
            "anlatim": cevap,
            "kullanim": _kullanim_blok(using_user_key, kalan, cached=False),
        }
    except Exception as e:
        print(f"--- ANLATIM RQ JOB ERROR: {(job_id or '?')[:8]} — {e} ---")
        mesaj = _KOTA_MESAJI if _kota_hatasi_mi(str(e)) else str(e)
        # Exception'ı re-raise et — RQ failed olarak işaretler, exc_info saklar
        # ama kullanıcı-dostu mesajı da result'a koyalım ki frontend okuyabilsin
        raise RuntimeError(mesaj)
    finally:
        gc.collect()


def _rq_anlatim_status_to_response(rq_status: dict) -> Optional[dict]:
    """RQ status dict'ini frontend'in beklediği shape'e çevirir."""
    state = rq_status.get("status")  # queued|started|deferred|finished|failed|stopped|canceled
    result = rq_status.get("result") or {}
    meta = rq_status.get("meta") or {}
    base = {
        "konu": meta.get("konu"),
        "uzunluk": meta.get("uzunluk"),
        "mod": meta.get("mod"),
        "anlatim": None,
        "error": None,
        "kullanim": None,
    }
    if state in ("queued", "started", "deferred"):
        return {**base, "status": "running"}
    if state == "finished":
        task_status = result.get("status") or "done"
        return {
            **base,
            "status": task_status,
            "anlatim": result.get("anlatim"),
            "kullanim": result.get("kullanim"),
        }
    if state in ("stopped", "canceled"):
        return {**base, "status": "cancelled"}
    if state == "failed":
        return {**base, "status": "error", "error": rq_status.get("error") or "İşlem başarısız."}
    return None


@app.post("/api/anlatim-baslat")
async def anlatim_baslat_endpoint(
    istek: AnlatimIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Konu anlatımı üretimini arka planda başlatır.

    Cache hit varsa anlatımı doğrudan döner (job yok); aksi halde job_id döner
    ve client /api/anlatim-durum/{job_id} ile polling yapar.
    """
    session = _get_session(_session_key(authorization, x_session_id))
    if not session["active_files"]:
        raise HTTPException(status_code=400, detail="Konu anlatımı için önce bir dosya yüklemelisiniz.")

    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    # Cache key — uzunluk + mod farkı farklı cache'e yazsın
    ckey = make_cache_key(
        session["current_pdf_hash"], "konu-anlatimi-v2",
        f"{istek.konu_basligi}|u={istek.uzunluk}|m={istek.mod}",
    )
    # ─── Cache kontrolü DEVRE DIŞI ───────────────────────────────────
    # Kullanıcı her seferinde taze/farklı bir anlatım istiyor.
    # Eski davranış: aynı PDF + aynı seçeneklerle cache hit varsa anında dönüyordu.
    # Yeni davranış: her zaman LLM'e gidip baştan üretim yapılır.
    # (cache_set hâlâ çağrılır — gelecekte tekrar açılabilir.)

    # Belgenin TAM metnini snapshot al — k=4 retriever yerine (tüm konulara değinebilmek için)
    tam_metin = _aktif_dosya_tam_metni(api_key, session)
    if not tam_metin.strip():
        raise HTTPException(status_code=400, detail="Aktif dosya bulunamadı, lütfen tekrar yükleyin.")

    _ajob_cleanup()

    # RQ aktifse: multi-worker güvenli queue'ya enqueue et
    if rq_queue.is_enabled():
        job_id = rq_queue.enqueue(
            _run_anlatim_generation_rq,
            istek.konu_basligi, istek.uzunluk, istek.mod,
            api_key, client_ip, using_user_key, ckey, tam_metin,
            job_timeout=600,  # 10 dk
        )
        return {"status": "running", "job_id": job_id}

    # Fallback: in-process threading (mevcut davranış, REDIS_URL tanımsızken)
    job_id = uuid.uuid4().hex
    with _anlatim_jobs_lock:
        _anlatim_jobs[job_id] = {
            "status": "running",
            "konu": istek.konu_basligi,
            "uzunluk": istek.uzunluk,
            "mod": istek.mod,
            "anlatim": None,
            "error": None,
            "kullanim": None,
            "cancel_event": threading.Event(),
            "created_at": time.time(),
            "finished_at": None,
        }

    thread = threading.Thread(
        target=_run_anlatim_generation,
        args=(
            job_id, istek.konu_basligi, istek.uzunluk, istek.mod,
            api_key, client_ip, using_user_key, ckey, tam_metin,
        ),
        daemon=True,
    )
    thread.start()

    return {"status": "running", "job_id": job_id}


@app.get("/api/anlatim-durum/{job_id}")
async def anlatim_durum_endpoint(job_id: str):
    """Bir anlatım job'unun durumunu döner. Bitmişse anlatım metnini de içerir."""
    # Önce RQ'da bak (aktifse) — uzun ömürlü, multi-worker güvenli kaynak
    if rq_queue.is_enabled():
        rq_status = rq_queue.fetch_job_status(job_id)
        if rq_status is not None:
            mapped = _rq_anlatim_status_to_response(rq_status)
            if mapped is not None:
                return mapped

    # Fallback: lokal threading dict
    job = _ajob_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Anlatım bulunamadı (süresi dolmuş veya sunucu yeniden başlamış olabilir).")
    return {
        "status": job["status"],          # running | done | error | cancelled
        "konu": job.get("konu"),
        "uzunluk": job.get("uzunluk"),
        "mod": job.get("mod"),
        "anlatim": job.get("anlatim"),
        "error": job.get("error"),
        "kullanim": job.get("kullanim"),
    }


@app.post("/api/anlatim-iptal/{job_id}")
async def anlatim_iptal_endpoint(job_id: str):
    """Çalışan bir anlatım job'unu iptal eder."""
    # RQ aktifse Redis flag'i koy (worker periyodik kontrol eder)
    if rq_queue.is_enabled():
        rq_queue.set_cancel_flag(job_id)

    # Threading fallback için lokal dict'i de işaretle (RQ ile birlikte ya da yalnız)
    job = _ajob_get(job_id)
    if job is None and not rq_queue.is_enabled():
        return {"durum": "zaten_yok"}
    with _anlatim_jobs_lock:
        j = _anlatim_jobs.get(job_id)
        if j and j["status"] == "running":
            j["cancel_event"].set()
    return {"durum": "iptal_istendi"}


# Geriye uyumluluk — eski sync endpoint'i koru (ama frontend artık baslat/durum/iptal kullanır)
@app.post("/api/konu-anlatimi")
async def konu_anlatimi_endpoint(
    istek: AnlatimIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Senkron konu anlatımı — yeni job-based endpoint'ler tercih edilmeli.

    Bu endpoint cache hit'leri için hızlı dönüş yapar; cache miss'te thread yerine
    inline üretir (uzun sürebilir). Yeni client'lar /api/anlatim-baslat kullanmalı.
    """
    session = _get_session(_session_key(authorization, x_session_id))
    if not session["active_files"]:
        raise HTTPException(status_code=400, detail="Konu anlatımı için önce bir PDF yüklemelisiniz.")

    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    ckey = make_cache_key(
        session["current_pdf_hash"], "konu-anlatimi-v2",
        f"{istek.konu_basligi}|u={istek.uzunluk}|m={istek.mod}",
    )
    # ─── Cache kontrolü DEVRE DIŞI (taze üretim her seferinde) ───

    try:
        llm = _make_llm(api_key, max_output_tokens=_anlatim_max_tokens(istek.uzunluk))
        anlatim_prompt = _build_anlatim_prompt(istek.uzunluk, istek.mod)

        tam_metin = _aktif_dosya_tam_metni(api_key, session)
        if not tam_metin.strip():
            raise HTTPException(status_code=400, detail="Aktif dosya bulunamadı, lütfen tekrar yükleyin.")

        anlatim_zinciri = anlatim_prompt | llm | StrOutputParser()
        _rate_gate(api_key)
        cevap = anlatim_zinciri.invoke({"context": tam_metin, "konu_basligi": istek.konu_basligi})
        cevap = await replace_image_tags(cevap)

        cache_set(ckey, cevap)
        kalan = _record_usage(client_ip)

        return {
            "durum": "basarili",
            "konu": istek.konu_basligi,
            "anlatim": cevap,
            "kullanim": _kullanim_blok(using_user_key, kalan, cached=False),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ──────────────────────────────────────────────────────────────────
# İNTERAKTİF ÖĞRENME KARTLARI (FLASHCARD) MOTORU
# Her kart TEK seferde HER İKİ modun verisiyle üretilir: betimlemeli (tanım + analoji)
# ve spot (2-3 maddelik vurucu liste). Frontend toggle ile sadece arka yüz metni değişir.
# ──────────────────────────────────────────────────────────────────

_KART_MAX_CARDS = 40  # tek seferde üretilebilecek üst sınır


def _kart_max_tokens(kart_sayisi: int) -> int:
    # Kart başına ~250 token bütçele, taban 8192
    return max(8192, min(65536, kart_sayisi * 400 + 2048))


def _build_kart_prompt() -> str:
    return """\
Aşağıdaki ders notu içeriğinden tam {kart_sayisi} adet İNTERAKTİF ÖĞRENME KARTI (flashcard) üret.

KARTLARIN AMACI: Öğrenci kartın ön yüzünde bir SORU görür, cevabı düşünür, sonra kartı çevirip
arka yüzde cevabı görür. Her kartın arka yüzü İKİ farklı modda hazır olmalı (öğrenci toggle ile geçer).

ÇIKTI FORMATI — SADECE ve SADECE geçerli bir JSON dizisi (array). Başka hiçbir metin, markdown fence YOK.
Her kart objesi şu alanları içermeli:

[
  {{
    "soru": "Kısa, net, tek bir kavramı sorgulayan soru. Örn: 'FastAPI'de Dependency Injection nedir?'",
    "tanim": "BETİMLEMELİ MOD - Aşama 1: Teknik ama açık, KISA ve NET tanım (1-2 cümle). Boş laf yok.",
    "betimleme": "BETİMLEMELİ MOD - Aşama 2: Günlük hayattan somut bir BENZETME/analoji (1-2 cümle). 'Bunu ... gibi düşünebilirsin' tarzında, kavramı zihne kazıyan, sıcak ve anlaşılır. Asla teknik tanımı tekrarlama; SADECE benzetme yap.",
    "spot": ["SPOT MOD: Sınavda puan getirecek 2-3 vurucu madde", "Her madde kısa, ezberlenebilir, hap gibi bilgi", "Kritik tanım/formül/anahtar kelime odaklı"]
  }}
]

KURALLAR:
1. SADECE gerçek akademik/teknik içerikten kart üret. ASLA üniversite adı, ders kodu, hoca adı, dönem,
   sınav yüzdesi, hafta planı gibi META/İDARİ bilgilerden kart yapma. Belgede geçse bile bunları kullanma.
2. "soru" alanı kısa ve tek kavrama odaklı olsun; "Ders notlarına göre..." gibi giriş YAPMA.
3. "tanim" net ve doğru olmalı; "betimleme" mutlaka bir ANALOJİ olmalı (tanımı tekrar etme).
4. "spot" 2-3 elemanlı bir dizi olmalı; her eleman kısa, ezbere uygun, sınav odaklı.
5. Kartlar belgedeki FARKLI konuları kapsasın — aynı kavramı tekrar tekrar sorma.
6. Türkçe üret. Tam {kart_sayisi} kart üret.

DERS NOTU İÇERİĞİ:
{context}

JSON Dizisi:
"""


def _normalize_kart(ham: dict) -> Optional[dict]:
    """LLM'den gelen ham kart objesini normalize et; geçersizse None."""
    if not isinstance(ham, dict):
        return None
    soru = str(ham.get("soru", "")).strip()
    tanim = str(ham.get("tanim", "")).strip()
    betimleme = str(ham.get("betimleme", "")).strip()
    spot_ham = ham.get("spot", [])
    if isinstance(spot_ham, str):
        spot = [s.strip() for s in spot_ham.split("\n") if s.strip()]
    elif isinstance(spot_ham, list):
        spot = [str(s).strip() for s in spot_ham if str(s).strip()]
    else:
        spot = []
    if not soru or not tanim:
        return None
    return {
        "soru": soru,
        "tanim": tanim,
        "betimleme": betimleme,
        "spot": spot[:4],  # en fazla 4 madde
    }


def _run_kart_generation(
    job_id: str,
    kart_sayisi: int,
    api_key: str,
    client_ip: Optional[str],
    using_user_key: bool,
    tam_metin: str,
) -> None:
    """Öğrenme kartlarını arka planda üret; sonucu job dict'ine yaz."""
    try:
        cancel_event = _kart_jobs.get(job_id, {}).get("cancel_event")

        max_tok = _kart_max_tokens(kart_sayisi)
        prompt_text = _build_kart_prompt().format(kart_sayisi=kart_sayisi, context=tam_metin)

        kartlar = []
        son_hata = None
        son_cevap = ""
        for deneme in range(4):
            if cancel_event is not None and cancel_event.is_set():
                _kjob_set(job_id, status="cancelled", finished_at=time.time())
                return
            try:
                _rate_gate(api_key)
                # Her denemede en güncel aktif API anahtarını almak için LLM'i yeniden oluşturuyoruz.
                temp = 0.7 if deneme == 0 else (0.4 if deneme == 1 else 0.15)
                aktif_llm = _make_llm(api_key, temperature=temp, json_mode=True, max_output_tokens=max_tok)
                ham_cevap = aktif_llm.invoke(prompt_text).content
                son_cevap = _extract_text(ham_cevap)
                ham_liste = _parse_json_array(ham_cevap)
                if isinstance(ham_liste, list) and len(ham_liste) > 0:
                    kartlar = [k for k in (_normalize_kart(h) for h in ham_liste) if k]
                    if kartlar:
                        break
                son_hata = "Boş veya geçersiz liste"
            except Exception as e:
                son_hata = str(e)
                if deneme == 3:
                    print(f"--- KART JSON PARSE ERROR ---\nHata: {son_hata}\nHam (ilk 500): {son_cevap[:500]}\n----")

        if not kartlar:
            hata_mesaji = (
                _KOTA_MESAJI if _kota_hatasi_mi(str(son_hata))
                else "Yapay zeka geçerli kart üretemedi, lütfen tekrar deneyin."
            )
            _kjob_set(job_id, status="error", error=hata_mesaji, finished_at=time.time())
            return

        if cancel_event is not None and cancel_event.is_set():
            _kjob_set(job_id, status="cancelled", finished_at=time.time())
            return

        kalan = _record_usage(client_ip)
        _kjob_set(
            job_id,
            status="done",
            kartlar=kartlar,
            kart_sayisi=len(kartlar),
            kullanim=_kullanim_blok(using_user_key, kalan, cached=False),
            finished_at=time.time(),
        )

    except Exception as e:
        print(f"--- KART JOB ERROR: {job_id[:8]} — {e} ---")
        mesaj = _KOTA_MESAJI if _kota_hatasi_mi(str(e)) else str(e)
        _kjob_set(job_id, status="error", error=mesaj, finished_at=time.time())
    finally:
        gc.collect()  # OOM Koruması: Worker bitince bellek temizliği


@app.post("/api/kart-olustur")
async def kart_olustur_endpoint(
    istek: KartIstegi,
    request: Request,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Öğrenme kartı üretimini arka planda başlatır, job_id döner."""
    session = _get_session(_session_key(authorization, x_session_id))
    if not session["active_files"]:
        raise HTTPException(status_code=400, detail="Kart oluşturmadan önce bir dosya yüklemelisiniz.")

    kart_sayisi = max(1, min(_KART_MAX_CARDS, int(istek.kart_sayisi)))

    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    tam_metin = _aktif_dosya_tam_metni(api_key, session)
    if not tam_metin.strip():
        raise HTTPException(status_code=400, detail="Aktif dosya bulunamadı, lütfen tekrar yükleyin.")

    _kjob_cleanup()

    job_id = uuid.uuid4().hex
    with _kart_jobs_lock:
        _kart_jobs[job_id] = {
            "status": "running",
            "hedef": kart_sayisi,
            "kartlar": None,
            "kart_sayisi": 0,
            "error": None,
            "kullanim": None,
            "cancel_event": threading.Event(),
            "created_at": time.time(),
            "finished_at": None,
        }

    thread = threading.Thread(
        target=_run_kart_generation,
        args=(job_id, kart_sayisi, api_key, client_ip, using_user_key, tam_metin),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "durum": "baslatildi"}


@app.get("/api/kart-durum/{job_id}")
async def kart_durum_endpoint(job_id: str):
    """Bir kart job'unun durumunu döner. Bitmişse kart verisini de içerir."""
    job = _kjob_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Kart bulunamadı (süresi dolmuş veya sunucu yeniden başlamış olabilir).")
    return {
        "status": job["status"],          # running | done | error | cancelled
        "hedef": job.get("hedef", 0),
        "kart_sayisi": job.get("kart_sayisi", 0),
        "kartlar": job.get("kartlar"),
        "error": job.get("error"),
        "kullanim": job.get("kullanim"),
    }


@app.post("/api/kart-iptal/{job_id}")
async def kart_iptal_endpoint(job_id: str):
    """Çalışan bir kart job'unu iptal eder."""
    job = _kjob_get(job_id)
    if job is None:
        return {"durum": "zaten_yok"}
    with _kart_jobs_lock:
        j = _kart_jobs.get(job_id)
        if j and j["status"] == "running":
            j["cancel_event"].set()
    return {"durum": "iptal_istendi"}


# ──────────────────────────────────────────────────────────────────
# AKILLI DOKÜMAN ÇEVİRİSİ (YAPAY ZEKA ÇEVİRİ MERKEZİ)
# Yabancı dildeki PDF'i parçalara bölüp sırayla (RPM'i koruyarak) Türkçe'ye çevirir,
# reportlab ile yeni bir Türkçe PDF üretir ve oturumun aktif dosyalarına ekler.
# Arka plan thread + polling deseni; X-Session-Id'ye scope'ludur.
# ──────────────────────────────────────────────────────────────────

_ceviri_cancel_events: dict = {}
_ceviri_cancel_events_lock = threading.Lock()

# Parça boyutu (sayfa). Truncation guard (aşağıda) sayesinde bu değer GÜVENLİ:
# bir parçanın çevirisi 8192 output token'a takılıp kesilirse, parça otomatik ikiye
# bölünüp yeniden çevrilir. Yani daha büyük parça = daha az istek ama asla eksik çeviri.
_CEVIRI_CHUNK_PAGES = 10
_CEVIRI_MAX_SPLIT_DEPTH = 4   # truncation'da parçayı en fazla bu kadar kez ikiye böl
_CEVIRI_MAX_TOKENS = 8192     # ücretsiz tier output tavanı

# Güvenlik sınırları — sunucuyu OOM'a, kotayı erimeye ve saatlerce süren job'lara karşı korur
_CEVIRI_MAX_MB = 30                              # yüklenebilir maks dosya boyutu (MB)
_CEVIRI_MAX_BYTES = _CEVIRI_MAX_MB * 1024 * 1024
_CEVIRI_MAX_PAGES = 400                          # çevrilebilir maks sayfa sayısı (PDF)
_CEVIRI_CHUNK_CHARS = 16000                      # sayfasız tipler (Word/TXT/kod...) için karakter-bazlı parça
_CEVIRI_MAX_CHARS = 1_200_000                    # sayfasız tipler için maks toplam karakter

# Çevrilebilir dosya tipleri — diğer modüllerle aynı (PDF + Word + PPT + Excel + EPUB + RTF + Görsel + Kod + Not)
_OFFICE_EXTENSIONS = {
    ".docx", ".doc", ".dotx", ".docm",
    ".pptx", ".ppt", ".potx", ".ppsx", ".pptm",
    ".xlsx", ".xls", ".xltx", ".xlsm", ".csv", ".tsv",
    ".odt", ".ods", ".odp", ".rtf", ".epub",
    ".pages", ".key", ".numbers"
}
_CEVIRI_KABUL_EXT = {".pdf", ".txt", ".ipynb", ".md"} | _IMAGE_EXTENSIONS | _CODE_EXTENSIONS | _OFFICE_EXTENSIONS

_CEVIRI_SYSTEM = (
    "Sen akademik bir çevirmensin. Sana gönderilen döküman parçalarını; metnin orijinal "
    "anlamını, başlık yapısını ve teknik terimlerin akademik karşılıklarını bozmadan jilet "
    "gibi Türkçe'ye çevir. Çıktıyı MARKDOWN olarak ver ve aşağıdaki YAPISAL kurallara harfiyen uy:\n"
    "- Başlıkları #/##/### ile koru.\n"
    "- Listeleri - veya 1. ile koru, vurguları **kalın** ile koru.\n"
    "- Tablo veya iki-sütunlu komut/açıklama listesi varsa MUTLAKA Markdown tablosu kullan "
    "(örn. | Komut | Açıklama | satırı + |---|---| ayraç).\n"
    "- Terminal çıktıları, kabuk komutları (chmod, gcc, ls, cd vb.), kod parçaları veya betikler "
    "için MUTLAKA üçlü-tick kod blokları kullan (örn. ```bash, ```python, ```text). Komutları "
    "ASLA düz metin paragraf olarak yazma; iki nokta üst üste sonrasında bile kod bloğu aç. "
    "Kod bloklarının İÇİNDEKİ HTML, XML veya benzeri etiketleri (<html>, <body>, <div> vb.) "
    "ASLA HTML entity'lerine (&lt;, &gt;, &amp;) çevirme — karakterleri olduğu gibi, < > & "
    "olarak bırak.\n"
    "- Matematik formüllerini ve LaTeX komutlarını (\\rightarrow, \\frac, x^2, \\alpha vb.) "
    "AYNEN koru — çeviriyi sadece açıklama metnine uygula.\n"
    "- Metinde [[GORSEL_1]], [[GORSEL_2]] gibi yer tutucular geçebilir; bunlar orijinal "
    "belgedeki görsellerin TAM konumunu işaret eder. Bu yer tutucuları AYNEN, kendi "
    "satırlarında and aynı sırayla koru — sayılarını DEĞİŞTİRME, SİLME veya yer değiştirme. "
    "Çeviride bu işaretleri yeni metnin uygun yerine değil, orijinaldeki YERİNE (komşu "
    "paragraflara göre) yerleştir ki görseller doğru yerde çıksın.\n"
    "Çeviri dışında ASLA yorum, açıklama veya '[Çeviri]' gibi etiket ekleme — yalnızca çevrilmiş "
    "Markdown metnini döndür."
)

_LANG_NAMES = {
    "tr": "Türkçe",
    "en": "İngilizce (English)",
    "de": "Almanca (Deutsch)",
    "fr": "Fransızca (Français)",
    "es": "İspanyolca (Español)",
    "ru": "Rusça (Русский)",
}


def _get_ceviri_system(target_lang: str, glossary: str = "") -> str:
    lang_name = _LANG_NAMES.get(target_lang, "Türkçe")
    
    glossary_inst = ""
    if glossary.strip():
        glossary_inst = (
            f"\n\nMUTLAKA UYMAN GEREKEN TERİM SÖZLÜĞÜ (GLOSSARY):\n"
            f"Çeviri esnasında aşağıdaki terim eşleşmelerine harfiyen uy. Terimleri başka bir şekilde çevirme:\n"
            f"{glossary.strip()}\n\n"
        )
    
    prompt = (
        f"Sen akademik bir çevirmensin. Sana gönderilen döküman parçalarını; metnin orijinal "
        f"anlamını, başlık yapısını ve teknik terimlerin akademik karşılıklarını bozmadan jilet "
        f"gibi {lang_name}'ye çevir. Çıktıyı MARKDOWN olarak ver ve aşağıdaki YAPISAL kurallara harfiyen uy:\n"
        f"- Başlıkları #/##/### ile koru.\n"
        f"- Listeleri - veya 1. ile koru, vurguları **kalın** ile koru.\n"
        f"- Tablo veya iki-sütunlu komut/açıklama listesi varsa MUTLAKA Markdown tablosu kullan "
        f"(örn. | Komut | Açıklama | satırı + |---|---| ayraç).\n"
        f"- Terminal çıktıları, kabuk komutları (chmod, gcc, ls, cd vb.), kod parçaları veya betikler "
        f"için MUTLAKA üçlü-tick kod blokları kullan (örn. ```bash, ```python, ```text). Komutları "
        f"ASLA düz metin paragraf olarak yazma; iki nokta üst üste sonrasında bile kod bloğu aç. "
        f"Kod bloklarının İÇİNDEKİ HTML, XML veya benzeri etiketleri (<html>, <body>, <div> vb.) "
        f"ASLA HTML entity'lerine (&lt;, &gt;, &amp;) çevirme — karakterleri olduğu gibi, < > & "
        f"olarak bırak.\n"
        f"- Matematik formüllerini ve LaTeX komutlarını (\\rightarrow, \\frac, x^2, \\alpha vb.) "
        f"AYNEN koru — çeviriyi sadece açıklama metnine uygula.\n"
        f"- Metinde [[GORSEL_1]], [[GORSEL_2]] gibi yer tutucular geçebilir; bunlar orijinal "
        f"belgedeki görsellerin TAM konumunu işaret eder. Bu yer tutucuları AYNEN, kendi "
        f"satırlarında ve aynı sırayla koru — sayılarını DEĞİŞTİRME, SİLME veya yer değiştirme. "
        f"Çeviride bu işaretleri yeni metnin uygun yerine değil, orijinaldeki YERİNE (komşu "
        f"paragraflara göre) yerleştir ki görseller doğru yerde çıksın.\n"
        f"- Eğer döküman tıp, anatomi veya biyoloji gibi alanlar içeriyorsa; Latince anatomik ve medikal terimleri (örn. Corpus callosum, Genu, Splenium, Ventriculus, Nn. spinales vb.) hedef dilin tıbbi literatürüne uygun şekilde aynen koru veya yaygın kabul görmüş tıbbi transliterasyonunu kullan. Bunları günlük kelimelere (örn. 'sert cisim', 'karıncık') tam anlamıyla çevirip anlamını bozma.\n"
        f"{glossary_inst}"
        f"Çeviri dışında ASLA yorum, açıklama veya '[Çeviri]' gibi etiket ekleme — yalnızca çevrilmiş "
        f"Markdown metnini döndür."
    )
    return prompt

# ─── Çağrı başına zaman aşımı (asılı kalma koruması) ─────────────────
# Gemini bazen yanıt vermeden takılabilir. SDK-seviyesi timeout (_make_llm timeout=)
# isteği keser; ek güvenlik için çağrıyı bir worker thread'de çalıştırıp SERT bir
# duvar (future.result(timeout)) uyguluyoruz — SDK timeout'u yutsa bile thread asılı kalmaz.
_CEVIRI_CALL_TIMEOUT = 90        # saniye — tek bir parça çevirisi için SDK timeout'u
_CEVIRI_CALL_WALL = 100         # saniye — sert duvar (SDK'dan biraz uzun)
_ceviri_executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)


def _invoke_with_timeout(llm, prompt: str, wall_seconds: float):
    """LLM çağrısını worker thread'de yürütür; wall_seconds'ı aşarsa TimeoutError fırlatır."""
    fut = _ceviri_executor.submit(llm.invoke, prompt)
    return fut.result(timeout=wall_seconds)  # aşarsa concurrent.futures.TimeoutError


def init_translation_jobs() -> None:
    """Yapay Zeka Çeviri Merkezi için SQLite tablosunu oluşturur (idempotent)."""
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS translation_jobs (
                job_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                filename TEXT,
                pdf_path TEXT,
                error TEXT,
                uyari TEXT,
                created_at REAL NOT NULL,
                finished_at REAL
            )
            """
        )
        conn.commit()


def _cjob_set(job_id: str, **fields) -> None:
    with get_db() as conn:
        # Önce mevcut durumu oku
        row = conn.execute(
            "SELECT status FROM translation_jobs WHERE job_id = ?",
            (job_id,)
        ).fetchone()
        
        if not row:
            # Bulunamadıysa yeni ekle
            status = fields.get("status", "running")
            progress = fields.get("progress", 0)
            total = fields.get("total", 0)
            filename = fields.get("filename")
            pdf_path = fields.get("pdf_path")
            error = fields.get("error")
            uyari = fields.get("uyari")
            created_at = fields.get("created_at", time.time())
            finished_at = fields.get("finished_at")
            
            conn.execute(
                """
                INSERT INTO translation_jobs (job_id, status, progress, total, filename, pdf_path, error, uyari, created_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, status, progress, total, filename, pdf_path, error, uyari, created_at, finished_at)
            )
        else:
            # Varsa dinamik güncelle
            if fields:
                keys = []
                vals = []
                for k, v in fields.items():
                    keys.append(f"{k} = ?")
                    vals.append(v)
                vals.append(job_id)
                conn.execute(
                    f"UPDATE translation_jobs SET {', '.join(keys)} WHERE job_id = ?",
                    tuple(vals)
                )
        conn.commit()

    # İptal tetikleme ve temizlik
    if "status" in fields and fields["status"] == "cancelled":
        with _ceviri_cancel_events_lock:
            event = _ceviri_cancel_events.pop(job_id, None)
            if event:
                event.set()


_CEVIRI_DISK_TTL = 24 * 3600  # diskteki çeviri sonuçları 24 saat saklanır


def _cjob_get(job_id: str) -> Optional[dict]:
    if not job_id or not re.fullmatch(r"[0-9a-fA-F]{32}", job_id):
        return None  # path traversal ve SQL enjeksiyon koruması
        
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT job_id, status, progress, total, filename, pdf_path, error, uyari, created_at, finished_at 
            FROM translation_jobs WHERE job_id = ?
            """,
            (job_id,)
        ).fetchone()
        if row:
            job_dict = {
                "job_id": row[0],
                "status": row[1],
                "progress": row[2],
                "total": row[3],
                "filename": row[4],
                "pdf_path": row[5],
                "error": row[6],
                "uyari": row[7],
                "created_at": row[8],
                "finished_at": row[9],
            }
            
            # Sunucusuz ortamlarda veya yeniden başlatma sonrası yerel dosya silinmişse S3'ten geri yükle
            if job_dict.get("status") == "done" and job_dict.get("pdf_path"):
                pdf_p = Path(job_dict["pdf_path"])
                if not pdf_p.exists():
                    try:
                        from storage_servisi import sync_ceviri_from_s3
                        if sync_ceviri_from_s3(pdf_p, job_id, "pdf"):
                            json_p = pdf_p.with_suffix(".json")
                            sync_ceviri_from_s3(json_p, job_id, "json")
                    except Exception as e:
                        print(f"⚠️ S3 Çeviri Geri Yükleme Hatası: {e}")

            # Cancel event kontrolü
            with _ceviri_cancel_events_lock:
                event = _ceviri_cancel_events.get(job_id)
            job_dict["cancel_event"] = event
            return job_dict
        
    # Bellekte veya DB'de yoksa → diskten/S3'ten oku (eski uyum için)
    meta_path = CEVIRI_CACHE_DIR / f"{job_id}.json"
    pdf_path = CEVIRI_CACHE_DIR / f"{job_id}.pdf"
    
    if not (meta_path.exists() and pdf_path.exists()):
        try:
            from storage_servisi import sync_ceviri_from_s3
            if sync_ceviri_from_s3(pdf_path, job_id, "pdf"):
                sync_ceviri_from_s3(meta_path, job_id, "json")
        except Exception as e:
            print(f"⚠️ S3 Çeviri Geri Yükleme Hatası (eski uyum): {e}")

    if meta_path.exists() and pdf_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["pdf_path"] = str(pdf_path)
            return meta
        except Exception:
            return None
    return None


def _cjob_cleanup() -> None:
    now = time.time()
    # 1) Veritabanı temizliği: TTL'i geçmiş tamamlanmış/hatalı işleri sil
    try:
        with get_db() as conn:
            completed_jobs = conn.execute(
                "SELECT job_id FROM translation_jobs WHERE status IN ('done', 'error', 'cancelled') AND ? - finished_at > ?",
                (now, _JOB_TTL_SECONDS)
            ).fetchall()
            
            for (jid,) in completed_jobs:
                conn.execute("DELETE FROM translation_jobs WHERE job_id = ?", (jid,))
                with _ceviri_cancel_events_lock:
                    _ceviri_cancel_events.pop(jid, None)
            conn.commit()
    except Exception as e:
        print(f"--- _cjob_cleanup DB Hatası: {e} ---")
        
    # 2) Disk temizliği — TTL'i geçmiş çeviri dosyalarını sil
    try:
        for f in CEVIRI_CACHE_DIR.glob("*"):
            if now - f.stat().st_mtime > _CEVIRI_DISK_TTL:
                f.unlink()
    except Exception:
        pass


def _pdf_metnini_parcala(file_bytes: bytes, pages_per_chunk: int) -> list:
    """PDF'i sayfa-bazlı, pages_per_chunk büyüklüğünde metin parçalarına böler.

    Bozuk/şifreli PDF veya sayfa limiti aşımında, kullanıcıya gösterilebilecek
    anlaşılır bir ValueError fırlatır (job bunu mesaj olarak yüzeye taşır).
    """
    from pypdf import PdfReader
    try:
        reader = PdfReader(BytesIO(file_bytes))
    except Exception:
        raise ValueError("PDF okunamadı — dosya bozuk veya geçersiz olabilir. Lütfen geçerli bir PDF yükleyin.")

    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")  # boş şifre dene (sahiplik şifresi olmayanlar açılır)
        except Exception:
            raise ValueError("Bu PDF şifre korumalı. Lütfen şifresiz bir kopya yükleyin.")

    try:
        toplam = len(reader.pages)
    except Exception:
        raise ValueError("Bu PDF şifre korumalı veya bozuk görünüyor. Lütfen şifresiz/geçerli bir kopya yükleyin.")

    if toplam == 0:
        raise ValueError("PDF'te sayfa bulunamadı.")
    if toplam > _CEVIRI_MAX_PAGES:
        raise ValueError(
            f"Bu PDF {toplam} sayfa içeriyor — çeviride üst sınır {_CEVIRI_MAX_PAGES} sayfa. "
            "Lütfen belgeyi bölerek daha küçük parçalar halinde yükleyin."
        )

    parcalar = []
    for start in range(0, toplam, pages_per_chunk):
        bolum = []
        for p in range(start, min(start + pages_per_chunk, toplam)):
            try:
                txt = reader.pages[p].extract_text() or ""
            except Exception:
                txt = ""
            if txt.strip():
                bolum.append(txt)
        parcalar.append("\n\n".join(bolum))
    return parcalar


def _metni_uzunlukla_parcala(text: str, max_chars: int) -> list:
    """Sayfasız metni (Word/TXT/kod...) ~max_chars'lık parçalara böler (paragraf sınırında)."""
    parcalar, buf, blen = [], [], 0
    for p in text.split("\n\n"):
        if buf and blen + len(p) > max_chars:
            parcalar.append("\n\n".join(buf))
            buf, blen = [], 0
        buf.append(p)
        blen += len(p) + 2
        if blen >= max_chars:  # tek başına çok büyük paragraf → ayrı parça
            parcalar.append("\n\n".join(buf))
            buf, blen = [], 0
    if buf:
        parcalar.append("\n\n".join(buf))
    return parcalar


_CEVIRI_MIN_IMG_PX = 20        # bundan küçük görseller (ikon/çizgi) gömülmez
_CEVIRI_MAX_IMG_PER_PAGE = 4   # sayfa başına gömülecek maks görsel (PDF için)


def _fitz_pixmap_png(doc, xref) -> Optional[bytes]:
    """PDF içindeki bir görseli (xref) RGB PNG byte'larına çevirir. 
    Küçük/bozuksa None. Saydam görsellerin altına beyaz arka plan ekler 
    ve CMYK renk uzayını RGB'ye dönüştürerek siyah kutu hatalarını önler.
    Katı renk bloklarını ve şablon şekillerini elemek için benzersiz renk sayısı filtresi içerir.
    """
    import fitz
    from PIL import Image
    import io
    try:
        pix = fitz.Pixmap(doc, xref)
        if pix.width < _CEVIRI_MIN_IMG_PX or pix.height < _CEVIRI_MIN_IMG_PX:
            return None
        
        # 1) Renk uzayı dönüşümleri: CMYK, Grayscale veya tanımsız ise RGB'ye çevir
        if pix.colorspace is None:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        elif pix.colorspace.n == 4:  # CMYK
            pix = fitz.Pixmap(fitz.csRGB, pix)
        elif pix.colorspace.n == 1:  # Gray
            pix = fitz.Pixmap(fitz.csRGB, pix)
            
        # 2) Saydamlık kanalı (alpha) varsa PyMuPDF içinde beyaz arka planla düzleştir
        if pix.alpha:
            bg = fitz.Pixmap(fitz.csRGB, pix.width, pix.height)
            bg.clearWith(255)  # Beyaz arka plan
            bg.copy(pix, pix.irect)
            pix = bg
            
        raw_png = pix.tobytes("png")
        if not raw_png:
            return None
            
        img = Image.open(io.BytesIO(raw_png))
        
        # Ek güvenlik: PIL seviyesinde de RGB olduğundan emin ol
        if img.mode != "RGB":
            img = img.convert("RGB")
            
        # 3) Benzersiz renk sayısı filtresi: 8 veya daha az renk barındıran katı renk 
        # bloklarını, şablon arka plan şekillerini veya basit çizgileri eliyoruz
        unique_colors = img.getcolors(maxcolors=8)
        if unique_colors is not None:
            # Görsel 8 veya daha az renk içeriyor -> solid renk kutusu veya ayraç, eliyoruz!
            # (PIL lazy load olduğu için piksel verisini okuyup doğrular)
            return None
            
        return raw_png
    except Exception as e:
        print(f"--- _fitz_pixmap_png Hata: {e} ---")
        return None


def _pdf_birimleri(file_bytes: bytes, api_key: str) -> list:
    """PDF'i PyMuPDF ile çeviri birimlerine böler: [{"text", "images":[png...]}].

    - Metin blokları + görseller, y koordinatlarına göre SIRALI biçimde interleave edilir;
      görseller metnin içinde `[[GORSEL_N]]` yer tutucularıyla işaretlenir (N, o sayfadaki
      görsel listesinin 1-tabanlı indeksidir).
    - Sayfa boşsa (taranmış) sayfayı görsele çevirip OCR yapar.
    - Şifreli/bozuk/sayfa-limiti durumlarında dostça ValueError.
    """
    import fitz
    from functools import cmp_to_key
    import re as _re_loc

    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
    except Exception:
        raise ValueError("PDF okunamadı — dosya bozuk veya geçersiz olabilir. Lütfen geçerli bir PDF yükleyin.")
    try:
        if doc.needs_pass:
            if not doc.authenticate(""):
                raise ValueError("Bu PDF şifre korumalı. Lütfen şifresiz bir kopya yükleyin.")
        toplam = doc.page_count
        if toplam == 0:
            raise ValueError("PDF'te sayfa bulunamadı.")
        if toplam > _CEVIRI_MAX_PAGES:
            raise ValueError(
                f"Bu PDF {toplam} sayfa içeriyor — çeviride üst sınır {_CEVIRI_MAX_PAGES} sayfa. "
                "Lütfen belgeyi bölerek daha küçük parçalar halinde yükleyin."
            )

        # ─── 1) ÖN TARAMA PASS'İ: Tekrarlayan Filigran ve Başlık/Altbilgileri Tespit Et ───
        header_footer_counts = {}
        for p in range(toplam):
            try:
                page = doc.load_page(p)
                page_h = float(page.rect.height) if page.rect else 0.0
                if page_h <= 0:
                    continue
                for tb in (page.get_text("blocks") or []):
                    if len(tb) < 7:
                        continue
                    x0, y0, x1, y1, txt, _bno, btype = tb[:7]
                    if btype != 0 or not txt or not txt.strip():
                        continue
                    txt_stripped = txt.strip()
                    # Sadece en üst %10 ve en alt %10 bölgedeki metinleri tarıyoruz
                    if y0 < page_h * 0.10 or y0 > page_h * 0.90:
                        header_footer_counts[txt_stripped] = header_footer_counts.get(txt_stripped, 0) + 1
            except Exception:
                pass

        # Filigran eleme eşik değeri
        watermark_threshold = 3 if toplam > 5 else 2

        # ─── 2) Layout-Aware Okuma Sırası Karşılaştırıcı ───
        def compare_reading_order(a, b):
            a_height = a["y1"] - a["y"]
            b_height = b["y1"] - b["y"]
            min_height = min(a_height, b_height)
            if min_height <= 0:
                min_height = 1.0
            
            overlap_start = max(a["y"], b["y"])
            overlap_end = min(a["y1"], b["y1"])
            overlap = max(0.0, overlap_end - overlap_start)
            
            # Eğer dikey çakışma her iki öğenin dikey yüksekliğinin %40'ından fazla ise: yan yanadırlar!
            if overlap > min_height * 0.40:
                if abs(a["x"] - b["x"]) > 2.0:
                    return -1 if a["x"] < b["x"] else 1
            
            # Dikey çakışma yoksa, yukarıdan aşağıya sırala
            if abs(a["y"] - b["y"]) > 2.0:
                return -1 if a["y"] < b["y"] else 1
            
            # İkisi de çok yakınsa soldan sağa
            return -1 if a["x"] < b["x"] else 1

        birimler = []
        _PAGE_NUM_RE = _re_loc.compile(r"^[ivxlcdmIVXLCDM\d\-–]{1,5}$")

        for p in range(toplam):
            page = doc.load_page(p)
            page_h = float(page.rect.height) if page.rect else 0.0
            page_w = float(page.rect.width) if page.rect else 0.0

            # 1) Metin bloklarını topla ve temizle
            text_items = []
            try:
                for tb in (page.get_text("blocks") or []):
                    if len(tb) < 7:
                        continue
                    x0, y0, x1, y1, txt, _bno, btype = tb[:7]
                    if btype != 0:  # 0 = metin bloğu
                        continue
                    if not (txt and txt.strip()):
                        continue
                    text_stripped = txt.strip()
                    
                    # Sayfa numarası filtresi: çok kısa, sadece rakam/Roma rakamı ve en üstte/altta
                    if (page_h > 0 and _PAGE_NUM_RE.match(text_stripped)
                            and (float(y0) < page_h * 0.08 or float(y0) > page_h * 0.92)):
                        continue
                        
                    # Tekrarlayan filigran ve başlık/altbilgi şablonlarını ele
                    if text_stripped in header_footer_counts:
                        if header_footer_counts[text_stripped] >= watermark_threshold:
                            if float(y0) < page_h * 0.10 or float(y0) > page_h * 0.90:
                                # Tekrarlayan şablon öğesi, eliyoruz!
                                continue

                    text_items.append({
                        "kind": "text",
                        "y": float(y0),
                        "y1": float(y1),
                        "x": float(x0),
                        "x1": float(x1),
                        "text": text_stripped,
                    })
            except Exception:
                pass

            # 2) Aynı satırdaki bitişik metin bloklarını birleştir
            if text_items:
                text_items.sort(key=lambda it: (round(it["y"], 1), it["x"]))
                merged = []
                line_tol = 4.0  # px — aynı satır toleransı
                for it in text_items:
                    if merged:
                        last = merged[-1]
                        same_line = abs(last["y"] - it["y"]) <= line_tol or abs(last["y1"] - it["y1"]) <= line_tol
                        rightwards = it["x"] >= last["x"]
                        if same_line and rightwards:
                            last["text"] = last["text"].rstrip() + " " + it["text"].lstrip()
                            last["x1"] = max(last["x1"], it["x1"])
                            last["y1"] = max(last["y1"], it["y1"])
                            continue
                    merged.append(dict(it))
                text_items = merged

            # 3) Görsel öğelerini tam koordinatlarıyla topla
            image_items = []
            try:
                infos = page.get_image_info(xrefs=True) or []
                seen_xrefs = set()
                for info in infos:
                    xref = info.get("xref")
                    if not xref or xref in seen_xrefs:
                        continue
                    seen_xrefs.add(xref)
                    bbox = info.get("bbox") or [0, 0, 0, 0]
                    # Koordinatları tam ekliyoruz
                    image_items.append({
                        "kind": "image",
                        "x": float(bbox[0]),
                        "y": float(bbox[1]),
                        "x1": float(bbox[2]),
                        "y1": float(bbox[3]),
                        "xref": int(xref)
                    })
            except Exception:
                pass

            # 4) Metin ve görselleri akıllı 2D okuma sırasına göre karıştırıp sırala
            all_items = sorted(text_items + image_items, key=cmp_to_key(compare_reading_order))

            parts = []
            gorseller = []
            for item in all_items:
                if item["kind"] == "text":
                    parts.append(item["text"])
                else:
                    if len(gorseller) >= _CEVIRI_MAX_IMG_PER_PAGE:
                        continue
                    png = _fitz_pixmap_png(doc, item["xref"])
                    if png:
                        gorseller.append(png)
                        parts.append(f"[[GORSEL_{len(gorseller)}]]")

            full_text = "\n\n".join(part for part in parts if part)

            # 5) OCR yedeği: Metin bulunamazsa sayfayı görsele çevirip OCR yap
            if not full_text.strip() or full_text.strip() == "\n\n".join(
                f"[[GORSEL_{i+1}]]" for i in range(len(gorseller))
            ):
                try:
                    pix = page.get_pixmap(dpi=150)
                    ocr = _extract_image_ocr(pix.tobytes("png"), ".png", api_key)
                    if ocr and ocr.strip():
                        full_text = ocr.strip()
                        gorseller = []
                except Exception as e:
                    print(f"--- CEVIRI OCR (sayfa {p+1}) hata: {e} ---")

            birimler.append({"text": full_text, "images": gorseller})
        return birimler
    finally:
        doc.close()


def _ceviri_birimleri(file_bytes: bytes, filename: str, api_key: str) -> list:
    """Çevrilecek dosyayı tipe göre çeviri birimlerine böler: [{"text", "images":[png...]}].

    - PDF → sayfa-bazlı, OCR + görsel çıkarımıyla (`_pdf_birimleri`).
    - Word/PPT/TXT/kod/not/görsel(OCR) → tam metin çıkarılıp karakter-bazlı parçalanır (görselsiz).
    Sorunlu girdilerde kullanıcı dostu ValueError fırlatır.
    """
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        return _pdf_birimleri(file_bytes, api_key)

    # Sayfasız tipler: mevcut çıkarıcıları kullan, karakter-bazlı parçala (görsel yok)
    temp_dosya = _gecici_dosya(file_bytes, filename)
    try:
        try:
            dokumanlar = _extract_documents(temp_dosya, filename, file_bytes, api_key)
        except HTTPException as he:
            raise ValueError(he.detail if isinstance(he.detail, str) else "Dosya okunamadı.")
    finally:
        if os.path.exists(temp_dosya):
            os.remove(temp_dosya)

    tam = "\n\n".join(
        d.page_content for d in dokumanlar if getattr(d, "page_content", "") and d.page_content.strip()
    )
    if not tam.strip():
        raise ValueError("Dosyadan metin çıkarılamadı (boş veya okunamayan içerik).")
    if len(tam) > _CEVIRI_MAX_CHARS:
        raise ValueError(
            f"Belge çok uzun (~{len(tam)//1000}K karakter) — çeviri üst sınırı aşıldı. "
            "Lütfen belgeyi bölerek daha küçük parçalar halinde yükleyin."
        )
    return [{"text": t, "images": []} for t in _metni_uzunlukla_parcala(tam, _CEVIRI_CHUNK_CHARS)]


def _is_truncated(resp) -> bool:
    """LLM cevabı 8192 token tavanına takılıp kesildi mi? (finish_reason + token sayısı)."""
    try:
        meta = getattr(resp, "response_metadata", {}) or {}
        fr = str(meta.get("finish_reason", "")).upper()
        if fr in ("MAX_TOKENS", "LENGTH"):
            return True
        usage = getattr(resp, "usage_metadata", None) or {}
        out = usage.get("output_tokens") or usage.get("candidates_token_count") or 0
        if out and out >= _CEVIRI_MAX_TOKENS - 200:
            return True
    except Exception:
        pass
    return False


def _split_text_half(text: str):
    """Metni ~iki eşit parçaya böler (paragraf, yoksa boşluk sınırından). Bölünemezse (text, '')."""
    paras = text.split("\n\n")
    if len(paras) >= 2:
        mid = len(paras) // 2
        return "\n\n".join(paras[:mid]).strip(), "\n\n".join(paras[mid:]).strip()
    if len(text) > 200:
        mid = len(text) // 2
        sp = text.rfind(" ", 0, mid)
        if sp <= 0:
            sp = mid
        return text[:sp].strip(), text[sp:].strip()
    return text, ""


def _translate_chunk_safe(text: str, llm, api_key: str, cancel_event, target_lang: str = "tr", glossary: str = "", using_user_key: bool = False, depth: int = 0) -> str:
    """Bir metin parçasını çevirir. RETRY+BACKOFF + TRUNCATION GUARD + API KEY ROTATION + CACHE içerir.

    - Önce MD5 önbelleği kontrol edilir. Varsa anında döner.
    - BYOK dışındaki çağrılarda havuzdan dinamik anahtar alınır ve 429 anında soğumaya alınarak rotasyon yapılır.
    - Çağrı hız kapısından (_rate_gate) geçer.
    - Hata durumunda backoff uygulanır.
    - Çıktı 8192 token sınırına takılırsa parça ikiye bölünüp özyinelemeli çevrilir (truncation guard).
    """
    if cancel_event is not None and cancel_event.is_set():
        return ""

    clean_text = text.strip()
    if not clean_text:
        return ""

    # 1) Önbellek Kontrolü (0ms, 0 tokens) - Hedef dil ve sözlük korumalı
    cached = _get_translation_from_cache(clean_text, target_lang, glossary)
    if cached is not None:
        print(f"--- Çeviri Önbellek HIT! MD5: {hashlib.md5(clean_text.encode()).hexdigest()[:8]}... ---")
        return cached

    # Dinamik sistem promptunu oluştur
    prompt = (
        _get_ceviri_system(target_lang, glossary)
        + "\n\n--- ÇEVRİLECEK METİN ---\n"
        + clean_text
        + "\n\n--- ÇEVİRİ (Markdown) ---\n"
    )

    resp = None
    son_hata = None
    # 5 deneme hakkı vererek havuzdaki alternatif anahtarların denenmesine imkan tanıyoruz
    for attempt in range(5):
        if cancel_event is not None and cancel_event.is_set():
            return ""
        
        # Rotasyonlu veya sabit anahtarı belirle
        if using_user_key:
            active_key = _tek_key(api_key)
            if not active_key:
                raise ValueError("Geçerli bir kullanıcı API anahtarı bulunamadı.")
        else:
            try:
                active_key = _api_key_pool.get_key()
            except Exception as e:
                son_hata = e
                break

        # Dinamik olarak en akıllı modelimiz Gemini 3.5 Flash ile LLM nesnesini kur
        active_llm = _make_llm(
            active_key, temperature=0.2,
            max_output_tokens=_CEVIRI_MAX_TOKENS, timeout=_CEVIRI_CALL_TIMEOUT,
            model_name="gemini-3.5-flash",
        )

        try:
            # Hız sınırlayıcı (BYOK ise 0.2sn, ücretsizse 4.5sn bekletir)
            _rate_gate(active_key, using_user_key)
            
            resp = _invoke_with_timeout(active_llm, prompt, _CEVIRI_CALL_WALL)
            break
        except concurrent.futures.TimeoutError:
            son_hata = TimeoutError("Çeviri çağrısı zaman aşımına uğradı.")
            if not using_user_key:
                _api_key_pool.set_cooldown(active_key, 10.0)  # kısa soğuma
            time.sleep(2 ** (attempt + 1))
        except Exception as e:
            son_hata = e
            if _kota_hatasi_mi(str(e)):
                print(f"--- Çeviri Kota Sınırı (429)! Anahtar: {active_key[:8]}... Hata: {e} ---")
                if not using_user_key:
                    # Havuz anahtarını 60 saniye soğumaya al
                    _api_key_pool.set_cooldown(active_key, 60.0)
                    # Diğer anahtara hızlıca geçmek için uykuyu kısa tut
                    time.sleep(0.5)
                else:
                    if len(user_keys) > 1:
                        # Birden fazla kullanıcı anahtarı varsa hızlıca sıradakine geç
                        time.sleep(0.5)
                    else:
                        time.sleep(15 * (attempt + 1))
            else:
                if not using_user_key:
                    _api_key_pool.set_cooldown(active_key, 15.0)
                time.sleep(2 ** (attempt + 1))

    if resp is None:
        raise son_hata if son_hata else RuntimeError("Çeviri çağrısı başarısız oldu.")

    cikti = _extract_text(resp.content).strip()

    # Truncation guard: kesildiyse ve hâlâ bölünebiliyorsa, ikiye bölüp ayrı ayrı çevir
    if _is_truncated(resp) and depth < _CEVIRI_MAX_SPLIT_DEPTH:
        print(f"--- Çeviri Kesildi (Truncated)! İkiye bölünüyor (Derinlik: {depth + 1})... ---")
        h1, h2 = _split_text_half(clean_text)
        if h1 and h2:
            p1 = _translate_chunk_safe(h1, None, api_key, cancel_event, target_lang, glossary, using_user_key, depth + 1)
            p2 = _translate_chunk_safe(h2, None, api_key, cancel_event, target_lang, glossary, using_user_key, depth + 1)
            cikti = (p1 + "\n\n" + p2).strip()

    # Başarılı çeviriyi önbelleğe kaydet
    if cikti:
        _save_translation_to_cache(clean_text, cikti, target_lang, glossary)

    return cikti


def _turkce_pdf_uret(birimler: list, baslik: str) -> bytes:
    """Çeviri birimlerinden (her biri {"md", "images"}) biçimli Türkçe PDF üretir.

    Başlıklar (#/##/###), maddeler (-, 1.), tablolar ve **kalın** korunur; her birimin
    sonuna orijinal PDF'ten çıkarılan görseller gömülür. Türkçe karakterler için Vera fontu.
    """
    import html
    import re as _re
    import reportlab
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.lib.utils import ImageReader
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle, Image, PageBreak,
    )
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    # Geniş Unicode kapsamlı font ara (Δ, →, ∫, ∑ vb. için). Sistemde bulduğumuzu kullan,
    # bulamazsak reportlab'ın bundle ettiği Vera'ya düş (Türkçe OK ama Yunan capitals/oklar yok).
    fdir = os.path.join(os.path.dirname(reportlab.__file__), "fonts")
    _SYS_FONT_PAIRS = [
        # Windows
        ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
        ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
        # Linux
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
        # macOS
        ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
        ("/System/Library/Fonts/Supplemental/Arial.ttf",
         "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ]
    _wide_reg = _wide_bold = None
    for reg, bold in _SYS_FONT_PAIRS:
        if os.path.exists(reg):
            _wide_reg = reg
            _wide_bold = bold if (bold and os.path.exists(bold)) else reg
            break

    try:
        pdfmetrics.getFont("Body")
    except Exception:
        if _wide_reg:
            try:
                pdfmetrics.registerFont(TTFont("Body", _wide_reg))
                pdfmetrics.registerFont(TTFont("Body-Bold", _wide_bold))
            except Exception:
                _wide_reg = None
        if not _wide_reg:
            pdfmetrics.registerFont(TTFont("Body", os.path.join(fdir, "Vera.ttf")))
            pdfmetrics.registerFont(TTFont("Body-Bold", os.path.join(fdir, "VeraBd.ttf")))
    BODY_FONT = "Body"
    BOLD_FONT = "Body-Bold"

    # ─── LaTeX → unicode: basit formülleri okunabilir hale getir ───────
    _LATEX_REPL = [
        # Oklar — \Rightarrow (⇒) bazı Arial sürümlerinde yok, ASCII'ye düşürüyoruz
        (r"\\rightarrow", "→"), (r"\\leftarrow", "←"), (r"\\to\b", "→"),
        (r"\\Rightarrow", "=>"), (r"\\Leftarrow", "<="), (r"\\Leftrightarrow", "<=>"),
        # Karşılaştırma / aritmetik
        (r"\\approx", "≈"), (r"\\times", "×"), (r"\\div", "÷"),
        (r"\\leq", "≤"), (r"\\geq", "≥"), (r"\\neq", "≠"),
        (r"\\pm", "±"), (r"\\infty", "∞"), (r"\\cdot", "·"),
        # Operatörler
        (r"\\sum", "∑"), (r"\\prod", "∏"), (r"\\int", "∫"), (r"\\partial", "∂"),
        (r"\\nabla", "∇"),
        # Yunan büyük harfler (Sigma, Omega vs.)
        (r"\\Delta", "Δ"), (r"\\Sigma", "Σ"), (r"\\Omega", "Ω"), (r"\\Phi", "Φ"),
        (r"\\Pi", "Π"), (r"\\Theta", "Θ"), (r"\\Lambda", "Λ"), (r"\\Gamma", "Γ"),
        (r"\\Xi", "Ξ"), (r"\\Psi", "Ψ"),
        # Yunan küçük harfler
        (r"\\alpha", "α"), (r"\\beta", "β"), (r"\\gamma", "γ"), (r"\\delta", "δ"),
        (r"\\epsilon", "ε"), (r"\\zeta", "ζ"), (r"\\eta", "η"), (r"\\theta", "θ"),
        (r"\\iota", "ι"), (r"\\kappa", "κ"), (r"\\lambda", "λ"), (r"\\mu", "μ"),
        (r"\\nu", "ν"), (r"\\xi", "ξ"), (r"\\pi", "π"), (r"\\rho", "ρ"),
        (r"\\sigma", "σ"), (r"\\tau", "τ"), (r"\\upsilon", "υ"),
        (r"\\phi", "φ"), (r"\\chi", "χ"), (r"\\psi", "ψ"), (r"\\omega", "ω"),
    ]
    _SUP = {
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
        "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
        "+": "⁺", "-": "⁻", "n": "ⁿ", "i": "ⁱ",
    }

    def _to_sup(s: str) -> str:
        return "".join(_SUP.get(c, c) for c in s)

    def _clean_latex(text: str) -> str:
        if not text or "\\" not in text and "$" not in text and "^" not in text:
            return text
        for pat, repl in _LATEX_REPL:
            text = _re.sub(pat, repl, text)
        # $$x$$ ve $x$ kabuğunu kaldır (içeriği koru)
        text = _re.sub(r"\$\$(.*?)\$\$", r"\1", text, flags=_re.DOTALL)
        text = _re.sub(r"\$(.+?)\$", r"\1", text)
        # \text{xxx} → xxx
        text = _re.sub(r"\\text\s*\{([^}]+)\}", r"\1", text)
        # 2^{32}, x^n → unicode üst simge
        text = _re.sub(r"\^\{?([0-9+\-ni]+)\}?", lambda m: _to_sup(m.group(1)), text)
        return text

    def inline(s: str) -> str:
        s = _clean_latex(s)                                # önce LaTeX'i temizle
        s = html.escape(s)
        s = _re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)   # **kalın**
        s = _re.sub(r"`(.+?)`", r'<font name="Courier" color="#c7254e"><b>\1</b></font>', s)   # `code` → Courier + Renkli + Kalın
        return s

    title_st = ParagraphStyle("T", fontName=BOLD_FONT, fontSize=18, leading=22, spaceAfter=16)
    h1_st = ParagraphStyle("H1", fontName=BOLD_FONT, fontSize=15, leading=20, spaceBefore=12, spaceAfter=8, keepWithNext=True)
    h2_st = ParagraphStyle("H2", fontName=BOLD_FONT, fontSize=13, leading=18, spaceBefore=10, spaceAfter=6, keepWithNext=True)
    h3_st = ParagraphStyle("H3", fontName=BOLD_FONT, fontSize=11.5, leading=16, spaceBefore=8, spaceAfter=5, keepWithNext=True)
    body_st = ParagraphStyle("B", fontName=BODY_FONT, fontSize=11, leading=16, spaceAfter=7)
    bullet_st = ParagraphStyle("L", fontName=BODY_FONT, fontSize=11, leading=16, spaceAfter=4, leftIndent=16)
    cell_st = ParagraphStyle("C", fontName=BODY_FONT, fontSize=9, leading=12)
    cell_head_st = ParagraphStyle("CH", fontName=BOLD_FONT, fontSize=9, leading=12)
    # Kod blokları: monospace (Courier) + gri zemin + kenarlık → terminal/komut kutuları korunur
    code_st = ParagraphStyle(
        "Code", fontName="Courier", fontSize=9, leading=12,
        leftIndent=8, rightIndent=8,
        backColor=colors.HexColor("#f4f4f4"),
        borderColor=colors.HexColor("#cccccc"), borderWidth=0.5, borderPadding=6,
        textColor=colors.HexColor("#222222"),
        spaceBefore=6, spaceAfter=8,
    )

    icerik_genislik = A4[0] - 4 * cm  # sayfa eni - sol/sağ marj

    def _satir_hucreleri(satir: str):
        return [c.strip() for c in satir.strip().strip("|").split("|")]

    def _ayrac_mi(satir: str) -> bool:
        s = satir.strip()
        return bool(s.startswith("|") and _re.match(r"^\|?[\s:|-]+\|?$", s) and "-" in s)

    def _tablo_yap(satirlar):
        rows = [_satir_hucreleri(s) for s in satirlar]
        kolon = max(len(r) for r in rows)
        data = []
        for ri, r in enumerate(rows):
            r = r + [""] * (kolon - len(r))
            st = cell_head_st if ri == 0 else cell_st
            data.append([Paragraph(inline(c), st) for c in r])
            
        # Akıllı sütun genişliği hesaplama: sütunların içerik uzunluğuna göre genişlik paylaştır
        # En az 1.5 cm genişlik sağla, LayoutError engelle
        min_col_w = 1.5 * cm
        col_widths = []
        total_chars = []
        for col_idx in range(kolon):
            max_len = 1
            for row in rows:
                if col_idx < len(row):
                    max_len = max(max_len, len(row[col_idx]))
            total_chars.append(max_len)
        
        total_sum = sum(total_chars)
        for col_idx in range(kolon):
            w = icerik_genislik * (total_chars[col_idx] / total_sum)
            w = max(w, min_col_w)
            col_widths.append(w)
            
        # Toplam genişlik içeriği çok aşıyorsa orantılı küçült, ancak min_col_w'yi korumaya çalış
        total_w = sum(col_widths)
        if total_w > icerik_genislik and kolon > 1:
            col_widths = [max(min_col_w, w * (icerik_genislik / total_w)) for w in col_widths]
            
        tbl = Table(data, colWidths=col_widths, repeatRows=1, splitByRow=1)
        tbl.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        return tbl

    story = [Paragraph(html.escape(baslik), title_st), Spacer(1, 4)]

    def _md_ekle(markdown_metin: str):
        lines = markdown_metin.split("\n")
        i = 0
        while i < len(lines):
            t = lines[i].strip()

            # ── Kod bloğu: ```lang ... ``` ── (tablodan ÖNCE; içeride | olabilir)
            if t.startswith("```"):
                i += 1
                kod = []
                while i < len(lines) and not lines[i].strip().startswith("```"):
                    kod.append(lines[i])
                    i += 1
                if i < len(lines):
                    i += 1  # kapanış ```
                if kod:
                    raw_lines = [html.escape(l) for l in kod]
                    if not raw_lines:
                        raw_lines = [""]
                    
                    # Satır uzunluğuna göre font boyutunu dinamik ayarla (Taşmayı önlemek için)
                    max_line_len = max(len(l) for l in raw_lines)
                    dynamic_code_st = code_st
                    if max_line_len > 70:
                        new_size = max(6.0, 9.0 - (max_line_len - 70) * 0.08)
                        dynamic_code_st = ParagraphStyle(
                            "DynCode", parent=code_st,
                            fontSize=new_size, leading=new_size + 3,
                            backColor=None, borderColor=None, borderWidth=0, borderPadding=0 # Table içinde olacağı için arka planı kaldırıyoruz
                        )
                    else:
                        dynamic_code_st = ParagraphStyle(
                            "DynCode", parent=code_st,
                            backColor=None, borderColor=None, borderWidth=0, borderPadding=0 # Table içinde olacağı için arka planı kaldırıyoruz
                        )
                    
                    # Her satırı monospace Paragraph nesnesine çeviriyoruz
                    # Boşlukların ve girintilerin kaybolmaması için non-breaking space (char 160 / &nbsp;) ile değiştiriyoruz
                    table_data = []
                    for rl in raw_lines:
                        # Girintileri (indentation) korumak için boşlukları &nbsp; yapıyoruz
                        spaced_line = rl.replace(" ", "&nbsp;").replace("\t", "&nbsp;&nbsp;&nbsp;&nbsp;")
                        if not spaced_line.strip():
                            spaced_line = "&nbsp;"
                        table_data.append([Paragraph(spaced_line, dynamic_code_st)])
                    
                    try:
                        # Kod bloğunu sayfalar arasında bölünebilir tek sütunlu bir tabloya sarıyoruz
                        code_table = Table(table_data, colWidths=[icerik_genislik], splitByRow=1)
                        code_table.setStyle(TableStyle([
                            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f4f4f4")),
                            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("LEFTPADDING", (0, 0), (-1, -1), 6),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                            ("TOPPADDING", (0, 0), (-1, -1), 2),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                        ]))
                        story.append(Spacer(1, 4))
                        story.append(code_table)
                        story.append(Spacer(1, 6))
                    except Exception:
                        # Hata durumunda fallback olarak düz metin bas
                        for s in kod:
                            story.append(Paragraph(html.escape(s), body_st))
                continue

            # Markdown tablosu
            if t.startswith("|") and i + 1 < len(lines) and _ayrac_mi(lines[i + 1]):
                blok = [t]
                j = i + 2
                while j < len(lines) and lines[j].strip().startswith("|"):
                    blok.append(lines[j].strip())
                    j += 1
                try:
                    story.append(Spacer(1, 4))
                    story.append(_tablo_yap(blok))
                    story.append(Spacer(1, 8))
                except Exception:
                    for s in blok:
                        story.append(Paragraph(inline(s), body_st))
                i = j
                continue
            if not t:
                story.append(Spacer(1, 5)); i += 1; continue
            if _re.match(r"^([-*_]\s*){3,}$", t):
                story.append(Spacer(1, 8)); i += 1; continue
            hm = _re.match(r"^(#{1,6})\s+(.*)$", t)
            if hm:
                lvl = len(hm.group(1))
                st = h1_st if lvl <= 1 else (h2_st if lvl == 2 else h3_st)
                story.append(Paragraph(inline(hm.group(2)), st)); i += 1; continue
            if _re.match(r"^[-*]\s+", t):
                story.append(Paragraph("•&nbsp;" + inline(_re.sub(r"^[-*]\s+", "", t)), bullet_st)); i += 1; continue
            nm = _re.match(r"^(\d+)\.\s+(.*)$", t)
            if nm:
                story.append(Paragraph(f"{nm.group(1)}.&nbsp;" + inline(nm.group(2)), bullet_st)); i += 1; continue
            story.append(Paragraph(inline(t), body_st)); i += 1

    def _gorsel_ekle(png_bytes: bytes):
        try:
            ir = ImageReader(BytesIO(png_bytes))
            iw, ih = ir.getSize()
            if iw <= 0 or ih <= 0:
                return
            w = min(icerik_genislik, float(iw))
            h = w * ih / iw
            max_h = A4[1] - 6 * cm
            if h > max_h:
                h = max_h
                w = h * iw / ih
            story.append(Spacer(1, 6))
            story.append(Image(BytesIO(png_bytes), width=w, height=h))
            story.append(Spacer(1, 8))
        except Exception:
            pass

    # [[GORSEL_N]] yer tutucularını yakalayıp metin/görseli orijinal sırayla yerleştir.
    # N, BİRİMİN images listesinin 1-tabanlı indeksidir.
    _GORSEL_RE = _re.compile(r"\[\[GORSEL_(\d+)\]\]")
    for birim in birimler:
        md = (birim.get("md", "") or "")
        images = birim.get("images", []) or []
        if not md.strip():
            # Sadece görsel barındıran (örn. taranmış) sayfa
            for png in images:
                _gorsel_ekle(png)
            continue

        used = set()
        pos = 0
        for m in _GORSEL_RE.finditer(md):
            before = md[pos:m.start()]
            if before.strip():
                _md_ekle(before)
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(images) and idx not in used:
                _gorsel_ekle(images[idx])
                used.add(idx)
            pos = m.end()
        after = md[pos:]
        if after.strip():
            _md_ekle(after)

        # Güvenlik ağı: AI yer tutucuyu düşürmüşse, kalan görselleri sona ekle
        for i, png in enumerate(images):
            if i not in used:
                _gorsel_ekle(png)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=2 * cm, bottomMargin=2 * cm, leftMargin=2 * cm, rightMargin=2 * cm,
        title=baslik,
    )
    doc.build(story)
    return buf.getvalue()


def _grup_birimler(birimler: list, max_chars: int = 6000) -> list:
    """Sayfa-bazlı döküman birimlerini karakter uzunluğuna göre gruplayarak tek bir çeviri
    birimine dönüştürür. Bu sayede API istek sayısı büyük ölçüde azalır ve hız artar.
    
    Metin birleşirken sayfa içindeki [[GORSEL_N]] etiketleri, birleşik görsel listesindeki
    yeni indislerine göre otomatik güncellenir.
    """
    import re
    grouped = []
    
    current_text_parts = []
    current_images = []
    current_char_count = 0
    
    for b in birimler:
        text = b.get("text", "")
        images = b.get("images", []) or []
        page_char_len = len(text)
        
        # Eğer mevcut birikmiş metin varsa VE (yeni sayfa uzunluğu sınırı aşıyorsa VEYA yeni sayfa boş/salt görsel ise)
        # elimizdekileri paketleyip listeye ekleyelim.
        if current_text_parts and (current_char_count + page_char_len > max_chars or not text.strip()):
            grouped.append({
                "text": "\n\n".join(current_text_parts),
                "images": current_images
            })
            current_text_parts = []
            current_images = []
            current_char_count = 0
            
        # Sayfadaki görselleri birleştirmeden önce [[GORSEL_N]] indis kaydırma işlemini uygula
        adjusted_text = text
        L = len(current_images)
        if L > 0 and text.strip():
            def repl(match):
                idx = int(match.group(1))
                return f"[[GORSEL_{idx + L}]]"
            adjusted_text = re.sub(r"\[\[GORSEL_(\d+)\]\]", repl, text)
            
        if adjusted_text.strip():
            current_text_parts.append(adjusted_text.strip())
            current_char_count += len(adjusted_text.strip())
            
        current_images.extend(images)
        
        # Salt görsel sayfaları tek başına gönder (önden birikmiş görsel yoksa ve metinsizse)
        if not text.strip() and current_images:
            grouped.append({
                "text": "",
                "images": current_images
            })
            current_text_parts = []
            current_images = []
            current_char_count = 0
            
    if current_text_parts or current_images:
        grouped.append({
            "text": "\n\n".join(current_text_parts),
            "images": current_images
        })
        
    return grouped


def _run_ceviri_generation(
    job_id: str,
    file_bytes: bytes,
    filename: str,
    api_key: str,
    client_ip: Optional[str],
    using_user_key: bool,
    session_key: str,
    target_lang: str = "tr",
    glossary: str = "",
) -> None:
    """PDF'i dinamik gruplar halinde paralel Türkçe/İngilizce/Almanca/vb. dile çevirir, PDF üretir, oturuma ekler.

    Dayanıklılık:
    - Dinamik gruplama (istek sayısı %80 az)
    - ThreadPoolExecutor paralel çeviri motoru (hız 4-8 kat artış)
    - API Key Rotasyonu + 429 hata anında thread-safe soğuma yönetimi
    - Satır/Paragraf önbelleği (MD5 cache ile mükerrer çevirilerde 0ms süre)
    - Orijinal sıralama koruması (indeks bazlı birleştirme)
    """
    try:
        with _ceviri_cancel_events_lock:
            cancel_event = _ceviri_cancel_events.get(job_id)

        # 1) Sayfaları çıkar ve dinamik gruplara böl (~6000 karakterlik bölümler)
        ham_birimler = _ceviri_birimleri(file_bytes, filename, api_key)
        dolu_sayfalar = [b for b in ham_birimler if (b["text"].strip() or b["images"])]
        if not dolu_sayfalar:
            _cjob_set(
                job_id, status="error",
                error="Dosyadan metin çıkarılamadı (boş veya okunamayan içerik).",
                finished_at=time.time(),
            )
            return

        dolu = _grup_birimler(dolu_sayfalar, max_chars=6000)
        _cjob_set(job_id, total=len(dolu))

        # Eşzamanlılığı yönetecek thread-safe yapılar
        progress_lock = threading.Lock()
        completed_count = 0
        kota_bitti = False
        recovery_denendi = False
        KOTA_MD = "\n\n_[Günlük/dakikalık API kotası dolduğu için bu bölüm çevrilemedi.]_\n\n"

        # Worker thread fonksiyonu
        def translate_worker(idx: int, chunk: dict) -> dict:
            nonlocal completed_count, kota_bitti, recovery_denendi
            
            text_to_translate = (chunk.get("text") or "").strip()
            images = chunk.get("images", []) or []
            md = ""
            
            if not text_to_translate:
                # Salt görsel içeren sayfa/grup
                with progress_lock:
                    completed_count += 1
                    _cjob_set(job_id, progress=completed_count)
                return {"idx": idx, "md": "", "images": images, "success": True, "real": False}
                
            # Kota tamamen tükendiyse ve kurtarma başarısız olduysa doğrudan hata bas
            if kota_bitti and recovery_denendi:
                with progress_lock:
                    completed_count += 1
                    _cjob_set(job_id, progress=completed_count)
                return {"idx": idx, "md": KOTA_MD, "images": images, "success": False, "real": False}
                
            # Kota bitme durumunda ilk kurtarma denemesi
            if kota_bitti and not recovery_denendi:
                with progress_lock:
                    if not recovery_denendi:
                        recovery_denendi = True
                        print(f"--- CEVIRI: Kota sınırı sonrası 60s cooldown beklemesi başlatılıyor (Grup {idx+1})... ---")
                        # İptal edilirse hızlı tepki vermek için 1'er saniyelik adımlarla bekle
                        for _ in range(60):
                            if cancel_event is not None and cancel_event.is_set():
                                return {"idx": idx, "md": "_[Çeviri İptal Edildi]_", "images": images, "success": False, "real": False}
                            time.sleep(1)
                            
            try:
                if cancel_event is not None and cancel_event.is_set():
                    return {"idx": idx, "md": "_[Çeviri İptal Edildi]_", "images": images, "success": False, "real": False}
                
                # Çeviriyi rotasyon ve önbellek korumasıyla güvenle çalıştır
                tr = _translate_chunk_safe(text_to_translate, None, api_key, cancel_event, target_lang, glossary, using_user_key)
                if tr:
                    md = tr.strip()
                    success = True
                    real = True
                    kota_bitti = False  # Başarılı ise kota bayrağını temizle
                else:
                    md = "_[Bu bölüm boş döndü.]_"
                    success = False
                    real = False
            except Exception as e:
                print(f"--- CEVIRI: Grup {idx+1} çeviri hatası: {e} ---")
                success = False
                real = False
                if _kota_hatasi_mi(str(e)):
                    kota_bitti = True
                    md = KOTA_MD
                else:
                    md = "\n\n_[Bu bölüm çevrilemedi.]_\n\n"
                    
            with progress_lock:
                completed_count += 1
                _cjob_set(job_id, progress=completed_count)
                
            return {"idx": idx, "md": md, "images": images, "success": success, "real": real}

        # Eşzamanlı worker sayısını belirle
        # Ücretsiz anahtar kullanılıyorsa ağ gecikmelerini aşmak için 4, kullanıcı anahtarı ise 8 paralel worker
        max_workers = 8 if using_user_key else 4
        
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(translate_worker, idx, chunk) for idx, chunk in enumerate(dolu)]
            for fut in concurrent.futures.as_completed(futures):
                if cancel_event is not None and cancel_event.is_set():
                    _cjob_set(job_id, status="cancelled", finished_at=time.time())
                    return
                results.append(fut.result())

        if cancel_event is not None and cancel_event.is_set():
            _cjob_set(job_id, status="cancelled", finished_at=time.time())
            return

        # Sonuçları orijinal sırasına göre diz
        results.sort(key=lambda x: x["idx"])
        
        cevrilen_birimler = []
        basarisiz = 0
        gercek = 0
        toplam_gorsel = 0
        for r in results:
            cevrilen_birimler.append({"md": r["md"], "images": r["images"]})
            if not r["success"]:
                basarisiz += 1
            if r["real"]:
                gercek += 1
            toplam_gorsel += len(r["images"])

        # Hiçbir gerçek çıktı yoksa (ne çeviri ne görsel) → hata
        if gercek == 0 and toplam_gorsel == 0:
            _cjob_set(
                job_id, status="error",
                error=(_KOTA_MESAJI if kota_bitti else "Çeviri üretilemedi, lütfen tekrar deneyin."),
                finished_at=time.time(),
            )
            return

        base = os.path.splitext(os.path.basename(filename))[0]
        suffix = target_lang.upper()
        tr_filename = f"{base}-{suffix}.pdf"
        pdf_bytes = _turkce_pdf_uret(cevrilen_birimler, base)

        # Sonucu DİSKE yaz — sunucu restart sonrası bile kalıcı
        pdf_path = CEVIRI_CACHE_DIR / f"{job_id}.pdf"
        try:
            pdf_path.write_bytes(pdf_bytes)
            try:
                from storage_servisi import sync_ceviri_to_s3
                sync_ceviri_to_s3(pdf_path, job_id, "pdf")
            except Exception as e:
                print(f"⚠️ S3 Çeviri PDF Yükleme Hatası: {e}")
        except Exception as e:
            print(f"--- CEVIRI: PDF diske yazılamadı: {e} ---")

        # Türkçe PDF'i oturumun aktif dosyalarına ekle
        try:
            tr_hash = hash_bytes(pdf_bytes)
            session = _get_session(session_key)
            if not any(f["hash"] == tr_hash for f in session["active_files"]):
                chars = _ensure_file_cached(pdf_bytes, tr_filename, tr_hash, api_key)
                af = session["active_files"]
                if len(af) >= MAX_FILES:
                    af.pop(0)  # Limiti aşınca en eskiyi at
                af.append({"name": tr_filename, "hash": tr_hash, "chars": chars})
                _rebuild_merged_retriever(api_key, session)
                _save_session(session_key, session)
        except Exception as e:
            print(f"--- CEVIRI: Türkçe PDF oturuma eklenemedi: {e} ---")

        _record_usage(client_ip)
        uyari = None
        if basarisiz > 0:
            if kota_bitti:
                uyari = (
                    f"API kotası doldu — {basarisiz}/{len(dolu)} bölüm çevrilemedi. "
                    "Yarın tekrar dene veya ayarlardan kendi API key'ini ekle."
                )
            else:
                uyari = f"{basarisiz} bölüm çevrilemedi ve dökümanda işaretlendi (kısmi çeviri)."

        # Job meta'sını diske yaz
        try:
            json_file = CEVIRI_CACHE_DIR / f"{job_id}.json"
            json_file.write_text(
                json.dumps({
                    "status": "done", "filename": tr_filename, "uyari": uyari,
                    "progress": len(dolu), "total": len(dolu), "finished_at": time.time(),
                }),
                encoding="utf-8",
            )
            try:
                from storage_servisi import sync_ceviri_to_s3
                sync_ceviri_to_s3(json_file, job_id, "json")
            except Exception as e:
                print(f"⚠️ S3 Çeviri JSON Yükleme Hatası: {e}")
        except Exception:
            pass

        _cjob_set(
            job_id, status="done", pdf_path=str(pdf_path), filename=tr_filename,
            uyari=uyari, finished_at=time.time(),
        )

    except Exception as e:
        print(f"--- CEVIRI JOB ERROR: {job_id[:8]} — {e} ---")
        mesaj = _KOTA_MESAJI if _kota_hatasi_mi(str(e)) else str(e)
        _cjob_set(job_id, status="error", error=mesaj, finished_at=time.time())


def _split_into_sentences(text: str) -> list[str]:
    import re
    # Nokta, soru işareti, ünlemden sonra gelen boşluğu yakalar, ancak Türkçe kısaltmaları atlar.
    sentence_end = re.compile(
        r'(?<!\b[dD]r)(?<!\b[pP]rof)(?<!\b[vV]b)(?<!\b[mM]ah)(?<!\b[sS]ok)(?<!\b[cCdD]ed)(?<!\b[vVeEsS]b)(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜa-zçğıöşü])'
    )
    sentences = sentence_end.split(text)
    if len(sentences) == 1:
        sentences = re.split(r'(?<=[.!?])\s+', text)
    return [s.strip() for s in sentences if s.strip()]


def _calculate_turkish_readability(text: str):
    import re
    sentences = _split_into_sentences(text)
    num_sentences = max(len(sentences), 1)
    
    words = text.split()
    num_words = max(len(words), 1)
    
    # Türkçe sesli harfler
    vowels = "aeıioöuüAEIİOÖUÜ"
    num_syllables = sum(1 for char in text if char in vowels)
    num_syllables = max(num_syllables, 1)
    
    # Ateşman İndeksi
    score = 198.725 - 2.610 * (num_syllables / num_words) - 29.585 * (num_words / num_sentences)
    score = max(0.0, min(100.0, score))
    
    if score >= 90:
        label = "Çok Kolay (İlkokul Seviyesi)"
    elif score >= 70:
        label = "Kolay (Ortaokul Seviyesi)"
    elif score >= 50:
        label = "Orta (Lise Seviyesi)"
    elif score >= 30:
        label = "Zor (Akademik/Lisans)"
    else:
        label = "Çok Zor (Akademik/Uzmanlık)"
        
    return round(score, 1), label


def _statik_skor_hesapla(txt: str) -> float:
    import math
    sents = _split_into_sentences(txt)
    if not sents:
        return 0.0
    
    w_counts = [len(s.split()) for s in sents if s.strip()]
    if not w_counts:
        return 0.0
        
    avg_w = sum(w_counts) / len(w_counts)
    var_w = sum((x - avg_w) ** 2 for x in w_counts) / len(w_counts)
    std_w = math.sqrt(var_w)
    
    # 1) Burstiness (Cümle yapısı monotonluğu): Standart sapma düştükçe AI olasılığı artar
    # Kalibre edilmiş dengeli eşikler
    b_score = 0.0
    if std_w < 3.5:
        b_score = 25.0
    elif std_w < 5.5:
        b_score = 15.0
    elif std_w < 7.5:
        b_score = 5.0
        
    # 2) Ortalama Kelime Uzunluğu (Akademik/Bilimsel Kelime Yoğunluğu)
    # Akademik insan yazımını korumak için eşikler yükseltildi
    long_words = [w for w in txt.split() if len(w) > 3]
    avg_word_len = sum(len(w) for w in long_words) / len(long_words) if long_words else 0
    
    w_len_score = 0.0
    if avg_word_len > 8.8:
        w_len_score = 20.0
    elif avg_word_len > 8.0:
        w_len_score = 10.0
    elif avg_word_len > 7.2:
        w_len_score = 5.0
        
    # 3) LLM & Akademik & İnsansılaştırılmış (Conversational Bypass) Kelimeler yoğunluğu
    llm_words = [
        "şüphesiz", "adeta", "bununla birlikte", "bunun yanı sıra", 
        "özellikle belirtmek gerekir ki", "temel rol oynamaktadır", 
        "büyük önem taşımaktadır", "bir diğer önemli nokta ise", 
        "vurgulamak gerekir ki", "hedeflenmektedir", "amaçlanmaktadır",
        "önem arz etmektedir", "bu doğrultuda", "bu kapsamda",
        "söz konusu", "göz önünde bulundurulduğunda", "önem taşımaktadır",
        "sağlamaktadır", "göstermektedir", "gelişmektedir", "gerekmektedir",
        "önem taşır", "büyük bir", "oldukça", "önemlidir", "fizyolojik",
        "yapısal", "süreçte", "olarak tanımlanan", "neden olur", "yol açar",
        "rol oynamaktadır", "ciddi bir", "doğrudan", "bütün", "gibi",
        "sekonder", "sistemik", "patolojiyi", "dengeli", "sağlıklı",
        "kaliteli", "hayati", "aktif", "temel", "sürecinde", "yoğun",
        "yetersiz", "olması", "durumunda",
        # İnsansılaştırılmış (Conversational/Sincere Bypass) LLM kalıpları
        "ne biliyor musun", "biliyor musun", "işte tam da", "tam da bu",
        "hayal et", "düşün", "gelin birlikte", "bir anlığına", "gerçek şu ki",
        "aslında", "kaçırdığımız", "ıskaladığımız", "yapamaz işte", "belki de",
        "asıl mesele", "şöyle bir", "kesinlikle", "bir bilgisayar", "doğrudan doğruya",
        "tamamen bir", "bunun yerine", "göz ardı etmemek", "asla", "kendi kabuğuna",
        "gerçekten çok", "büyük bir detay", "o an ne", "ulaşmak", "özel hissettiren",
        "hiçbir zaman", "tam da bu yüzden"
    ]
    
    txt_lower = txt.lower()
    matches = 0
    for lw in llm_words:
        matches += txt_lower.count(lw)
        
    density = (matches / len(sents)) if len(sents) > 0 else 0
    
    d_score = 0.0
    if density > 1.5:
        d_score = 25.0
    elif density > 1.0:
        d_score = 15.0
    elif density > 0.6:
        d_score = 10.0
    elif density > 0.3:
        d_score = 5.0
        
    base = 5.0
    calculated = base + b_score + w_len_score + d_score
    # Eğer metin hem çok monoton hem de çok akademik/LLM kelimesi içeriyorsa skoru en tepeye vuruyoruz
    if b_score >= 15.0 and d_score >= 15.0:
        calculated = max(calculated, 96.0)
        
    return min(98.0, max(2.0, calculated))


# ─── Yapay Zeka Analizörü (AI & Originality Detector) ───────────────────
_detector_pipeline = None
_detector_lock = threading.Lock()

def _get_detector_pipeline():
    global _detector_pipeline
    with _detector_lock:
        if _detector_pipeline is None:
            from transformers import pipeline
            print("--- RoBERTa AI Detector model loading... ---")
            _detector_pipeline = pipeline(
                "text-classification", 
                model="openai-community/roberta-base-openai-detector"
            )
            print("--- RoBERTa AI Detector model loaded successfully! ---")
        return _detector_pipeline


class AnalizIstegi(BaseModel):
    metin: Optional[str] = None


@app.post("/api/v1/yapay-zeka-analiz")
async def yapay_zeka_analiz_endpoint(
    istek: Optional[AnalizIstegi] = None,
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Oturumdaki aktif dökümanın metnini veya gönderilen ham metni AI taramasından geçirir.
    
    Yüksek doğruluk ve Türkçe desteği için öncelikle Gemini LLM tabanlı üslup ve 
    özgünlük analizörü kullanılır. Gemini limit/hata durumunda yerel RoBERTa modeline 
    otomatik fallback yapar.
    """
    session = _get_session(_session_key(authorization, x_session_id))
    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    
    # Eğer istek ile ham metin gönderilmişse onu kullan, yoksa aktif dosya metnini çek
    tam_metin = ""
    if istek and istek.metin and istek.metin.strip():
        tam_metin = istek.metin
    else:
        tam_metin = _aktif_dosya_tam_metni(api_key, session)
        
    if not tam_metin.strip():
        raise HTTPException(
            status_code=400, 
            detail="Analiz edilecek metin bulunamadı. Lütfen bir dosya yükleyin veya doğrudan metin yapıştırın."
        )
        
    # Paragraflara ayır, normalize et ve temizle
    normalize_metin = tam_metin.replace("\r\n", "\n")
    raw_paragraphs = [p.strip() for p in normalize_metin.split("\n\n")]
    
    paragraphs = []
    for p in raw_paragraphs:
        lines = [line.strip() for line in p.split("\n") if line.strip()]
        if lines:
            paragraphs.append(" ".join(lines))
            
    # En az 10 karakter içeren anlamlı paragrafları filtrele
    valid_paragraphs = [p for p in paragraphs if len(p) >= 10]
    
    if not valid_paragraphs:
        raise HTTPException(
            status_code=400, 
            detail="Dosya içeriği analiz edilebilecek kadar anlamlı metin içermiyor."
        )
        
    # ── YÖNTEM 1: Öncelikli Gemini LLM Yapay Zeka Dedektörü (Türkçe ve Çok Dilli Uyum) ──
    try:
        gemini_success = False
        parsed_result = None
        user_keys = [k.strip() for k in api_key.split(",") if k.strip()] if api_key else []
        if not user_keys:
            user_keys = [""]
            
        for attempt_idx in range(len(user_keys)):
            try:
                # Her denemede en güncel aktif API anahtarını almak için _tek_key'i canlı çağırıyoruz.
                current_key = _tek_key(api_key)
                llm = _make_llm(current_key, temperature=0.1, json_mode=True)
                
                prompt = ChatPromptTemplate.from_messages([
                    ("system", (
                        "Sen gelişmiş bir Yapay Zeka Metin Tespit Analizörü ve Akademik Özgünlük Dedektörüsün (AI Writing, Plagiarism & Originality Detector).\n"
                        "Görevin, sana gönderilen Türkçe metin paragraflarını analiz ederek:\n"
                        "1. Yapay Zeka (LLM) tarafından yazılıp yazılmadığını cümle bazında ve bütünsel olarak tespit etmek.\n"
                        "2. Metnin intihal (plagiarism) riskini kendi bilgi dağarcığınla semantik olarak analiz edip intihal oranını ve eğer varsa muhtemel benzer internet / akademik kaynaklarını (URL ve başlık ile) belirlemek.\n"
                        "3. Metnin dil metriklerini (Perplexity ve Burstiness) ve okunabilirlik seviyesini Türkçe dil yapısına uygun şekilde değerlendirmek.\n\n"
                        "Analiz Kriterleri:\n"
                        "- Yapay Zeka Tespiti: Türkçe LLM yazım kalıplarına ve üslubuna karşı son derece hassas, katı ve şüpheci ol. Türkçe LLM'lerin en bariz şu belirtilerine odaklan:\n"
                        "  1. Aşırı Tekdüzelik ve Kusursuzluk: Sıfır imla/yazım hatası, aşırı düzenli ve monoton cümle uzunlukları (düşük burstiness).\n"
                        "  2. LLM Geçiş Kelimeleri ve Kalıpları: 'Şüphesiz', 'bununla birlikte', 'adeta', 'özellikle belirtmek gerekir ki', 'temel rol oynamaktadır', 'büyük önem taşımaktadır', 'bir diğer önemli nokta ise', 'vurgulamak gerekir ki', 'hedeflenmektedir', 'amaçlanmaktadır' gibi geçişlerin ve edilgen ifadelerin yoğun kullanımı.\n"
                        "  3. Ansiklopedik ve Didaktik Ton: Samimiyetten uzak, her şeyi kategorize etme ve tanımlama eğilimi.\n"
                        "  4. Yapay İnsansılık (Humanized / Sincere AI bypass): Metnin aşırı samimi, felsefi, duygusal veya sohbet havasında yazılmaya çalışılması (örneğin 'ne biliyor musun?', 'kaçırdığımız bir detay var', 'şimdi doğrudan konuşalım', 'bir bilgisayar bunu yapamaz işte' gibi yapay insani vurgular). ChatGPT/Claude gibi modeller insansı yazması istendiğinde bu tip abartılı duygusal aforizmalara, yapay iç dökmelere ve retorik sorulara sıkça başvurur. Bunları da yüksek yapay zeka oranı ile işaretle.\n"
                        "  Eğer metin bu kalıpları yoğun içeriyorsa ve insan yazımının getirdiği üslup dalgalanmalarından uzaksa veya yapay insansı aforizmalar barındırıyorsa, yapay zeka oranını %80-98 aralığında yüksek olarak tespit et.\n"
                        "- İntihal Analizi: Metindeki ifadelerin Vikipedi, akademik tezler, ders kitapları veya web sitelerinden kopyalanıp kopyalanmadığını veya aşırı benzeşip benzeşmediğini kontrol et.\n"
                        "- Perplexity (Karmaşıklık): Metindeki kelime seçimlerinin tahmin edilebilirliği. Düşük/Orta/Yüksek olarak belirt.\n"
                        "- Burstiness (Değişkenlik): Cümle uzunluklarının ve yapılarının çeşitliliği. Düşük/Orta/Yüksek olarak belirt.\n\n"
                        "SANA GELEN VERİ FORMATI:\n"
                        "Sana bir JSON listesi olarak paragraflar gönderilecektir.\n\n"
                        "SENİN DÖNECEĞİN ÇIKTI FORMATI:\n"
                        "Çıktıyı MUTLAKA sadece ve sadece aşağıdaki şablona uygun geçerli bir JSON objesi olarak dön, açıklama veya ek metin ekleme:\n"
                        "{{\n"
                        "  \"genel_yapay_zeka_orani\": 45.5,\n"
                        "  \"intihal_orani\": 12.0,\n"
                        "  \"intihal_kaynaklari\": [\n"
                        "    {{\n"
                        "      \"kaynak\": \"Kaynak başlığı veya yazar/site adı...\",\n"
                        "      \"url\": \"https://example.com/kaynak-adresi...\",\n"
                        "      \"benzerlik\": 85.0\n"
                        "    }}\n"
                        "  ],\n"
                        "  \"metrikler\": {{\n"
                        "    \"perplexity\": \"Orta\",\n"
                        "    \"perplexity_aciklama\": \"Metin akışında kelimeler yer yer öngörülebilir ama genel olarak doğal.\",\n"
                        "    \"burstiness\": \"Düşük\",\n"
                        "    \"burstiness_aciklama\": \"Cümle uzunlukları oldukça tekdüze, bu da yapay zeka şüphesini artırıyor.\",\n"
                        "    \"okunabilirlik_skor\": 65.2,\n"
                        "    \"okunabilirlik_etiket\": \"Orta (Lise Seviyesi)\"\n"
                        "  }},\n"
                        "  \"paragraflar\": [\n"
                        "    {{\n"
                        "      \"metin\": \"paragrafın tam metni...\",\n"
                        "      \"yapay_zeka_orani\": 65.0,\n"
                        "      \"insan_orani\": 35.0,\n"
                        "      \"cumleler\": [\n"
                        "        {{\n"
                        "          \"metin\": \"Paragrafın birinci cümlesi...\",\n"
                        "          \"yapay_zeka_orani\": 85.0\n"
                        "        }},\n"
                        "        {{\n"
                        "          \"metin\": \"Paragrafın ikinci cümlesi...\",\n"
                        "          \"yapay_zeka_orani\": 25.0\n"
                        "        }}\n"
                        "      ]\n"
                        "    }}\n"
                        "  ]\n"
                        "}}\n"
                        "Not: Paragrafların metinlerini kesinlikle bozma veya değiştirme, birebir koru. 'genel_yapay_zeka_orani' değerini paragrafların karakter uzunluklarına göre ağırlıklı ortalamasını alarak hesapla."
                    )),
                    ("human", "Analiz edilecek paragraflar listesi:\n{paragraflar_json}")
                ])
                
                chain = prompt | llm | StrOutputParser()
                paragraflar_input = json.dumps(valid_paragraphs, ensure_ascii=False)
                
                _rate_gate(current_key, using_user_key=using_user_key)
                response_text = chain.invoke({"paragraflar_json": paragraflar_input})
                parsed_result = json.loads(_extract_text(response_text))
                
                if "genel_yapay_zeka_orani" in parsed_result and "paragraflar" in parsed_result:
                    gemini_success = True
                    print(f"--- Gemini AI Detector: Anahtar #{attempt_idx+1} ({current_key[:8]}...) başarıyla çalıştı. ---")
                    break
            except Exception as e:
                print(f"--- Gemini AI Detector: Anahtar #{attempt_idx+1} ({current_key[:8]}...) hatası: {e} ---")
                continue
                
        if not gemini_success or not parsed_result:
            raise RuntimeError("Tüm Gemini API anahtarları kota/bağlantı hatası verdi.")
            
        # intihal_orani kontrolü
        parsed_result["intihal_orani"] = round(float(parsed_result.get("intihal_orani", 0.0)), 1)
        
        # intihal_kaynaklari kontrolü
        if "intihal_kaynaklari" not in parsed_result:
            parsed_result["intihal_kaynaklari"] = []
        for src in parsed_result["intihal_kaynaklari"]:
            src["benzerlik"] = round(float(src.get("benzerlik", 0.0)), 1)
            
        # Paragraf ve Cümle seviyesinde analiz ve harmanlama
        for p in parsed_result["paragraflar"]:
            p_text = p.get("metin", "")
            p_gemini = float(p.get("yapay_zeka_orani", 0.0))
            p_stat = _statik_skor_hesapla(p_text)
            
            # Akıllı Uyarlanabilir %80 Gemini / %20 Stat harmanlama
            p_final = 0.8 * p_gemini + 0.2 * p_stat
                
            p["yapay_zeka_orani"] = round(p_final, 1)
            p["insan_orani"] = round(100.0 - p["yapay_zeka_orani"], 1)
            
            # cumleler kontrolü
            if "cumleler" not in p or not p["cumleler"]:
                p_sentences = _split_into_sentences(p["metin"])
                p["cumleler"] = []
                for s in p_sentences:
                    p["cumleler"].append({
                        "metin": s,
                        "yapay_zeka_orani": p["yapay_zeka_orani"]
                    })
            else:
                for s in p["cumleler"]:
                    s_gemini = float(s.get("yapay_zeka_orani", p["yapay_zeka_orani"]))
                    s["yapay_zeka_orani"] = round(0.8 * s_gemini + 0.2 * p["yapay_zeka_orani"], 1)
                    
        # Genel yapay zeka oranını, paragrafların uzunluğuna göre ağırlıklı ortalama olarak kesin hesapla
        total_len = sum(len(p["metin"]) for p in parsed_result["paragraflar"])
        weighted_ai_sum = sum(p["yapay_zeka_orani"] * len(p["metin"]) for p in parsed_result["paragraflar"])
        genel_yapay_zeka_orani = round(weighted_ai_sum / total_len, 1) if total_len > 0 else 0.0
        parsed_result["genel_yapay_zeka_orani"] = genel_yapay_zeka_orani
        
        # metrikler kontrolü
        if "metrikler" not in parsed_result:
            parsed_result["metrikler"] = {
                "perplexity": "Düşük" if genel_yapay_zeka_orani > 60 else "Orta",
                "perplexity_aciklama": "",
                "burstiness": "Düşük" if genel_yapay_zeka_orani > 60 else "Orta",
                "burstiness_aciklama": "",
                "okunabilirlik_skor": 50.0,
                "okunabilirlik_etiket": "Orta (Lise Seviyesi)"
            }
        else:
            m = parsed_result["metrikler"]
            m["okunabilirlik_skor"] = round(float(m.get("okunabilirlik_skor", 50.0)), 1)
            
            # Burstiness/Perplexity'yi harmanlanmış skora göre dinamik güncelle
            if genel_yapay_zeka_orani > 70:
                m["perplexity"] = "Düşük"
                m["burstiness"] = "Düşük"
            elif genel_yapay_zeka_orani > 40:
                m["perplexity"] = "Orta"
                m["burstiness"] = "Orta"
            else:
                m["perplexity"] = "Yüksek"
                m["burstiness"] = "Yüksek"
                
        return parsed_result
        
    except Exception as e:
        print(f"--- Gemini AI Detector Hatası: {e}, yerel RoBERTa fallback devreye giriyor... ---")
        
    # ── YÖNTEM 2: Yerel RoBERTa Fallback (Hata durumunda) ──
    try:
        detector = _get_detector_pipeline()
        
        # Paragrafları cümlelerine ayıralım
        paragraflar_response = []
        all_sentences_flat = []
        sentence_to_para_map = [] # Her düzleştirilmiş cümlenin hangi paragrafa ait olduğunu tutar
        
        for p_idx, p_text in enumerate(valid_paragraphs):
            p_sentences = _split_into_sentences(p_text)
            if not p_sentences:
                p_sentences = [p_text]
            
            p_struct = {
                "metin": p_text,
                "cumleler_raw": p_sentences,
                "cumleler": []
            }
            paragraflar_response.append(p_struct)
            
            for s_text in p_sentences:
                all_sentences_flat.append(s_text)
                sentence_to_para_map.append(p_idx)
                
        # Tüm cümleleri batch halinde modele verelim
        predictions = detector(all_sentences_flat, truncation=True)
        
        # Sonuçları toplayalım
        ai_scores = []
        for s_idx, (s_text, pred) in enumerate(zip(all_sentences_flat, predictions)):
            label = pred.get("label", "Real")
            score = pred.get("score", 0.0)
            
            if label == "Fake":
                ai_pct = round(score * 100, 1)
            else:
                ai_pct = round((1.0 - score) * 100, 1)
                
            p_idx = sentence_to_para_map[s_idx]
            paragraflar_response[p_idx]["cumleler"].append({
                "metin": s_text,
                "yapay_zeka_orani": ai_pct
            })
            
        # Paragraf seviyesinde genel AI oranlarını hesaplayalım
        for p in paragraflar_response:
            if "cumleler_raw" in p:
                del p["cumleler_raw"]
            
            p_ai_sum = sum(s["yapay_zeka_orani"] for s in p["cumleler"])
            p_ai_avg = round(p_ai_sum / len(p["cumleler"]), 1) if p["cumleler"] else 0.0
            
            # Hibrit harmanlama (Yerel RoBERTa skoru ve istatistiksel skor harmanlaması)
            p_text = p.get("metin", "")
            p_stat = _statik_skor_hesapla(p_text)
            
            if p_stat > 70:
                p_final = 0.15 * p_ai_avg + 0.85 * p_stat
            else:
                p_final = 0.4 * p_ai_avg + 0.6 * p_stat
                
            p["yapay_zeka_orani"] = round(p_final, 1)
            p["insan_orani"] = round(100.0 - p["yapay_zeka_orani"], 1)
            
            # Cümleleri de paragrafın harmanlanmış oranına göre hafifçe güncelleyelim
            for s in p["cumleler"]:
                s_roberta = s["yapay_zeka_orani"]
                s["yapay_zeka_orani"] = round(0.5 * s_roberta + 0.5 * p["yapay_zeka_orani"], 1)
                
            ai_scores.append(p["yapay_zeka_orani"])
            
        # Genel AI oranı hesaplama
        total_len = sum(len(p["metin"]) for p in paragraflar_response)
        weighted_ai_sum = sum(p["yapay_zeka_orani"] * len(p["metin"]) for p in paragraflar_response)
        genel_yapay_zeka_orani = round(weighted_ai_sum / total_len, 1) if total_len > 0 else 0.0
        
        # Metrikleri hesapla
        full_document_text = "\n\n".join(valid_paragraphs)
        readability_score, readability_label = _calculate_turkish_readability(full_document_text)
        
        # Burstiness & Perplexity tahmini
        if genel_yapay_zeka_orani > 70:
            perplexity = "Düşük"
            perplexity_desc = "Kelimeler aşırı öngörülebilir ve standart kalıplarda."
            burstiness = "Düşük"
            burstiness_desc = "Cümle uzunlukları ve yapıları çok monoton."
        elif genel_yapay_zeka_orani > 40:
            perplexity = "Orta"
            perplexity_desc = "Dil kullanımı dengeli, yer yer otomatik yazım belirtileri var."
            burstiness = "Orta"
            burstiness_desc = "Cümle boyları karma şekilde değişkenlik gösteriyor."
        else:
            perplexity = "Yüksek"
            perplexity_desc = "Kelimeler çok zengin ve öngörülemez bir çeşitliliğe sahip."
            burstiness = "Yüksek"
            burstiness_desc = "Cümle uzunluklarında belirgin insan anlatım ritmi var."
            
        return {
            "genel_yapay_zeka_orani": genel_yapay_zeka_orani,
            "intihal_orani": 0.0,
            "intihal_kaynaklari": [],
            "metrikler": {
                "perplexity": perplexity,
                "perplexity_aciklama": perplexity_desc,
                "burstiness": burstiness,
                "burstiness_aciklama": burstiness_desc,
                "okunabilirlik_skor": readability_score,
                "okunabilirlik_etiket": readability_label
            },
            "paragraflar": paragraflar_response
        }
    except Exception as e:
        print(f"--- Yerel Fallback Hatası: {e} ---")
        raise HTTPException(status_code=500, detail=f"Analiz sırasında bir hata oluştu: {str(e)}")


@app.post("/api/v1/dokuman-cevir")
async def dokuman_cevir_endpoint(
    request: Request,
    file: UploadFile = File(...),
    target_lang: str = Form("tr"),
    glossary: str = Form(""),
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
    authorization: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Yabancı dildeki PDF'i arka planda seçilen hedef dile çevirir, job_id döner.

    Client /api/v1/ceviri-durum/{job_id} ile polling yapar; bitince
    /api/v1/ceviri-indir/{job_id}'den çevrilmiş PDF'i indirir.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if not file.filename or ext not in _CEVIRI_KABUL_EXT:
        raise HTTPException(
            status_code=400,
            detail="Desteklenmeyen dosya tipi. Lütfen geçerli bir belge, görsel, kod veya metin dosyası yükleyin.",
        )

    # Boyut sınırı — devasa dosyayı belleğe okumadan önce reddet (OOM koruması)
    if file.size and file.size > _CEVIRI_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Dosya çok büyük (maks. {_CEVIRI_MAX_MB} MB). Lütfen daha küçük bir PDF yükleyin veya belgeyi bölün.",
        )

    session_key = _session_key(authorization, x_session_id)
    session = _get_session(session_key)
    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Dosya boş görünüyor.")
    if len(file_bytes) > _CEVIRI_MAX_BYTES:  # file.size yoksa yedek kontrol
        raise HTTPException(
            status_code=400,
            detail=f"Dosya çok büyük (maks. {_CEVIRI_MAX_MB} MB). Lütfen daha küçük bir PDF yükleyin veya belgeyi bölün.",
        )

    _cjob_cleanup()

    job_id = uuid.uuid4().hex
    # Cancel event'i bellekte ilklendir
    event = threading.Event()
    with _ceviri_cancel_events_lock:
        _ceviri_cancel_events[job_id] = event
        
    # Job metadata'yı veritabanına kaydet
    _cjob_set(
        job_id,
        status="running",
        progress=0,
        total=0,
        filename=None,
        pdf_path=None,
        error=None,
        uyari=None,
        created_at=time.time(),
        finished_at=None,
    )

    thread = threading.Thread(
        target=_run_ceviri_generation,
        args=(job_id, file_bytes, file.filename, api_key, client_ip, using_user_key, session_key, target_lang, glossary),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "durum": "baslatildi"}


@app.get("/api/v1/ceviri-durum/{job_id}")
async def ceviri_durum_endpoint(job_id: str):
    """Bir çeviri job'unun durumunu döner (binary PDF hariç)."""
    job = _cjob_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Çeviri bulunamadı (süresi dolmuş veya sunucu yeniden başlamış olabilir).")
    return {
        "status": job["status"],            # running | done | error | cancelled
        "progress": job.get("progress", 0),
        "total": job.get("total", 0),
        "filename": job.get("filename"),
        "error": job.get("error"),
        "uyari": job.get("uyari"),          # kısmi çeviri uyarısı (varsa)
        "hazir": job.get("status") == "done"
            and bool(job.get("pdf_path")) and os.path.exists(job["pdf_path"]),
    }


@app.get("/api/v1/ceviri-indir/{job_id}")
async def ceviri_indir_endpoint(job_id: str):
    """Tamamlanmış çevirinin Türkçe PDF'ini diskten okur ve indirir."""
    job = _cjob_get(job_id)
    pdf_path = job.get("pdf_path") if job else None
    if job is None or job.get("status") != "done" or not pdf_path or not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="İndirilecek çeviri bulunamadı.")
    from urllib.parse import quote
    fn = job.get("filename") or "ceviri-TR.pdf"
    with open(pdf_path, "rb") as f:
        data = f.read()
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fn)}"},
    )


@app.post("/api/v1/ceviri-iptal/{job_id}")
async def ceviri_iptal_endpoint(job_id: str):
    """Çalışan bir çeviri job'unu iptal eder."""
    job = _cjob_get(job_id)
    if job is None:
        return {"durum": "zaten_yok"}
    if job.get("status") == "running":
        _cjob_set(job_id, status="cancelled", finished_at=time.time())
    return {"durum": "iptal_istendi"}


# ──────────────────────────────────────────────────────────────────
# KAVRAM KÜTÜPHANESİ — kullanıcıya özel klasörler + AI gardiyanlı kavram kartları
# Veriler veritabanında kalıcıdır (kullanıcı silmedikçe durur). Giriş zorunludur.
# ──────────────────────────────────────────────────────────────────

# Gardiyan reddinde gösterilecek sabit uyarı
_KAVRAM_RED_MESAJI = (
    "⚠️ Bu modülde sadece derslerinizle ilgili kavramları sorgulayabilirsiniz. "
    "Lütfen öğrenmek istediğiniz terimi veya kavramı giriniz."
)


def _require_user(authorization: Optional[str]):
    """Authorization header'ından aktif kullanıcıyı çözer; yoksa 401."""
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Bu modülü kullanmak için giriş yapmalısınız.")
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Oturum geçersiz veya süresi dolmuş.")
    return user


def _kavram_dogrula_ve_tanimla(kavram: str, api_key: str) -> dict:
    """Gelen girdiyi AI gardiyanından geçir.

    Returns: {"gecerli": bool, "tanim": str}
    - gecerli=False → girdi bir kavram/terim değil (hava durumu, kod yazma, soru çözme vb.)
    - gecerli=True  → kart tasarımına sığacak, max 2-3 cümlelik jilet gibi tanım
    """
    # NOT: Gemini 3.5 "thinking" token tükettiğinden düşük limit JSON'u yarıda keser
    # (örn. 512'de çıktı '{"gecerli": true,' diye kesilip parse hatası → yanlış RED).
    # 2-3 cümlelik tanım + düşünme payı için rahat bir bütçe veriyoruz.
    llm = _make_llm(api_key, temperature=0.3, json_mode=True, max_output_tokens=2048)
    prompt = """\
Sen bir "Kavram Kütüphanesi" gardiyanısın. Görevin İKİ aşamalı:

AŞAMA 1 — DENETİM: Sana gelen girdinin akademik/teknik bir KAVRAM veya TERİM olup olmadığını belirle.
- GEÇERLİ örnekler: "DNS nedir?", "Polimorfizm", "Dependency Injection türleri", "Normalizasyon", "TCP üçlü el sıkışması", "Fotosentez".
- GEÇERSİZ örnekler (REDDET): "Yarın hava nasıl?", "Bana bir Python kodu yaz", "Şu matematik sorusunu çöz", "Merhaba", "2+2 kaç", sohbet/komut/ödev çözümü istekleri, anlamsız metinler.

AŞAMA 2 — TANIM: Eğer GEÇERLİ bir kavramsa, kart tasarımına TAM oturacak, TAŞMA yapmayacak uzunlukta,
MAKSİMUM 2-3 cümlelik, jilet gibi net ve doğru bir tanım üret (Türkçe). Boş laf, giriş cümlesi yok.

ÇIKTI: SADECE şu JSON objesini döndür (başka metin yok):
{{"gecerli": true|false, "tanim": "kavramsa 2-3 cümlelik tanım, değilse boş string"}}

İncelenecek girdi: "{girdi}"
"""
    try:
        _rate_gate(api_key)
        ham = llm.invoke(prompt.format(girdi=kavram[:300])).content
        metin = _extract_text(ham).strip()
        # JSON objesini ayıkla
        import json as _json
        try:
            data = _json.loads(metin)
        except Exception:
            m = re.search(r"\{.*\}", metin, re.DOTALL)
            data = _json.loads(m.group(0)) if m else {}
        gecerli = bool(data.get("gecerli"))
        tanim = str(data.get("tanim", "")).strip()
        if gecerli and not tanim:
            gecerli = False
        return {"gecerli": gecerli, "tanim": tanim}
    except Exception as e:
        if _kota_hatasi_mi(str(e)):
            raise HTTPException(status_code=429, detail=_KOTA_MESAJI)
        raise HTTPException(status_code=500, detail=f"Kavram işlenemedi: {e}")


@app.get("/api/kavram/klasorler")
async def kavram_klasorler_endpoint(authorization: Optional[str] = Header(None)):
    """Kullanıcının tüm klasörlerini (kart sayılarıyla) döner."""
    user = _require_user(authorization)
    return {"klasorler": klasor_listele(user["id"])}


@app.post("/api/kavram/klasor")
async def kavram_klasor_olustur_endpoint(
    istek: KlasorIstegi,
    authorization: Optional[str] = Header(None),
):
    """Yeni klasör oluşturur."""
    user = _require_user(authorization)
    try:
        klasor = klasor_olustur(user["id"], istek.ad)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"klasor": klasor}


@app.delete("/api/kavram/klasor/{klasor_id}")
async def kavram_klasor_sil_endpoint(
    klasor_id: int,
    authorization: Optional[str] = Header(None),
):
    """Klasörü (ve içindeki tüm kartları) siler."""
    user = _require_user(authorization)
    silindi = klasor_sil(user["id"], klasor_id)
    if not silindi:
        raise HTTPException(status_code=404, detail="Klasör bulunamadı.")
    return {"durum": "silindi"}


@app.get("/api/kavram/klasor/{klasor_id}/kartlar")
async def kavram_kartlar_endpoint(
    klasor_id: int,
    authorization: Optional[str] = Header(None),
):
    """Bir klasördeki kavram kartlarını döner."""
    user = _require_user(authorization)
    if not klasor_sahibi_mi(user["id"], klasor_id):
        raise HTTPException(status_code=404, detail="Klasör bulunamadı.")
    return {"kartlar": kart_listele(user["id"], klasor_id)}


@app.post("/api/kavram/klasor/{klasor_id}/kart")
async def kavram_kart_ekle_endpoint(
    klasor_id: int,
    istek: KavramEkleIstegi,
    request: Request,
    authorization: Optional[str] = Header(None),
    x_user_api_key: Optional[str] = Header(None, alias="X-User-Api-Key"),
):
    """Bir kavramı AI gardiyanından geçirip kart olarak ekler.

    Reddedilirse {gecerli: false, mesaj} döner (200). Geçerliyse kart kaydedilir.
    """
    user = _require_user(authorization)
    if not klasor_sahibi_mi(user["id"], klasor_id):
        raise HTTPException(status_code=404, detail="Klasör bulunamadı.")

    girdi = (istek.kavram or "").strip()
    if not girdi:
        raise HTTPException(status_code=400, detail="Lütfen bir kavram giriniz.")
    if len(girdi) > 200:
        raise HTTPException(status_code=400, detail="Kavram çok uzun (en fazla 200 karakter).")

    api_key, using_user_key = _resolve_api_key(x_user_api_key)
    client_ip = _enforce_quota(request, using_user_key)

    sonuc = _kavram_dogrula_ve_tanimla(girdi, api_key)
    if not sonuc["gecerli"]:
        return {"gecerli": False, "mesaj": _KAVRAM_RED_MESAJI}

    kalan = _record_usage(client_ip)
    kart = kart_ekle(user["id"], klasor_id, girdi, sonuc["tanim"])
    return {
        "gecerli": True,
        "kart": kart,
        "kullanim": _kullanim_blok(using_user_key, kalan, cached=False),
    }


@app.delete("/api/kavram/kart/{kart_id}")
async def kavram_kart_sil_endpoint(
    kart_id: int,
    authorization: Optional[str] = Header(None),
):
    """Bir kavram kartını siler."""
    user = _require_user(authorization)
    silindi = kart_sil(user["id"], kart_id)
    if not silindi:
        raise HTTPException(status_code=404, detail="Kart bulunamadı.")
    return {"durum": "silindi"}


# ──────────────────────────────────────────────────────────────────
# AUTH ENDPOINTS — kullanıcı kaydı, giriş, oturum
# ──────────────────────────────────────────────────────────────────

def _extract_token(authorization: Optional[str]) -> Optional[str]:
    """Authorization: Bearer <token> header'ından token'ı çıkar."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def _user_response(user) -> dict:
    """Frontend'e dönecek güvenli kullanıcı temsili (password vs. yok)."""
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "role": user["role"],
    }


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


@app.post("/api/auth/register")
async def auth_register(istek: KayitIstegi):
    """
    E-posta + şifreli kayıt:
    1) Hesap oluşturulur ama email_verified=0 olur (login engelli)
    2) 6 haneli kod üretilip e-posta ile gönderilir
    3) Kullanıcı /api/auth/verify-email ile kodu girip hesabı aktive etmek zorunda
    4) Aktive edene kadar /api/auth/login reddedilir
    Auto-login YAPMAZ — kullanıcı sonra ayrıca giriş yapar.
    """
    email_raw = (istek.email or "").strip().lower()
    if not email_raw or not EMAIL_RE.match(email_raw):
        raise HTTPException(status_code=400, detail="Geçerli bir e-posta adresi gerekli.")

    try:
        user = create_user(
            username=istek.username,
            password=istek.password,
            email=email_raw,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Doğrulama kodu üret + e-posta gönder
    code = create_or_replace_verification(user["id"])
    ok, info = send_verification_email(email_raw, code, username=user["username"])
    if not ok:
        # Kullanıcı yaratıldı ama mail gönderilemediyse — kullanıcıyı bilgilendir
        # ama hesabı silmiyoruz; "kodu tekrar gönder" ile yeniden denenebilir.
        raise HTTPException(
            status_code=502,
            detail=f"Hesap oluşturuldu ama e-posta gönderilemedi: {info}. 'Kodu tekrar gönder' ile dene.",
        )

    return {
        "durum": "verification_pending",
        "user_id": user["id"],
        "username": user["username"],
        "email": email_raw,
        "dev_mode": info == "dev_console",  # frontend dev'de kodu konsoldan okumayı söyleyebilir
    }


@app.post("/api/auth/verify-email")
async def auth_verify_email(istek: EmailVerifyIstegi):
    """6 haneli kodu doğrula — başarılıysa hesap aktive olur. Auto-login YOK."""
    user = get_user_by_id(istek.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Kullanıcı bulunamadı.")
    if is_email_verified(istek.user_id):
        return {"durum": "already_verified"}

    ok, reason = verify_email_code(istek.user_id, istek.code)
    if not ok:
        raise HTTPException(status_code=400, detail=reason)

    return {
        "durum": "verified",
        "user_id": user["id"],
        "username": user["username"],
    }


@app.post("/api/auth/resend-verification")
async def auth_resend_verification(istek: ResendVerificationIstegi):
    user = get_user_by_id(istek.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Kullanıcı bulunamadı.")
    if is_email_verified(istek.user_id):
        return {"durum": "already_verified"}
    if not user["email"]:
        raise HTTPException(status_code=400, detail="Kullanıcının e-postası yok.")

    code = create_or_replace_verification(user["id"])
    ok, info = send_verification_email(user["email"], code, username=user["username"])
    if not ok:
        raise HTTPException(status_code=502, detail=f"E-posta gönderilemedi: {info}")
    return {"durum": "resent", "email": user["email"], "dev_mode": info == "dev_console"}


@app.post("/api/auth/login")
async def auth_login(istek: GirisIstegi):
    user = authenticate(istek.username, istek.password)
    if not user:
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya şifre hatalı.")

    # E-posta doğrulama zorunlu — verified değilse 403 + user_id (resend için)
    if not is_email_verified(user["id"]):
        raise HTTPException(
            status_code=403,
            detail={
                "kod": "email_not_verified",
                "user_id": user["id"],
                "email": user["email"],
                "mesaj": "Hesabını henüz doğrulamadın. E-postana gelen 6 haneli kodu gir.",
            },
        )

    tokens = create_session(user["id"])
    return {
        "durum": "basarili",
        "token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_in": tokens["expires_in"],
        "refresh_expires_in": tokens["refresh_expires_in"],
        "user": _user_response(user),
    }


@app.get("/api/auth/me")
async def auth_me(authorization: Optional[str] = Header(None)):
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Oturum bulunamadı.")
    user = get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Oturum geçersiz veya süresi dolmuş.")
    return {"user": _user_response(user)}


@app.post("/api/auth/logout")
async def auth_logout(authorization: Optional[str] = Header(None)):
    token = _extract_token(authorization)
    invalidate_session(token or "")
    return {"durum": "basarili"}


@app.post("/api/auth/refresh")
async def auth_refresh(istek: RefreshTokenIstegi):
    """
    Refresh token ile yeni access + refresh ikilisi üretir (rotation).
    Eski refresh otomatik olarak iptal edilir. Çalınmış refresh tekrar sunulursa
    tüm kullanıcı oturumları kapatılır (replay detection).
    """
    tokens = refresh_session((istek.refresh_token or "").strip())
    if not tokens:
        raise HTTPException(
            status_code=401,
            detail="Refresh token geçersiz veya süresi dolmuş. Yeniden giriş yap.",
        )
    return {
        "durum": "basarili",
        "token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_in": tokens["expires_in"],
        "refresh_expires_in": tokens["refresh_expires_in"],
    }


@app.post("/api/auth/logout-all")
async def auth_logout_all(authorization: Optional[str] = Header(None)):
    """Kullanıcının tüm cihazlardaki oturumlarını anında iptal eder."""
    user = _require_user(authorization)
    count = revoke_all_user_sessions(user["id"])
    return {"durum": "basarili", "iptal_edilen_oturum": count}


@app.post("/api/auth/forgot-password")
async def auth_forgot_password(istek: ForgotPasswordIstegi):
    email_raw = (istek.email or "").strip().lower()
    if not email_raw:
        raise HTTPException(status_code=400, detail="E-posta zorunludur.")
        
    user = get_user_by_email(email_raw)
    if not user:
        # Güvenlik: hesap yoksa bile başarılı döndür (enum attack önlemek için)
        # Ama biz yine de UX için "Bu e-posta kayıtlı değil" diyebiliriz (tercihe bağlı).
        # Lostick AI için UX odaklı olalım ve açıkça söyleyelim.
        raise HTTPException(status_code=404, detail="Bu e-posta adresiyle kayıtlı bir hesap bulunamadı.")
        
    code = create_password_reset(user["id"])
    ok, info = send_password_reset_email(email_raw, code, username=user["username"])
    
    if not ok:
        raise HTTPException(status_code=502, detail=f"E-posta gönderilemedi: {info}")
        
    return {
        "durum": "pending_reset",
        "user_id": user["id"],
        "email": email_raw,
        "dev_mode": info == "dev_console"
    }


@app.post("/api/auth/reset-password")
async def auth_reset_password(istek: ResetPasswordIstegi):
    user = get_user_by_id(istek.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Kullanıcı bulunamadı.")
        
    ok, reason = verify_and_execute_password_reset(istek.user_id, istek.code, istek.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail=reason)
        
    return {"durum": "basarili"}


# ─── OAuth (Google + GitHub) ─────────────────────────────────────

GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"


@app.post("/api/auth/oauth/google")
async def auth_oauth_google(istek: GoogleOAuthIstegi):
    """
    Google OAuth doğrulaması — iki flow destekler:
      1) ID token (credential): JWT'yi tokeninfo ile verify eder (klasik GIS callback).
      2) Access token: oauth2.initTokenClient'tan gelir; tokeninfo ile audience check + userinfo
         endpoint'inden profil bilgisi alır.
    """
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID")
    if not client_id:
        raise HTTPException(
            status_code=503,
            detail="Google OAuth aktif değil. Yönetici GOOGLE_OAUTH_CLIENT_ID'yi .env'ye eklemeli.",
        )

    if not istek.credential and not istek.access_token:
        raise HTTPException(
            status_code=400,
            detail="credential veya access_token alanlarından biri zorunludur.",
        )

    sub: Optional[str] = None
    email: Optional[str] = None
    name: Optional[str] = None

    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            if istek.credential:
                # FLOW 1: ID token (JWT)
                resp = await client.get(
                    GOOGLE_TOKENINFO_URL,
                    params={"id_token": istek.credential},
                )
                if resp.status_code != 200:
                    raise HTTPException(status_code=401, detail="Google ID token geçersiz veya süresi dolmuş.")
                data = resp.json()
                if data.get("aud") != client_id:
                    raise HTTPException(status_code=401, detail="Token bu uygulama için verilmemiş.")
                if data.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
                    raise HTTPException(status_code=401, detail="Geçersiz token issuer.")
                sub = data.get("sub")
                email = data.get("email")
                name = data.get("name") or data.get("given_name")
            else:
                # FLOW 2: Access token — önce audience doğrula, sonra userinfo çek
                tinfo = await client.get(
                    GOOGLE_TOKENINFO_URL,
                    params={"access_token": istek.access_token},
                )
                if tinfo.status_code != 200:
                    raise HTTPException(status_code=401, detail="Google access token geçersiz veya süresi dolmuş.")
                tdata = tinfo.json()
                if tdata.get("aud") != client_id:
                    raise HTTPException(status_code=401, detail="Token bu uygulama için verilmemiş.")

                uinfo = await client.get(
                    GOOGLE_USERINFO_URL,
                    headers={"Authorization": f"Bearer {istek.access_token}"},
                )
                if uinfo.status_code != 200:
                    raise HTTPException(status_code=401, detail="Google kullanıcı bilgisi alınamadı.")
                udata = uinfo.json()
                sub = udata.get("sub")
                email = udata.get("email")
                name = udata.get("name") or udata.get("given_name")
    except _httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Google'a ulaşılamadı: {e}")

    if not sub:
        raise HTTPException(status_code=401, detail="Google'dan kullanıcı kimliği alınamadı.")

    if istek.mode == "register":
        try:
            user = register_oauth_user("google", str(sub), email, name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:  # login
        user = find_oauth_user("google", str(sub))
        if user is None:
            raise HTTPException(
                status_code=404,
                detail="Bu Google hesabı kayıtlı değil. Önce kayıt sayfasından Google ile kayıt ol.",
            )

    tokens = create_session(user["id"])
    return {
        "durum": "basarili",
        "token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_in": tokens["expires_in"],
        "refresh_expires_in": tokens["refresh_expires_in"],
        "user": _user_response(user),
    }


@app.post("/api/auth/oauth/github")
async def auth_oauth_github(istek: GithubOAuthIstegi):
    """
    GitHub OAuth authorization code flow:
    1) Frontend kullanıcıyı github.com/login/oauth/authorize'a yönlendirir
    2) GitHub callback URL'ine `code` parametresiyle döner
    3) Frontend bu code'u bize gönderir → biz access_token'a çeviririz → user bilgisini çekeriz
    """
    client_id = os.getenv("GITHUB_OAUTH_CLIENT_ID")
    client_secret = os.getenv("GITHUB_OAUTH_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=503,
            detail="GitHub OAuth aktif değil. Yönetici GITHUB_OAUTH_CLIENT_ID ve GITHUB_OAUTH_CLIENT_SECRET'i .env'ye eklemeli.",
        )

    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            # 1) Code → access_token
            token_resp = await client.post(
                GITHUB_TOKEN_URL,
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": istek.code,
                },
                headers={"Accept": "application/json"},
            )
            if token_resp.status_code != 200:
                raise HTTPException(status_code=401, detail="GitHub token alınamadı.")
            token_data = token_resp.json()
            access_token = token_data.get("access_token")
            if not access_token:
                err = token_data.get("error_description") or token_data.get("error") or "bilinmiyor"
                raise HTTPException(status_code=401, detail=f"GitHub OAuth hatası: {err}")

            auth_header = {
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }

            # 2) User profile
            user_resp = await client.get(GITHUB_USER_URL, headers=auth_header)
            if user_resp.status_code != 200:
                raise HTTPException(status_code=401, detail="GitHub kullanıcı bilgisi alınamadı.")
            user_data = user_resp.json()

            gh_id = user_data.get("id")
            gh_login = user_data.get("login")
            gh_name = user_data.get("name") or gh_login
            gh_email = user_data.get("email")

            # 3) Email private olabilir — /user/emails'tan primary+verified olanı al
            if not gh_email:
                emails_resp = await client.get(GITHUB_EMAILS_URL, headers=auth_header)
                if emails_resp.status_code == 200:
                    for em in emails_resp.json():
                        if em.get("primary") and em.get("verified"):
                            gh_email = em.get("email")
                            break
    except _httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"GitHub'a ulaşılamadı: {e}")

    if not gh_id:
        raise HTTPException(status_code=401, detail="GitHub'dan kullanıcı kimliği alınamadı.")

    if istek.mode == "register":
        try:
            user = register_oauth_user("github", str(gh_id), gh_email, gh_name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:  # login
        user = find_oauth_user("github", str(gh_id))
        if user is None:
            raise HTTPException(
                status_code=404,
                detail="Bu GitHub hesabı kayıtlı değil. Önce kayıt sayfasından GitHub ile kayıt ol.",
            )

    tokens = create_session(user["id"])
    return {
        "durum": "basarili",
        "token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_in": tokens["expires_in"],
        "refresh_expires_in": tokens["refresh_expires_in"],
        "user": _user_response(user),
    }


class KeyStatusRequest(BaseModel):
    keys: list[str]


@app.post("/api/keys/status")
async def get_keys_status_endpoint(
    istek: KeyStatusRequest,
):
    """
    Kullanıcının kendi Gemini API anahtarlarının durumlarını ve kota detaylarını döner.
    Ortak sunucu havuzu devre dışı bırakılmıştır.
    """
    from kullanim_servisi import get_keys_status
    
    # Kullanıcı anahtarlarını topla
    user_keys = [k.strip() for k in istek.keys if k.strip()]
    
    # Durumları sorgula
    statuses = get_keys_status(user_keys)
    
    # Kullanıcı anahtarlarını işle
    user_key_statuses = []
    for uk in user_keys:
        stat = statuses.get(uk)
        if stat:
            user_key_statuses.append({
                "key": uk,
                "masked": stat["masked"],
                "status": stat["status"],
                "cooldown_until": stat["cooldown_until"],
                "daily_count": stat["daily_count"]
            })
            
    return {
        "status": "success",
        "server_keys": [],  # Ortak havuz kapatıldı
        "user_keys": user_key_statuses
    }


class KeyValidateRequest(BaseModel):
    key: str


@app.post("/api/keys/validate")
async def validate_key_endpoint(
    istek: KeyValidateRequest,
):
    """
    Eklenen yeni bir Gemini API key'ini Google API'sine bağlanarak canlı olarak doğrular.
    """
    from kullanim_servisi import verify_gemini_key, record_key_success, record_key_failure
    
    key = istek.key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API anahtarı boş olamaz.")
        
    valid, msg = verify_gemini_key(key)
    if valid:
        record_key_success(key)
        return {"status": "success", "valid": True, "message": "API anahtarı geçerli."}
    else:
        if msg == "exhausted":
            record_key_failure(key, "Resource exhausted (429)")
            return {
                "status": "error",
                "valid": False,
                "error_type": "exhausted",
                "message": "Bu API anahtarının günlük veya dakikalık kullanım kotası dolmuş."
            }
        elif msg == "invalid":
            record_key_failure(key, "API_KEY_INVALID")
            return {
                "status": "error",
                "valid": False,
                "error_type": "invalid",
                "message": "Bu API anahtarı geçersiz veya hatalı. Lütfen doğru girdiğinizden emin olun."
            }
        else:
            # Ağ hatası veya benzeri
            return {
                "status": "error",
                "valid": False,
                "error_type": "network",
                "message": f"Doğrulama sırasında bağlantı hatası oluştu: {msg}"
            }



# ──────────────────────────────────────────────────────────────────
# BELLEK İZLEME VE SAĞLIK KONTROLÜ (Health Check) ENDPOINT'İ
# Ops/DevOps ekibinin sunucu bellek durumunu izleyebilmesi için.
# ──────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health_endpoint():
    """Sunucu sağlık durumunu ve bellek istatistiklerini döner."""
    import os as _os

    # RSS (Resident Set Size) — sürecin gerçek RAM kullanımı
    rss_mb = None
    try:
        import psutil
        process = psutil.Process(_os.getpid())
        mem_info = process.memory_info()
        rss_mb = round(mem_info.rss / (1024 * 1024), 1)
    except ImportError:
        # psutil yoksa platform-bağımlı fallback
        try:
            import resource
            rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            rss_mb = round(rss_kb / 1024, 1)
        except Exception:
            rss_mb = None

    # Aktif job sayıları
    with _test_jobs_lock:
        test_running = sum(1 for j in _test_jobs.values() if j["status"] == "running")
        test_total = len(_test_jobs)
    with _anlatim_jobs_lock:
        anlatim_running = sum(1 for j in _anlatim_jobs.values() if j["status"] == "running")
        anlatim_total = len(_anlatim_jobs)
    with _kart_jobs_lock:
        kart_running = sum(1 for j in _kart_jobs.values() if j["status"] == "running")
        kart_total = len(_kart_jobs)

    return {
        "status": "ok",
        "memory": {
            "rss_mb": rss_mb,
            "faiss_lru_cache_size": _faiss_lru.size,
            "faiss_lru_cache_max": _MAX_CACHED_FAISS,
        },
        "jobs": {
            "test": {"running": test_running, "total": test_total},
            "anlatim": {"running": anlatim_running, "total": anlatim_total},
            "kart": {"running": kart_running, "total": kart_total},
        },
        "limits": {
            "max_files_per_session": MAX_FILES,
            "max_total_chars": MAX_TOTAL_CHARS,
            "max_upload_size_mb": MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
            "max_cached_faiss": _MAX_CACHED_FAISS,
        },
    }


# ──────────────────────────────────────────────────────────────────
# GELİŞTİRME SUNUCUSU — `python main.py` ile çalıştır.
# uvicorn'u DOĞRU reload ayarıyla başlatır: SADECE .py dosyaları izlenir.
# Böylece SQLite cache (*.db), FAISS index (faiss_cache/), geçici dosyalar ve
# landing/.next gibi sürekli değişen yollar reload TETİKLEMEZ → backend çökmez.
# ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        reload_includes=["*.py"],
        reload_excludes=[
            "landing/*", "venv/*", "faiss_cache/*", "ceviri_cache/*", "__pycache__/*",
            "*.db", "*.db-*", "temp_*", "lostick_*",
        ],
    )
