"""
Cross-platform RQ worker başlatıcı (Windows + Linux uyumlu).

Linux production'da `rq worker --url $REDIS_URL lostick` CLI'sı tercih edilir
(daha hızlı, process per job). Windows'ta fork olmadığı için bu script
SimpleWorker kullanır (no fork, aynı process'te sıralı icra).

KULLANIM (her iki platformda):
    # 1) Redis çalışıyor olmalı
    # 2) REDIS_URL set olmalı:
    #    PowerShell: $env:REDIS_URL = "redis://localhost:6379/0"
    #    Bash:       export REDIS_URL=redis://localhost:6379/0
    python run_worker.py

NOT: Worker process'i main.py'yi import eder — task fonksiyonlarının (örn.
_run_anlatim_generation_rq) bulunabilmesi için. Bu yüzden ilk başlangıç
yavaştır (LangChain + FastEmbed yükleniyor).
"""

from __future__ import annotations

import os
import sys

if not os.getenv("REDIS_URL", "").strip():
    print("❌ REDIS_URL set edilmedi.")
    print("   PowerShell: $env:REDIS_URL = \"redis://localhost:6379/0\"")
    print("   Bash:       export REDIS_URL=redis://localhost:6379/0")
    sys.exit(1)


def main() -> None:
    # main.py'yi yükle → task fonksiyonları (örn. _run_anlatim_generation_rq) içe
    # aktarılmış olur. RQ task'i pickle'dan unpickling sırasında bu modülü arayacak.
    print("⏳ main.py yükleniyor (LangChain + diğer ağır importlar) — biraz sürebilir...")
    import main  # noqa: F401
    print("✓ main yüklendi")

    from rq import SimpleWorker, Queue
    import redis

    redis_url = os.getenv("REDIS_URL")
    queue_name = os.getenv("RQ_QUEUE_NAME", "lostick")

    conn = redis.from_url(redis_url)
    try:
        conn.ping()
    except Exception as e:
        print(f"❌ Redis bağlantısı başarısız: {e}")
        sys.exit(2)

    queue = Queue(queue_name, connection=conn)
    print(f"🧵 RQ worker başlıyor — queue={queue_name!r}, redis={redis_url.split('@')[-1]}")
    print("   Ctrl+C ile durdurabilirsin.\n")

    worker = SimpleWorker([queue], connection=conn)
    worker.work(with_scheduler=False)


if __name__ == "__main__":
    main()
