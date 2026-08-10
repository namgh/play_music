"""요청 의존성 — 인증과 권한.

**핵심 규칙 (`SERVER_ACCOUNTS.md` 3절): 플랫폼 역할이 리소스 접근을 자동으로 주지
않는다.** `admin` 이라고 남의 프로젝트를 열 수 있으면 그건 기능이 아니라 사고다.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Annotated

import jwt
from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.core.errors import Forbidden, Unauthorized
from app.core.security import decode_access_token
from app.db.models import User
from app.db.session import session_scope


async def get_db() -> AsyncIterator[AsyncSession]:
    async with session_scope() as session:
        yield session


Db = Annotated[AsyncSession, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


async def current_user(
    request: Request,
    session: Db,
    settings: Config,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthorized("로그인이 필요합니다", code="missing_token")
    token = authorization.split(" ", 1)[1].strip()

    try:
        payload = decode_access_token(token, secret=settings.jwt_secret.get_secret_value())
    except jwt.ExpiredSignatureError:
        raise Unauthorized("토큰이 만료됐습니다", code="token_expired") from None
    except jwt.PyJWTError:
        raise Unauthorized("토큰이 올바르지 않습니다", code="invalid_token") from None

    user = await session.get(User, uuid.UUID(payload["sub"]))
    if user is None or user.deleted_at is not None:
        raise Unauthorized("계정을 찾을 수 없습니다", code="account_not_found")

    # 대리 접속이면 담당자 id 를 함께 들고 다닌다. 감사 로그가 둘 다 남겨야 한다
    request.state.actor_id = uuid.UUID(payload.get("act", payload["sub"]))
    request.state.user_id = user.id
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def active_user(user: CurrentUser) -> User:
    """편집이 필요한 엔드포인트용.

    `suspended` 는 **로그인과 반출은 되고 편집만 막는다** — 정지는 서비스 이용
    제한이지 창작물을 인질로 잡는 것이 아니다 (`SERVER_ACCOUNTS.md` 1절).
    """
    if user.status == "suspended":
        raise Forbidden("계정이 정지된 상태입니다", code="account_suspended")
    if user.status in ("deleted", "purged"):
        raise Forbidden("삭제된 계정입니다", code="account_deleted")
    return user


ActiveUser = Annotated[User, Depends(active_user)]


def require_platform_role(*roles: str):
    """어드민 전용 엔드포인트. **리소스 접근을 주지는 않는다**"""

    async def dependency(user: CurrentUser) -> User:
        if user.platform_role not in roles:
            raise Forbidden("권한이 없습니다", code="insufficient_role")
        return user

    return dependency


def client_ip(request: Request) -> str | None:
    # 프록시 뒤에 있을 때만 신뢰한다. 신뢰 경계 밖의 X-Forwarded-For 는 위조 가능
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None
