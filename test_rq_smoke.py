"""
RQ entegrasyonu end-to-end smoke test'i.

Phase 1'in (anlatım job'unun RQ migration'ı) çalıştığını doğrulamadan ÖNCE
rq_queue.py'nin temel mekanizmaları (enqueue + status + meta + cancel) düzgün
çalışıyor mu test eder.

ÖN GEREKLİ:
    1) Redis çalışıyor:
       Docker:   docker run -d -p 6379:6379 --name lostick-redis redis:7-alpine
       Windows:  Memurai veya WSL altında native redis-server
    2) REDIS_URL set:
       PowerShell: $env:REDIS_URL = "redis://localhost:6379/0"
       Bash:       export REDIS_URL=redis://localhost:6379/0
    3) Bağımlılıklar kurulu: pip install -r requirements.txt

ÇALIŞTIRMA:
    python test_rq_smoke.py

NE TEST EDİYOR:
    - is_enabled() Redis'e gerçek bağlanıyor mu?
    - enqueue → fetch_job_status round-trip
    - Worker fonksiyonu meta güncelleyebiliyor mu (update_meta)
    - Cancel flag worker tarafından okunabiliyor mu (is_cancelled)
    - SimpleWorker burst mode bu process'te işliyor mu (Windows-uyumlu)

NOT: Bu test main.py'yi import ETMEZ — sadece izole test task'i kullanır.
Anlatım endpoint'inin RQ entegrasyonu için ayrıca HTTP runbook gerekir.
"""

from __future__ import annotations

import os
import sys
import time

if not os.getenv("REDIS_URL", "").strip():
    print("❌ REDIS_URL set edilmedi.")
    print("   PowerShell: $env:REDIS_URL = \"redis://localhost:6379/0\"")
    print("   Bash:       export REDIS_URL=redis://localhost:6379/0")
    sys.exit(1)

import rq_queue
# NOT: Task fonksiyonu AYRI bir modülde tanımlanmalı — RQ __main__'den
# fonksiyon kabul etmiyor ("Functions from the __main__ module cannot be
# processed by workers"). Bu yüzden _rq_test_helper.py'da duruyor.
from _rq_test_helper import smoke_task as _smoke_task  # noqa: F401


def _run_burst_worker() -> None:
    """Aynı process'te tek seferlik worker — SimpleWorker (Windows-uyumlu, no fork)."""
    from rq import SimpleWorker, Queue
    import redis

    conn = redis.from_url(os.getenv("REDIS_URL"))
    queue_name = os.getenv("RQ_QUEUE_NAME", "lostick")
    queue = Queue(queue_name, connection=conn)
    worker = SimpleWorker([queue], connection=conn)
    worker.work(burst=True)


# ─── Senaryolar ────────────────────────────────────────────────────


def test_normal_flow() -> None:
    print("\n--- Test 1: Normal task akışı ---")
    jid = rq_queue.enqueue(_smoke_task, "hello_lostick", 3, 0.1, job_timeout=10)
    print(f"  enqueue → {jid[:12]}…")

    initial = rq_queue.fetch_job_status(jid)
    assert initial is not None, "fetch_job_status None döndü"
    assert initial["status"] in ("queued", "started", "deferred"), (
        f"Beklenen queued/started, alınan {initial['status']}"
    )
    print(f"  initial status={initial['status']}")

    _run_burst_worker()
    print("  burst worker bitti")

    final = rq_queue.fetch_job_status(jid)
    assert final["status"] == "finished", f"Beklenen finished, alınan {final['status']}"
    assert final["result"]["status"] == "done"
    assert final["result"]["echo"] == "hello_lostick"
    assert final["result"]["completed"] == 3
    assert final["meta"].get("phase") == "tick_3/3", (
        f"meta.phase beklenmedik: {final['meta']}"
    )
    print(
        f"  ✓ final: status={final['status']}, result={final['result']}, "
        f"meta.phase={final['meta']['phase']}"
    )


def test_cancel_before_run() -> None:
    print("\n--- Test 2: Worker görmeden cancel flag konuyor ---")
    jid = rq_queue.enqueue(_smoke_task, "to_cancel", 5, 0.05)
    rq_queue.set_cancel_flag(jid)
    assert rq_queue.is_cancelled(jid) is True
    print("  cancel flag SET, is_cancelled=True")

    _run_burst_worker()

    final = rq_queue.fetch_job_status(jid)
    # Task fonksiyonu kendi içinde "cancelled" döndü → status=finished
    # ama result.status=cancelled
    assert final["status"] == "finished", f"alınan: {final['status']}"
    assert final["result"]["status"] == "cancelled"
    assert final["result"]["completed"] == 0
    print(
        f"  ✓ result.status={final['result']['status']}, "
        f"completed={final['result']['completed']} (worker tick atmadan çıktı)"
    )


def test_meta_updates() -> None:
    print("\n--- Test 3: Worker meta'sını update_meta ile yazıyor ---")
    jid = rq_queue.enqueue(_smoke_task, "meta_check", 4, 0.05)
    _run_burst_worker()
    status = rq_queue.fetch_job_status(jid)
    assert status["meta"].get("message") == "meta_check"
    assert status["meta"].get("phase") == "tick_4/4"
    print(f"  ✓ meta: {status['meta']}")


def main() -> None:
    if not rq_queue.is_enabled():
        print(
            "❌ rq_queue.is_enabled()=False — Redis bağlantısı başarısız.\n"
            f"   REDIS_URL={os.getenv('REDIS_URL')}\n"
            f"   init_error={rq_queue._init_error}"
        )
        sys.exit(2)
    print("✓ Redis erişilebilir, queue aktif\n")

    test_normal_flow()
    test_cancel_before_run()
    test_meta_updates()

    print("\n🎉 RQ END-TO-END SMOKE TESTLERİ GEÇTİ")
    print(
        "   Sonraki adım: HTTP runbook ile anlatım endpoint'ini test et "
        "(README'deki Phase 1 Test bölümüne bak veya konuşmadaki runbook'u izle)."
    )


if __name__ == "__main__":
    main()
