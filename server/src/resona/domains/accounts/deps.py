"""계정 도메인의 Depends — **누구인가, 지금 편집해도 되는가.**

`core/deps.py` 에 두면 인프라 계층이 `User` 모델을 알게 된다. 그러면 "core 는
도메인 지식 0" 이 깨지고, 나중에 계정을 떼어낼 때 인프라까지 따라 나온다.
Db·Config 같은 진짜 인프라만 core 에 남긴다.
"""

import uuid
from typing import Annotated

import jwt
from fastapi import Depends, Header, Request

from resona.core.deps import Config, Db
from resona.core.errors import Forbidden, Unauthorized
from resona.core.security import decode_access_token
from resona.domains.accounts.models import User


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
    # **`deleted` 는 통과시킨다.** 30일 유예 안에 스스로 되돌릴 수 있어야 하는데,
    # 여기서 401 로 끊으면 복구 엔드포인트(`POST /v1/me/restore`)조차 못 부른다.
    # 편집을 막는 것은 `active_user` 의 일이다 — 인증과 권한을 섞지 않는다
    if user is None or user.status == "purged":
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


# --- 플랫폼 역할 게이트 -------------------------------------------------------
#
# 어드민 엔드포인트가 쓰는 타입. **리소스 접근은 주지 않는다** — 2축 권한이라
# 플랫폼 admin 이라도 남의 워크스페이스에는 못 들어간다 (`SERVER_ACCOUNTS.md` 3절).

Support = Annotated[User, Depends(require_platform_role("support", "admin", "owner"))]
Admin = Annotated[User, Depends(require_platform_role("admin", "owner"))]
Owner = Annotated[User, Depends(require_platform_role("owner"))]
