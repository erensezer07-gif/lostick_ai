"""
Kullanım servisi: LLM cevap cache'i + sunucu API key'i için günlük IP başına rate limit.

Mantık:
- Kullanıcı kendi Gemini API key'ini gönderirse (X-User-Api-Key header) sınırsız çalışır
- Göndermezse sunucunun key'i kullanılır ama IP başına günlük limit uygulanır
- LLM cevapları PDF-hash + endpoint + parametreler ile anahtarlanıp SQLite'a yazılır
- Aynı PDF'in aynı sorusu/konusu tekrar geldiğinde Gemini'ye gitmez
"""

from __future__ import annotations

import hashlib
import sqlite3
import time
from datetime import date
from pathlib import Path
from typing import Optional, Tuple

from db_pool import get_db

CACHE_DB_PATH = Path(__file__).parent / "kullanim_cache.db"
SERVER_KEY_DAILY_LIMIT = 5  # Sunucunun key'iyle bir IP günde kaç LLM isteği atabilir


def init_cache() -> None:
    """SQLite cache + rate-limit tablolarını oluştur (idempotent)."""
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_cache (
                cache_key TEXT PRIMARY KEY,
                response TEXT NOT NULL,
                cached_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rate_limit (
                ip TEXT NOT NULL,
                day TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (ip, day)
            )
            """
        )
        # API anahtarı kota ve durum takip tablosu
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_key_status (
                key_hash TEXT PRIMARY KEY,
                masked_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', -- 'active', 'cooldown', 'exhausted'
                cooldown_until REAL NOT NULL DEFAULT 0.0,
                daily_count INTEGER NOT NULL DEFAULT 0,
                last_used REAL NOT NULL DEFAULT 0.0,
                day TEXT NOT NULL
            )
            """
        )
        # Çok kullanıcılı ve yatay ölçeklenebilir (stateless) oturum takibi tablosu
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_sessions (
                session_key TEXT PRIMARY KEY,
                current_pdf_hash TEXT NOT NULL DEFAULT 'default',
                active_files TEXT NOT NULL DEFAULT '[]', -- JSON formatında aktif dosyalar listesi
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()


def make_cache_key(pdf_hash: str, action: str, params: str) -> str:
    """Cache anahtarı: pdf_hash + endpoint + parametreler → SHA-256 kısa."""
    raw = f"{pdf_hash}|{action}|{params}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def cache_get(key: str) -> Optional[str]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT response FROM llm_cache WHERE cache_key = ?", (key,)
        ).fetchone()
        return row[0] if row else None


def cache_set(key: str, value: str) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO llm_cache VALUES (?, ?, ?)",
            (key, value, time.time()),
        )
        conn.commit()


def hash_bytes(data: bytes) -> str:
    """Bir byte dizisinin (ör. PDF içeriği) kısa SHA-256 hash'i."""
    return hashlib.sha256(data).hexdigest()[:16]


def check_rate_limit(ip: str) -> Tuple[bool, int]:
    """
    Sunucu key'i kullanılan bir IP'nin günlük limitini kontrol eder.
    Tüketmez, sadece kontrol eder.

    Returns:
        (izin_var_mı, kalan_istek_sayısı)
    """
    today = date.today().isoformat()
    with get_db() as conn:
        row = conn.execute(
            "SELECT count FROM rate_limit WHERE ip = ? AND day = ?",
            (ip, today),
        ).fetchone()
        current = row[0] if row else 0
        remaining = max(0, SERVER_KEY_DAILY_LIMIT - current)
        return (current < SERVER_KEY_DAILY_LIMIT, remaining)


def increment_rate_limit(ip: str) -> int:
    """Sayacı +1 artırır ve yeni değeri döner."""
    today = date.today().isoformat()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO rate_limit (ip, day, count) VALUES (?, ?, 1)
            ON CONFLICT (ip, day) DO UPDATE SET count = count + 1
            """,
            (ip, today),
        )
        conn.commit()
        row = conn.execute(
            "SELECT count FROM rate_limit WHERE ip = ? AND day = ?",
            (ip, today),
        ).fetchone()
        return row[0] if row else 0


# --- API Anahtarı kota ve durum izleme yardımcıları ---

def _key_hash(key: str) -> str:
    """API Anahtarının SHA-256 hash'ini döner (güvenli depolama için)."""
    return hashlib.sha256(key.strip().encode("utf-8")).hexdigest()


