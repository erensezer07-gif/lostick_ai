"""RQ test task — sadece test için. RQ worker'ı bu modülü import eder."""
import time
import rq_queue


def smoke_task(message: str, ticks: int = 3, sleep_seconds: float = 0.02) -> dict:
    """Periyodik meta + cancel-check yapan test task'i.

    Args:
        message: Task'in geri döneceği echo metni
        ticks: Kaç defa tick atacak
        sleep_seconds: Her tick'ler arası bekleme (cancel'ı yakalamak için)
    """
    jid = rq_queue.current_job_id() or "?"
    rq_queue.update_meta(jid, phase="started", message=message)
    completed = 0
    for i in range(ticks):
        if rq_queue.is_cancelled(jid):
            return {"status": "cancelled", "completed": completed}
        time.sleep(sleep_seconds)
        completed += 1
        rq_queue.update_meta(jid, phase=f"tick_{completed}/{ticks}")
    return {"status": "done", "echo": message, "completed": completed}
