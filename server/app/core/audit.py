"""감사 로그 — append only (`SERVER_ACCOUNTS.md` 6절).

**남긴다:** 로그인, 비밀번호 변경, 토큰 재사용 감지, 플랜 변경, 정지, 대리 접속,
어드민의 모든 변경 행위, 계정 삭제.

**남기지 않는다:** 프로젝트 편집 내용. 사용자의 창작 활동을 추적하지 않는다.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AuditLog


async def record(
    session: AsyncSession,
    *,
    action: str,
    actor_id: uuid.UUID | None = None,
    on_behalf_of: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    detail: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    """대리 접속이면 `actor_id`(담당자)와 `on_behalf_of`(사용자)를 **둘 다** 남긴다.
    하나만 남기면 누가 했는지 또는 누구 것인지를 모른다."""
    session.add(
        AuditLog(
            actor_id=actor_id,
            on_behalf_of=on_behalf_of,
            action=action,
            target_type=target_type,
            target_id=target_id,
            detail=detail,
            ip=ip,
        )
    )