def _mask_api_key(key: str) -> str:
    """API Anahtarını maskeler (örn: AIzaSy...y64U)."""
    k = key.strip()
    if not k:
        return ""
    if len(k) <= 8:
        return "•" * len(k)
    return f"{k[:4]}...{k[-4:]}"


def _is_daily_quota_error(msg: str) -> bool:
    """Hata mesajının günlük kota aşımı hatası olup olmadığını kontrol eder."""
    if not msg:
        return False
    m = msg.lower()
    # Günlük kota kelimelerini veya daily/day/limit exceeded daily ifadelerini eşleştir
    return any(s in m for s in ("queries per day", "daily limit", "rpd", "per day", "daily"))


def _is_minute_rate_limit_error(msg: str) -> bool:
    """Hata mesajının dakikalık istek sınırı hatası olup olmadığını kontrol eder."""
    if not msg:
        return False
    m = msg.lower()
    # Dakikalık RPM/QPM kotalarını veya genel 429 rate limit hatalarını yakala
    return any(s in m for s in ("queries per minute", "rpm", "qpm", "per minute", "minute", "rate limit", "rate-limit", "429", "resource_exhausted", "resource_exhausted"))


def _is_invalid_key_error(msg: str) -> bool:
    """Hata mesajının geçersiz API anahtarı hatası olup olmadığını kontrol eder."""
    if not msg:
        return False
    m = msg.lower()
    return any(s in m for s in ("api_key_invalid", "invalid api key", "api key not valid", "api key invalid", "key_invalid"))


def verify_gemini_key(api_key: str) -> Tuple[bool, str]:
    """
    Google Gemini API anahtarını doğrudan Google API'sine bağlanarak kontrol eder.
    Ağ hatalarında, geçersiz anahtarlarda ve kota bitiminde doğru durum bilgisi döndürür.
    Returns: (gecerli_mi, durum_mesaji)
    """
    import httpx
    k = api_key.strip()
    if not k:
        return False, "invalid"
        
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={k}"
    try:
        # 5 saniye timeout ile Google API'sine modelleri listeleme isteği gönder
        resp = httpx.get(url, timeout=5.0)
        if resp.status_code == 200:
            return True, "valid"
        elif resp.status_code == 429:
            # Doğrulama sırasında 429 dönerse, bunun günlük mü dakikalık mı olduğunu hata gövdesinden anla
            try:
                err_text = resp.text
                if _is_daily_quota_error(err_text):
                    return False, "exhausted"
            except Exception:
                pass
            return False, "cooldown"
        else:
            return False, "invalid"
    except Exception as e:
        return False, f"network_error: {str(e)}"


def record_key_success(key: str) -> None:
    """Başarılı bir LLM isteğinden sonra API anahtarının sayacını ve durumunu günceller."""
    if not key or not key.strip():
        return
    k_hash = _key_hash(key)
    masked = _mask_api_key(key)
    today = date.today().isoformat()
    now = time.time()
    
    with get_db() as conn:
        row = conn.execute(
            "SELECT day, daily_count FROM api_key_status WHERE key_hash = ?", (k_hash,)
        ).fetchone()
        
        if not row:
            conn.execute(
                """
                INSERT INTO api_key_status (key_hash, masked_key, status, cooldown_until, daily_count, last_used, day)
                VALUES (?, ?, 'active', 0.0, 1, ?, ?)
                """,
                (k_hash, masked, now, today)
            )
        else:
            db_day, current_count = row
            if db_day != today:
                # Yeni gün, sayacı ve durumu sıfırla
                conn.execute(
                    """
                    UPDATE api_key_status 
                    SET daily_count = 1, day = ?, status = 'active', cooldown_until = 0.0, last_used = ?
                    WHERE key_hash = ?
                    """,
                    (today, now, k_hash)
                )
            else:
                # Aynı gün, sayacı artır ve durumu aktif yap
                conn.execute(
                    """
                    UPDATE api_key_status 
                    SET daily_count = daily_count + 1, last_used = ?, status = 'active', cooldown_until = 0.0
                    WHERE key_hash = ?
                    """,
                    (now, k_hash)
                )
        conn.commit()


