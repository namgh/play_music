"""스케줄러 — 주기 작업 (`SERVER.md` 2절).

**API 프로세스 안에서 돌리지 않는다.** 인스턴스를 3개로 늘리는 순간 모든 정리 작업이
3번씩 돌고, 그게 삭제 작업이면 사고가 된다. 그래서 별도 프로세스이고, 그 프로세스가
2개 떠도 안전하도록 **작업마다 Redis 락**을 잡는다 (배포 중에는 잠깐 겹친다).

`SERVER_REDIS.md` 의 원칙대로 Redis 가 죽으면 **아무 것도 안 하고 넘어간다.** 락을
못 잡았는데 진행하는 것보다 한 주기 쉬는 편이 안전하다 — 여기 작업들은 전부 늦어도
되는 것뿐이다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.config import get_settings
from app.core import redis as r
from app.db.session import dispose_engine, init_engine, session_scope
from app.logging import setup_logging

log = logging.getLogger(__name__)

TICK_SEC = 60.0

# 미완료 업로드를 언제 치울지. 브라우저가 큰 파일을 올리는 시간보다 넉넉해야 한다 —
# 짧게 잡으면 **정상 업로드 중인 행을 지운다**
PENDING_ASSET_TTL = timedelta(hours=6)
SOFT_DELETE_GRACE = timedelta(days=30)
AUDIT_RETENTION = timedelta(days=365)
IDEMPOTENCY_TTL = timedelta(days=1)


async def _with_lock(name: str, ttl_sec: int, coro) -> None:
    """스케줄러가 둘 떠도 한 번만 돈다"""
    token = await r.acquire_lock(r.key("sched", name), ttl_sec)
    if token is None:
        return
    try:
        await coro
    finally:
        await r.release_lock(r.key("sched", name), token)


async def sweep_pending_assets() -> None:
    """올리다 만 에셋 행을 치운다.

    스토리지 객체는 **버킷 수명주기 규칙**이 지운다. 서버가 지우려 들면 스토리지가
    잠깐 안 될 때 행만 사라지고 객체가 남는다 — 그게 진짜 누수다.
    """
    async with session_scope() as session:
        res = await session.execute(
            text(
                "DELETE FROM assets WHERE status = 'pending' AND created_at < :cutoff"
            ),
            {"cutoff": datetime.now(UTC) - PENDING_ASSET_TTL},
        )
        if res.rowcount:
            log.info("swept_pending_assets", extra={"count": res.rowcount})


async def purge_soft_deleted() -> None:
    """30일 지난 삭제 프로젝트를 실제로 지운다 (`SERVER_DATA.md` 4-1).

    한 번에 다 지우지 않고 **배치로 자른다.** 큰 DELETE 하나는 오래 락을 쥐고
    복제 지연을 만든다. 남으면 다음 주기가 마저 한다.
    """
    async with session_scope() as session:
        res = await session.execute(
            text(
                """
                DELETE FROM projects WHERE id IN (
                    SELECT id FROM projects
                    WHERE deleted_at IS NOT NULL AND deleted_at < :cutoff
                    LIMIT 200
                )
                """
            ),
            {"cutoff": datetime.now(UTC) - SOFT_DELETE_GRACE},
        )
        if res.rowcount:
            log.info("purged_projects", extra={"count": res.rowcount})


async def roll_up_usage() -> None:
    """원장을 월별로 접는다. 접어 두면 한도 확인이 최근 몇 행만 더하면 끝난다.

    **원장은 지우지 않는다.** 분쟁이 나면 근거가 필요하다 — 접는 것은 읽기
    최적화지 삭제가 아니다.
    """
    async with session_scope() as session:
        await session.execute(
            text(
                """
                INSERT INTO usage_rollups (user_id, kind, period_start, quantity, rolled_at)
                SELECT user_id, kind, date_trunc('month', occurred_at)::date,
                       sum(quantity), now()
                FROM usage_events
                WHERE occurred_at < date_trunc('month', now())
                GROUP BY 1, 2, 3
                ON CONFLICT (user_id, kind, period_start)
                DO UPDATE SET quantity = excluded.quantity, rolled_at = excluded.rolled_at
                """
            )
        )


async def expire_impersonations() -> None:
    """시간이 지난 대리 접속을 강제로 끝낸다 (`SERVER_ACCOUNTS.md` 4절).

    담당자가 "종료"를 누르는 것에 의존하지 않는다 — 누르는 것을 잊는 쪽이 기본값이다.
    """
    async with session_scope() as session:
        res = await session.execute(
            text(
                """
                UPDATE impersonation_sessions SET ended_at = now()
                WHERE ended_at IS NULL AND expires_at < now()
                """
            )
        )
        if res.rowcount:
            log.warning("impersonation_force_ended", extra={"count": res.rowcount})


async def sweep_expired_tokens() -> None:
    async with session_scope() as session:
        await session.execute(
            text("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'")
        )
        await session.execute(text("DELETE FROM email_tokens WHERE expires_at < now()"))
        await session.execute(
            text("DELETE FROM idempotency_keys WHERE created_at < :cutoff"),
            {"cutoff": datetime.now(UTC) - IDEMPOTENCY_TTL},
        )


async def trim_audit_log() -> None:
    async with session_scope() as session:
        await session.execute(
            text("DELETE FROM audit_logs WHERE created_at < :cutoff"),
            {"cutoff": datetime.now(UTC) - AUDIT_RETENTION},
        )


# (이름, 주기(초), 함수). 주기를 코드에 두는 것은 cron 문자열보다 읽기 쉽고
# 무엇보다 **테스트에서 직접 부를 수 있어서**다
TASKS = [
    ("sweep_pending_assets", 3600, sweep_pending_assets),
    ("purge_soft_deleted", 3600, purge_soft_deleted),
    ("roll_up_usage", 3600, roll_up_usage),
    ("expire_impersonations", 60, expire_impersonations),
    ("sweep_expired_tokens", 3600, sweep_expired_tokens),
    ("trim_audit_log", 86400, trim_audit_log),
]


async def run() -> None:
    settings = get_settings()
    setup_logging(settings)
    init_engine(settings)
    r.init_redis(settings)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    log.info("scheduler_started", extra={"tasks": len(TASKS)})
    elapsed = 0.0
    while not stop.is_set():
        for name, period, fn in TASKS:
            if elapsed % period != 0:
                continue
            try:
                # 락 TTL 을 주기보다 짧게 잡는다. 프로세스가 죽어도 다음 주기에 풀린다
                await _with_lock(name, min(period, 300), fn())
            except Exception:  # noqa: BLE001
                # **한 작업이 죽어도 나머지는 돈다.** 여기서 예외가 새면
                # 정리 작업 전체가 조용히 멈춘다
                log.exception("scheduler_task_failed", extra={"task": name})

        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=TICK_SEC)
        elapsed += TICK_SEC

    log.info("scheduler_stopped")
    await dispose_engine()
    await r.close_redis()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
