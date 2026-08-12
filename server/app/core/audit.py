"""감사 로그 — append only (`SERVER_ACCOUNTS.md` 6절).

**남긴다:** 로그인, 비밀번호 변경, 토큰 재사용 감지, 플랜 변경, 정지, 대리 접속,
어드민의 모든 변경 행위, 계정 삭제.

**남기지 않는다:** 프로젝트 편집 내용. 사용자의 창작 활동을 추적하지 않는다.
"""

from __future__ import annotations

import uuid
from typing import Any, NoReturn

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
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


async def persist_and_raise(session: AsyncSession, error: AppError) -> NoReturn:
    """**기록을 커밋한 뒤 거절한다.**

    이게 별도 함수인 이유: 예외는 트랜잭션을 롤백한다. 거절 직전에 남긴 감사
    로그·메일·상태 변경이 **통째로 사라진다.** 그리고 그 사라짐은 조용해서
    "기록하고 있다고 믿는" 상태로 오래 간다.

    실제로 이 저장소에서 세 번 났다:
      - 리프레시 재사용 감지가 전 세션을 폐기한 뒤 401 → 폐기가 취소됨
      - 가입 시도 알림 메일 + 감사 로그 → 409 와 함께 사라짐
      - **로그인 실패 감사 로그가 한 건도 안 남고 있었음** (401 이 매번 롤백)

    그래서 "거절하면서 흔적을 남기는" 모든 경로는 이 함수를 쓴다. `raise` 를
    직접 쓰면 다음 사람이 또 같은 것을 잃는다.
    """
    await session.commit()
    raise error