def record_key_failure(key: str, error_msg: str) -> None:
    """Hatalı bir LLM isteğinden sonra API anahtarının durumunu (cooldown/exhausted/invalid) günceller."""
    if not key or not key.strip():
        return
    k_hash = _key_hash(key)
    masked = _mask_api_key(key)
    today = date.today().isoformat()
    now = time.time()
    
    is_invalid = _is_invalid_key_error(error_msg)
    is_daily = _is_daily_quota_error(error_msg)
    is_minute = _is_minute_rate_limit_error(error_msg)
    
    if is_invalid:
        status = "invalid"
        cooldown_until = 0.0
    elif is_daily:
        status = "exhausted"
        cooldown_duration = 86400.0  # 24 saat (Günlük kota kilidi)
        cooldown_until = now + cooldown_duration
    elif is_minute:
        status = "cooldown"
        cooldown_duration = 60.0  # Sadece 60 saniye (Dakikalık RPM kilidi)
        cooldown_until = now + cooldown_duration
    else:
        status = "cooldown"
        cooldown_duration = 30.0  # Diğer geçici hatalar için 30 saniye
        cooldown_until = now + cooldown_duration

    
    with get_db() as conn:
        row = conn.execute(
            "SELECT day FROM api_key_status WHERE key_hash = ?", (k_hash,)
        ).fetchone()
        
        if not row:
            conn.execute(
                """
                INSERT INTO api_key_status (key_hash, masked_key, status, cooldown_until, daily_count, last_used, day)
                VALUES (?, ?, ?, ?, 0, ?, ?)
                """,
                (k_hash, masked, status, cooldown_until, now, today)
            )
        else:
            conn.execute(
                """
                UPDATE api_key_status 
                SET status = ?, cooldown_until = ?, last_used = ?
                WHERE key_hash = ?
                """,
                (status, cooldown_until, now, k_hash)
            )
        conn.commit()


def get_keys_status(keys: list[str]) -> dict[str, dict]:
    """Sorgulanan tüm anahtarların güncel durum bilgilerini döner."""
    today = date.today().isoformat()
    now = time.time()
    result = {}
    
    if not keys:
        return result
        
    hashes = {hashlib.sha256(k.strip().encode("utf-8")).hexdigest(): k.strip() for k in keys if k.strip()}
    if not hashes:
        return result
        
    placeholders = ",".join("?" for _ in hashes)
    query = f"SELECT key_hash, masked_key, status, cooldown_until, daily_count, day FROM api_key_status WHERE key_hash IN ({placeholders})"
    
    with get_db() as conn:
        rows = conn.execute(query, list(hashes.keys())).fetchall()
        
    db_results = {}
    for row in rows:
        k_hash, masked, status, cooldown_until, daily_count, db_day = row
        
        # Geçersiz anahtarlar asla otomatik düzelmez
        if status == "invalid":
            pass
        # Yeni bir gün ise sayacı ve durumu sıfırla
        elif db_day != today:
            status = "active"
            cooldown_until = 0.0
            daily_count = 0
        # Cooldown süresi dolduysa aktif et
        elif status == "cooldown" and cooldown_until <= now:
            status = "active"
            cooldown_until = 0.0
            
        db_results[k_hash] = {
            "masked": masked,
            "status": status,
            "cooldown_until": cooldown_until,
            "daily_count": daily_count
        }
        
    for k_hash, original_key in hashes.items():
        if k_hash in db_results:
            result[original_key] = db_results[k_hash]
        else:
            result[original_key] = {
                "masked": _mask_api_key(original_key),
                "status": "active",
                "cooldown_until": 0.0,
                "daily_count": 0
            }
            
    return result

