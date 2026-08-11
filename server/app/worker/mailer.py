"""메일 발송 루프 — 아웃박스를 임대해 SMTP 로 보낸다.

잡 큐와 **같은 방식**이다 (`FOR UPDATE SKIP LOCKED` + 임대). 그래서 워커를 여러 개
띄워도 같은 메일을 두 번 보내지 않고, 재시도·백오프·관측이 공짜로 따라온다.

`smtplib` 는 블로킹이라 `asyncio.to_thread` 로 뺀다. 안 그러면 메일 하나가 15초
걸릴 때 그 프로세스의 AI 잡까지 전부 멈춘다.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import text

from app.db.session import session_scope
from app.services import mail

log = logging.getLogger(__name__)

LEASE_SEC = 120
BATCH = 10

CLAIM_SQL = text(
    """
    UPDATE email_outbox SET
        status = 'sending',
        locked_by = :worker,
        locked_until = now() + make_interval(secs => :lease),
        attempts = attempts + 1
    WHERE id = (
        SELECT id FROM email_outbox
        WHERE (status = 'queued' AND run_after <= now())
           OR (status = 'sending' AND locked_until < now())
        ORDER BY run_after
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, to_email, template, payload, attempts, max_attempts
    """
)


async def send_one(worker_id: str) -> bool:
    """한 통 보낸다. 보낼 게 없으면 False"""
    async with session_scope() as session:
        row = (
            await session.execute(CLAIM_SQL, {"worker": worker_id, "lease": LEASE_SEC})
        ).first()
        if row is None:
            return False
        mail_id, to_email, template, payload, attempts, max_attempts = row

    if not mail.is_configured():
        # 로컬 개발에서는 SMTP 설정이 없다. **큐에 그대로 두고** 로그만 남긴다 —
        # 여기서 failed 로 만들면 나중에 설정한 뒤에도 안 나간다
        log.warning(
            "smtp_not_configured", extra={"mail_id": str(mail_id), "template": template}
        )
        async with session_scope() as session:
            await session.execute(
                text(
                    "UPDATE email_outbox SET status='queued', locked_by=NULL, "
                    "locked_until=NULL, attempts = attempts - 1, "
                    "run_after = now() + interval '5 minutes' WHERE id = :id"
                ),
                {"id": mail_id},
            )
        return False

    try:
        await asyncio.to_thread(
            mail.send_now, to_email=to_email, template=template, payload=payload
        )
    except Exception as exc:  # noqa: BLE001
        await _fail(mail_id, exc, attempts, max_attempts)
        return True

    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE email_outbox SET status='sent', sent_at=now(), error=NULL, "
                "locked_by=NULL, locked_until=NULL WHERE id=:id"
            ),
            {"id": mail_id},
        )
    # **수신자 주소를 로그에 남기지 않는다** (`app/logging.py` 의 PiiFilter 와 같은 이유)
    log.info("mail_sent", extra={"mail_id": str(mail_id), "template": template})
    return True


async def _fail(mail_id, exc: Exception, attempts: int, max_attempts: int) -> None:
    permanent = mail.is_permanent_failure(exc)
    give_up = permanent or attempts >= max_attempts
    # 일시 장애는 넉넉히 물러선다. 1분 → 2분 → 4분 …
    delay = min(1800, 60 * (2 ** max(0, attempts - 1)))

    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE email_outbox SET "
                "  status = CASE WHEN :give_up THEN 'failed' ELSE 'queued' END, "
                "  error = :err, locked_by = NULL, locked_until = NULL, "
                "  run_after = now() + make_interval(secs => :delay) "
                "WHERE id = :id"
            ),
            {
                "id": mail_id,
                "err": f"{type(exc).__name__}: {exc}"[:1000],
                "give_up": give_up,
                "delay": delay,
            },
        )
    log.warning(
        "mail_failed",
        extra={"mail_id": str(mail_id), "permanent": permanent, "give_up": give_up},
        exc_info=exc,
    )


async def drain(worker_id: str, limit: int = BATCH) -> int:
    """한 사이클에 몇 통만 보낸다. **AI 잡이 굶지 않게** 상한을 둔다"""
    sent = 0
    for _ in range(limit):
        if not await send_one(worker_id):
            break
        sent += 1
    return sent


def now() -> datetime:
    return datetime.now(UTC)
