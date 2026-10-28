"""
RQ (Redis Queue) thin wrapper — multi-worker background job altyapısı.

NEDEN RQ?
  - Mevcut job fonksiyonları zaten senkron (LLM çağrıları + IO) → RQ'nun process-pool
    modeline doğrudan uyuyor.
  - Celery'den çok daha hafif (tek dosya import, ekstra broker yok — sadece Redis).
  - FastAPI endpoint'leri async kalır, job'lar ayrı worker process'lerde çalışır.

MİMARİ:
  Web (uvicorn) → enqueue job → Redis → RQ worker → execute → result back to Redis
  Web (status poll) → fetch from Redis → return to client

KULLANIM:
  # Endpoint'te:
  from rq_queue import is_enabled, enqueue, set_cancel_flag, fetch_job_status
  if is_enabled():
      job_id = enqueue(my_task_function, arg1, arg2, job_timeout=600)
  else:
      # fallback: threading (mevcut davranış)

  # Task function (RQ worker process'inde çalışır):
  def my_task_function(arg1, arg2):
      from rq_queue import current_job_id, is_cancelled, update_meta
      jid = current_job_id()
      update_meta(jid, status="running", progress=0)
      if is_cancelled(jid):
          return {"status": "cancelled"}
      ...
      return {"status": "done", "result": ...}

DEPLOY:
  Production'da: ana process uvicorn, AYRI process'lerde `rq worker --url $REDIS_URL`.
  Docker compose örneği için README'ye bakın.

DEV ORTAMI:
  REDIS_URL tanımsızsa is_enabled()=False döner — mevcut threading fallback'i devreye girer.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Optional

REDIS_URL = (os.getenv("REDIS_URL") or "").strip()
QUEUE_NAME = os.getenv("RQ_QUEUE_NAME", "lostick").strip() or "lostick"

# Cancel flag TTL — eski flag'leri otomatik temizle (worker bittiyse flag artık önemsiz)
_CANCEL_FLAG_TTL_SECONDS = 3600

# Lazy init — rq/redis import'unu modül yüklenir yüklenmez yapma, kullanıcı modülü
# REDIS_URL olmadan da import etsin (fallback path'te zaten kullanılmıyor).
_redis_conn = None
_queue = None
_initialized = False
_init_error: Optional[str] = None


def _init() -> None:
    """RQ + Redis bağlantısını lazy init eder. Sadece ilk kullanımda çalışır."""
    global _redis_conn, _queue, _initialized, _init_error
    if _initialized:
        return
    _initialized = True
    if not REDIS_URL:
        return  # is_enabled() False döner
    try:
        import redis
        from rq import Queue
    except ImportError as e:
        _init_error = f"rq/redis kurulu değil: {e}"
        print(f"⚠️ RQ: {_init_error} → threading fallback kullanılacak")
        return
    try:
        _redis_conn = redis.from_url(REDIS_URL)
        _redis_conn.ping()  # Bağlantıyı erkenden doğrula
        _queue = Queue(QUEUE_NAME, connection=_redis_conn)
        print(f"🧵 RQ aktif — queue={QUEUE_NAME!r}, redis={REDIS_URL.split('@')[-1][:40]}")
    except Exception as e:
        _init_error = f"Redis bağlantısı başarısız: {e}"
        print(f"⚠️ RQ: {_init_error} → threading fallback kullanılacak")
        _redis_conn = None
        _queue = None


def is_enabled() -> bool:
    """RQ + Redis kullanılabilir mi? False ise endpoint'ler threading fallback'e düşer."""
    _init()
    return _queue is not None


def enqueue(
    func: Callable,
    *args,
    job_id: Optional[str] = None,
    job_timeout: int = 600,
    result_ttl: int = 86400,
    **kwargs,
) -> str:
    """Bir fonksiyonu RQ kuyruğuna ekler, job_id döner.

    job_timeout: Worker'da maksimum çalışma süresi (saniye). Aşılırsa job FAILED.
    result_ttl: Sonucun Redis'te tutulma süresi (saniye). Default 24sa.
    """
    _init()
    if _queue is None:
        raise RuntimeError("RQ aktif değil. is_enabled() ile kontrol edin.")
    job = _queue.enqueue(
        func,
        *args,
        job_id=job_id,
        job_timeout=job_timeout,
        result_ttl=result_ttl,
        failure_ttl=86400,
        **kwargs,
    )
    return job.id


def fetch_job_status(job_id: str) -> Optional[dict]:
    """Bir job'un durumunu döner.

    Returns: {status, result, error, meta, created_at, ended_at} | None (job yoksa)
    status: queued|started|deferred|finished|failed|stopped|canceled
    """
    _init()
    if _redis_conn is None:
        return None
    try:
        from rq.job import Job
        job = Job.fetch(job_id, connection=_redis_conn)
    except Exception:
        return None

    # Worker exception varsa exc_info doludur
    error = None
    if job.is_failed:
        error = (job.exc_info or "").strip().split("\n")[-1][:500] or "failed"

    return {
        "status": job.get_status(),
        "result": job.result,
        "error": error,
        "meta": dict(job.meta or {}),
        "created_at": job.created_at.timestamp() if job.created_at else None,
        "ended_at": job.ended_at.timestamp() if job.ended_at else None,
    }


def set_cancel_flag(job_id: str) -> None:
    """İptal isteği bayrağı koyar. Worker fonksiyonu periyodik olarak `is_cancelled` ile bakar.

    Tasarım kararı: RQ'nun built-in job.cancel()'ını ÇAĞIRMIYORUZ. Çünkü:
      - RQ 2.x'te queued bir job'u cancel() etmek onu kuyruktan komple silebilir
        → fetch_job_status None döner, frontend "Job bulunamadı" der.
      - Tüm cancel akışı tek pattern olsun: worker job'u alır, task fonksiyonu
        ilk satırda is_cancelled() bakar, hemen `{"status": "cancelled"}` döner.
      - Çalışan job'lar zaten flag pattern'i gerektiriyor (process-kill istemiyoruz).
      - Sonuç: queued ve running job'lar AYNI mekanizmayla iptal olur, edge case yok.
    """
    _init()
    if _redis_conn is None:
        return
    try:
        _redis_conn.setex(f"lostick:cancel:{job_id}", _CANCEL_FLAG_TTL_SECONDS, "1")
    except Exception as e:
        print(f"⚠️ set_cancel_flag({job_id[:8]}): {e}")


def is_cancelled(job_id: str) -> bool:
    """Worker fonksiyonu içinden iptal kontrolü. Periyodik olarak çağrılmalı."""
    _init()
    if _redis_conn is None:
        return False
    try:
        return bool(_redis_conn.exists(f"lostick:cancel:{job_id}"))
    except Exception:
        return False


def update_meta(job_id: str, **fields) -> None:
    """Worker'dan job meta'sını günceller (progress, ara durum vb.). En iyi-çaba."""
    _init()
    if _redis_conn is None:
        return
    try:
        from rq.job import Job
        job = Job.fetch(job_id, connection=_redis_conn)
        job.meta.update(fields)
        job.save_meta()
    except Exception:
        pass


def current_job_id() -> Optional[str]:
    """RQ worker context'inde çalışan task'in job_id'sini döner."""
    try:
        from rq import get_current_job
        job = get_current_job()
        return job.id if job else None
    except Exception:
        return None
