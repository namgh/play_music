"""보안 경계 — **헤더 한 줄로 무너지지 않는지**.

`X-Forwarded-For` 가 여기 있는 이유: 그 값이 로그인·가입·비밀번호 재설정
레이트리밋의 키다. 무조건 믿으면 헤더를 매번 바꾸는 것만으로 `fail_closed` 로
세게 잠근 리밋이 전부 0 이 된다. 한때 정확히 그 상태였다.
"""

from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from resona.core.config import get_settings
from resona.core.deps import client_ip


def _request(peer: str | None, forwarded: str | None = None):
    """`client_ip` 이 보는 것만 갖춘 최소한의 가짜 요청"""

    class Req:
        def __init__(self) -> None:
            self.headers = Headers({"x-forwarded-for": forwarded} if forwarded else {})
            self.client = type("C", (), {"host": peer})() if peer else None

    return Req()


@pytest.fixture
def trusted(monkeypatch):
    """프록시 대역을 설정한 상태"""
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8,192.168.0.0/16")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def untrusted(monkeypatch):
    """기본값 — 프록시를 신뢰하지 않는다"""
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_forwarded_header_is_ignored_without_trusted_proxies(untrusted):
    """**기본값이 안전해야 한다.** 설정을 안 하면 헤더를 아예 안 본다"""
    assert client_ip(_request("203.0.113.9", "1.2.3.4")) == "203.0.113.9"


def test_forwarded_header_is_ignored_from_untrusted_peer(trusted):
    """프록시 대역 밖에서 온 요청의 헤더는 **위조**로 본다"""
    assert client_ip(_request("203.0.113.9", "1.2.3.4")) == "203.0.113.9"


def test_forwarded_header_is_used_from_trusted_peer(trusted):
    assert client_ip(_request("10.0.0.5", "203.0.113.9")) == "203.0.113.9"


def test_chain_is_stripped_from_the_right(trusted):
    """**오른쪽에서부터 신뢰 대역을 걷어낸다.**

    맨 왼쪽 값은 언제나 클라이언트가 직접 쓴 값이라 신뢰할 수 없다 —
    공격자가 `X-Forwarded-For: 1.1.1.1` 을 붙여 보내면 프록시가 그 뒤에
    진짜 IP 를 덧붙이기 때문이다.
    """
    got = client_ip(_request("10.0.0.5", "9.9.9.9, 203.0.113.9, 10.0.0.7"))
    assert got == "203.0.113.9"


def test_garbage_header_falls_back_to_peer(trusted):
    assert client_ip(_request("10.0.0.5", "not-an-ip")) == "10.0.0.5"


def test_all_trusted_chain_falls_back_to_peer(trusted):
    assert client_ip(_request("10.0.0.5", "10.0.0.6, 10.0.0.7")) == "10.0.0.5"


async def test_forged_header_cannot_bypass_the_signup_limit(client, untrusted):
    """**끝까지 확인한다.** 헤더를 매번 바꿔도 가입 리밋이 걸려야 한다 —
    안 걸리면 계정 대량 생성과 메일 폭탄이 무제한이다"""
    import uuid

    statuses = []
    for i in range(9):
        res = await client.post(
            "/v1/auth/signup",
            json={"email": f"spam-{uuid.uuid4().hex[:10]}@example.com", "password": "x" * 12},
            headers={"X-Forwarded-For": f"5.5.5.{i}"},  # 매번 다른 IP 인 척
        )
        statuses.append(res.status_code)

    assert 429 in statuses, "위조 헤더로 레이트리밋을 우회했다"
