"""요청 의존성 — 인증과 권한.

**핵심 규칙 (`SERVER_ACCOUNTS.md` 3절): 플랫폼 역할이 리소스 접근을 자동으로 주지
않는다.** `admin` 이라고 남의 프로젝트를 열 수 있으면 그건 기능이 아니라 사고다.
"""

from __future__ import annotations

import ipaddress
import logging
import uuid
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from resona.config import Settings, get_settings
from resona.core.errors import Forbidden, Unauthorized
from resona.core.security import decode_access_token
from resona.db.models import User
from resona.db.session import session_scope

log = logging.getLogger(__name__)


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


def client_ip(request: Request) -> str | None:
    """**신뢰하는 프록시에서 온 요청만 `X-Forwarded-For` 를 본다.**

    이 값이 로그인·가입·비밀번호 재설정 레이트리밋의 키다. 무조건 믿으면 헤더를
    매 요청마다 바꾸는 것만으로 `fail_closed` 로 세게 잠근 리밋이 전부 0 이 된다 —
    계정 대량 생성, 재설정 메일 폭탄(발신 계정이 정지되면 확인·초대 메일이 통째로
    멈춘다), 비밀번호 스프레이가 무제한이 된다. 감사 로그의 IP 도 전부 공격자가
    쓴 값이 되어 사고 조사가 불가능해진다. 한때 정확히 그 상태였다.

    체인은 **오른쪽에서부터** 신뢰 대역을 걷어낸다. 맨 왼쪽 값은 언제나 클라이언트가
    직접 쓴 값이라 신뢰할 수 없다.
    """
    peer = request.client.host if request.client else None
    trusted = _trusted_networks(get_settings())
    if not trusted or peer is None or not _in_networks(peer, trusted):
        return peer

    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return peer
    for candidate in reversed([p.strip() for p in forwarded.split(",") if p.strip()]):
        # **파싱되는 주소만 받는다.** 아무 문자열이나 통과시키면 그게 그대로
        # 레이트리밋 키와 감사 로그의 IP 가 된다 — 위조 방어를 넣고도 우회당한다
        if not _is_ip(candidate):
            continue
        if not _in_networks(candidate, trusted):
            return candidate
    return peer


@lru_cache(maxsize=8)
def _parse_networks(
    cidrs: tuple[str, ...],
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    nets = []
    for cidr in cidrs:
        try:
            nets.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            log.warning("invalid_trusted_proxy_cidr", extra={"cidr": cidr})
    return tuple(nets)


def _trusted_networks(settings: Settings):
    return _parse_networks(tuple(settings.trusted_proxy_cidrs))


def _is_ip(addr: str) -> bool:
    try:
        ipaddress.ip_address(addr)
    except ValueError:
        return False
    return True


def _in_networks(addr: str, networks) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in net for net in networks)
