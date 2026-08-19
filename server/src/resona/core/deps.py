"""요청 의존성 — 인증과 권한.

**핵심 규칙 (`SERVER_ACCOUNTS.md` 3절): 플랫폼 역할이 리소스 접근을 자동으로 주지
않는다.** `admin` 이라고 남의 프로젝트를 열 수 있으면 그건 기능이 아니라 사고다.
"""

from __future__ import annotations

import ipaddress
import logging
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from resona.core.config import Settings, get_settings
from resona.core.db import session_scope

log = logging.getLogger(__name__)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with session_scope() as session:
        yield session


Db = Annotated[AsyncSession, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


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
