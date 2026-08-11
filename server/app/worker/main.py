"""워커 — 잡 테이블에서 임대해 처리한다 (`SERVER.md` 2절).

`BackgroundTasks` 를 쓰지 않는 이유가 여기 다 있다: 재시도, 관측, 종료 시 반납,
그리고 **잡과 결과가 같은 트랜잭션**.

임대 방식이라 **최소 한 번(at-least-once)** 실행된다 → 처리는 반드시 멱등해야 한다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import socket
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.config import get_settings
from app.core import events
from app.core import redis as r
from app.db.session import dispose_engine, init_engine, session_scope
from app.logging import setup_logging
from app.services import entitlements
from app.worker import mailer

log = logging.getLogger(__name__)

LEASE_SEC = 300
POLL_INTERVAL_SEC = 1.0
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

# **SKIP LOCKED 가 핵심이다.** 워커 M개가 동시에 돌아도 같은 잡을 두 번 집지 않는다
CLAIM_SQL = text(
    """
    UPDATE ai_jobs SET
        status = 'running',
        locked_by = :worker,
        locked_until = now() + make_interval(secs => :lease),
        attempts = attempts + 1,
        started_at = coalesce(started_at, now())
    WHERE id = (
        SELECT id FROM ai_jobs
        WHERE (status = 'queued' AND run_after <= now())
           OR (status = 'running' AND locked_until < now())
        ORDER BY priority DESC, run_after
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, org_id, user_id, kind, attempts, max_attempts
    """
)

RELEASE_SQL = text(
    """
    UPDATE ai_jobs
    SET status = 'queued', locked_by = NULL, locked_until = NULL
    WHERE id = :job_id AND locked_by = :worker AND status = 'running'
    """
)


class Worker:
    def __init__(self) -> None:
        self._stopping = asyncio.Event()
        self._current: uuid.UUID | None = None

    def request_stop(self) -> None:
        log.info("worker_stop_requested")
        self._stopping.set()

    async def run(self) -> None:
        while not self._stopping.is_set():
            try:
                claimed = await self._tick()
            except Exception:  # noqa: BLE001 — 루프가 죽으면 워커가 멈춘다
                log.exception("worker_tick_failed")
                claimed = False

            # 메일도 같은 워커가 보낸다. 프로세스를 하나 더 두면 배포 대상이 늘고
            # 메일은 그 값어치가 없다 — 대신 한 사이클 상한을 둬서 AI 잡을 굶기지 않는다
            try:
                sent = await mailer.drain(WORKER_ID)
            except Exception:  # noqa: BLE001
                log.exception("mail_drain_failed")
                sent = 0

            if not claimed and not sent:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stopping.wait(), POLL_INTERVAL_SEC)

    async def _tick(self) -> bool:
        async with session_scope() as session:
            row = (
                await session.execute(CLAIM_SQL, {"worker": WORKER_ID, "lease": LEASE_SEC})
            ).first()
            if row is None:
                return False
            job_id, org_id, user_id, kind, attempts, max_attempts = row
            self._current = job_id

        log.info("job_claimed", extra={"job_id": str(job_id), "kind": kind})
        # 눌러 놓고 기다리는 사람에게 **바로 알려 준다**. 실패해도 잡 처리는 계속된다
        await events.publish(str(user_id), events.job_event(str(job_id), "running"))
        try:
            await self._handle(job_id, org_id, user_id, kind)
            await events.publish(str(user_id), events.job_event(str(job_id), "succeeded"))
        except Exception as exc:  # noqa: BLE001
            await self._fail(job_id, exc, attempts, max_attempts)
            await events.publish(
                str(user_id),
                events.job_event(str(job_id), "failed", retryable=attempts < max_attempts),
            )
        finally:
            self._current = None
        return True

    async def _handle(
        self, job_id: uuid.UUID, org_id: uuid.UUID, user_id: uuid.UUID, kind: str
    ) -> None:
        async with session_scope() as session:
            # 실제 AI 호출은 Phase 3. 지금은 배선과 계약만 세워 둔다
            result = {"kind": kind, "note": "AI 생성은 Phase 3 에서 붙는다"}

            await session.execute(
                text(
                    "UPDATE ai_jobs SET status='succeeded', finished_at=now(), error=NULL "
                    "WHERE id=:id"
                ),
                {"id": job_id},
            )
            # **성공한 잡과 같은 트랜잭션에서 사용량을 남긴다** (`SERVER_BILLING.md` 4-1).
            # 나누면 "생성은 됐는데 카운트가 안 된" 경우가 생기고 나중에 찾기 어렵다
            await entitlements.record_usage(
                session, org_id=org_id, user_id=user_id, kind="ai_job", job_id=job_id
            )
            log.info("job_succeeded", extra={"job_id": str(job_id), "result": result})

    async def _fail(
        self, job_id: uuid.UUID, exc: Exception, attempts: int, max_attempts: int
    ) -> None:
        give_up = attempts >= max_attempts
        # 지수 백오프로 `run_after` 를 민다
        delay = min(300, 2**attempts)
        async with session_scope() as session:
            await session.execute(
                text(
                    "UPDATE ai_jobs SET "
                    "  status = CASE WHEN :give_up THEN 'failed' ELSE 'queued' END, "
                    "  error = :err, locked_by = NULL, locked_until = NULL, "
                    "  run_after = now() + make_interval(secs => :delay), "
                    "  finished_at = CASE WHEN :give_up THEN now() ELSE NULL END "
                    "WHERE id = :id"
                ),
                {"id": job_id, "err": f"{type(exc).__name__}: {exc}"[:1000],
                 "give_up": give_up, "delay": delay},
            )
        log.warning(
            "job_failed",
            extra={"job_id": str(job_id), "give_up": give_up, "attempts": attempts},
            exc_info=exc,
        )

    async def release_current(self) -> None:
        """**임대를 반납한다.** 그냥 죽으면 `locked_until`(5분)이 지나야 다른 워커가
        집는다 — 배포할 때마다 잡이 5분씩 멈춘다"""
        if self._current is None:
            return
        async with session_scope() as session:
            await session.execute(RELEASE_SQL, {"job_id": self._current, "worker": WORKER_ID})
        log.info("job_lease_released", extra={"job_id": str(self._current)})


async def main() -> None:
    settings = get_settings()
    setup_logging(settings)
    init_engine(settings)
    # 진행 알림을 publish 하려면 워커도 Redis 가 필요하다
    r.init_redis(settings)

    worker = Worker()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.request_stop)

    log.info("worker_started", extra={"worker_id": WORKER_ID})
    try:
        await worker.run()
    finally:
        await worker.release_current()
        await r.close_redis()
        await dispose_engine()
        log.info("worker_stopped")


def _stale_lease_cutoff() -> datetime:
    """만료된 임대를 판정하는 기준. 테스트가 직접 본다"""
    return datetime.now(UTC) - timedelta(seconds=LEASE_SEC)


if __name__ == "__main__":
    asyncio.run(main())
