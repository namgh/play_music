"""헬스체크 — **배포 중 사고를 막는 장치**.

`/healthz` 와 `/readyz` 를 나눈 이유가 코드에 적혀 있지만, 그게 실제로 그렇게
도는지는 테스트가 없으면 모른다. 특히 **드레인**은 배포할 때만 드러나는 경로라
사람이 발견하기 가장 어렵다.
"""

from __future__ import annotations

import pytest

from resona.api.v1 import health


@pytest.fixture(autouse=True)
def not_draining():
    health._draining = False
    yield
    health._draining = False


async def test_healthz_does_not_touch_dependencies(client):
    """DB 가 느릴 때 컨테이너가 재시작을 반복하면 **장애가 증폭된다**"""
    res = await client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_readyz_checks_db_and_migration(client):
    res = await client.get("/readyz")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready"
    assert body["checks"]["database"] == "ok"
    # 마이그레이션이 안 돌았으면 트래픽을 받으면 안 된다
    assert body["checks"]["migration"] not in (None, "none")


async def test_draining_makes_readyz_fail_first(client):
    """**SIGTERM → readyz 503 → LB 가 뺀다 → 진행 중 요청 완료 → 종료.**

    이 순서가 없으면 롤링 배포마다 LB 가 죽는 중인 인스턴스로 트래픽을 보내고
    사용자는 저장 실패를 본다.
    """
    health.begin_drain()

    res = await client.get("/readyz")
    assert res.status_code == 503
    assert res.json()["status"] == "draining"

    # **liveness 는 계속 성공해야 한다** — 여기서 실패하면 오케스트레이터가
    # 드레인 중인 컨테이너를 강제로 죽여서 진행 중 요청이 끊긴다
    assert (await client.get("/healthz")).status_code == 200


async def test_security_headers_are_present(client):
    res = await client.get("/healthz")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["content-security-policy"].startswith("default-src 'none'")
    assert res.headers["x-request-id"]


async def test_request_id_is_echoed_back(client):
    res = await client.get("/healthz", headers={"X-Request-Id": "trace-me-123"})
    assert res.headers["x-request-id"] == "trace-me-123"


async def test_oversized_body_is_rejected_before_parsing(client, unique_email):
    """**읽기 전에 거절한다.** 파싱한 뒤 거절하면 메모리는 이미 썼다 —
    인증 사용자 하나가 수백 MB 바디로 프로세스를 OOM 시킬 수 있었다"""
    from tests.test_projects import auth, signup

    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/projects",
        content=b"{}",
        headers={
            **auth(token),
            "content-type": "application/json",
            # 실제로 보내지 않고 선언만 해도 거절돼야 한다
            "content-length": str(50 * 1024 * 1024),
        },
    )
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "payload_too_large"


async def test_error_responses_carry_request_id(client):
    res = await client.get("/v1/projects")
    assert res.status_code == 401
    assert res.headers["x-request-id"]
    assert res.json()["error"]["request_id"] == res.headers["x-request-id"]
