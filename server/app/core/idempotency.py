"""멱등 키 — 모든 변경 요청이 쓴다 (`SERVER_OPS.md` 7절).

절차:
  1. 키로 조회 → 완료된 응답이 있으면 그대로 반환
  2. 없으면 (키, 요청 해시) INSERT — UNIQUE 충돌이면 **동시 요청**이다 → 409
  3. 처리 후 응답을 저장

같은 키에 **다른 본문**이 오면 422 로 거절한다. 재시도가 아니라 버그다.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Unprocessable
from app.db.models import IdempotencyKey


def request_digest(payload: Any) -> bytes:
    """본문을 정규화해서 해시한다. 키 순서가 달라도 같은 요청은 같은 해시여야 한다"""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).digest()


@dataclass
class Replay:
    status_code: int
    body: dict[str, Any]


async def begin(
    session: AsyncSession,
    *,
    key: str | None,
    user_id: uuid.UUID,
    endpoint: str,
    payload: Any,
) -> Replay | None:
    """이미 처리된 요청이면 `Replay`, 처음이면 None.

    키가 없으면 멱등 보장을 하지 않는다 — 클라이언트 선택이다.
    """
    if not key:
        return None

    digest = request_digest(payload)
    existing = (
        await session.execute(select(IdempotencyKey).where(IdempotencyKey.key == key))
    ).scalar_one_or_none()

    if existing is not None:
        if existing.request_hash != digest:
            raise Unprocessable(
                "같은 멱등 키로 다른 요청이 왔습니다",
                code="idempotency_key_reused",
            )
        if existing.completed_at is None:
            # 앞선 요청이 아직 처리 중이다. 재시도하게 둔다
            raise Conflict("같은 요청이 처리 중입니다", code="request_in_flight")
        return Replay(existing.response_status or 200, existing.response_body or {})

    session.add(
        IdempotencyKey(key=key, user_id=user_id, endpoint=endpoint, request_hash=digest)
    )
    try:
        await session.flush()
    except IntegrityError:
        # 동시에 같은 키가 들어왔다. 먼저 넣은 쪽이 처리한다
        await session.rollback()
        raise Conflict("같은 요청이 처리 중입니다", code="request_in_flight") from None
    return None


async def complete(
    session: AsyncSession, *, key: str | None, status_code: int, body: dict[str, Any]
) -> None:
    if not key:
        return
    record = (
        await session.execute(select(IdempotencyKey).where(IdempotencyKey.key == key))
    ).scalar_one_or_none()
    if record is None:
        return
    record.response_status = status_code
    record.response_body = body
    record.completed_at = datetime.now(UTC)
