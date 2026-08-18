"""SSE — 잡 진행 상황.

**진실은 언제나 DB 에 있다.** SSE 는 빨리 알려 주는 수단일 뿐이라, 이게 죽어도
클라이언트는 폴링으로 같은 상태를 안다. 그 성질을 여기서 잠근다.

여기만 **진짜 uvicorn 을 띄운다** (`live_server` 픽스처). httpx 의 ASGI 트랜스포트는
응답 본문을 통째로 모으기 때문에, 끝나지 않는 스트림은 거기서 영원히 안 끝난다 —
가짜 트랜스포트로 통과시켜 봐야 스트리밍을 검증한 것이 아니다.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from sqlalchemy import text

from app.core import events
from app.worker.main import Worker
from tests.test_projects import auth, signup


@pytest.fixture(autouse=True)
async def ai_quota_for_infra_tests(app, db):
    """**베타 기본값은 `ai_monthly: 0` 이다** — Phase 1 에 AI 가 없기 때문이다
    (`SERVER_PAYMENTS.md` 0절).

    이 파일이 보는 것은 요금제가 아니라 **잡 큐 인프라**(SKIP LOCKED·임대·재시도)라,
    필요한 권한을 명시적으로 켜고 끝나면 되돌린다. 제품 기본값에 기대면 요금 정책을
    바꿀 때마다 인프라 테스트가 같이 깨진다 — 실제로 그렇게 깨졌다.

    가입이 `subscriptions(plan_code='free')` 를 만들기 때문에 판정은 **DB 의 플랜
    행**을 읽는다. `DEFAULT_FREE_LIMITS` 는 구독 행이 없을 때만 쓰는 대비책이라
    거기를 건드려도 여기엔 아무 영향이 없다.
    """
    from sqlalchemy import text as _text

    await db.execute(
        _text("""UPDATE plans SET limits = limits || '{"ai_monthly": 50}' WHERE code = 'free'""")
    )
    await db.commit()
    yield
    await db.execute(
        _text("""UPDATE plans SET limits = limits || '{"ai_monthly": 0}' WHERE code = 'free'""")
    )
    await db.commit()


@pytest.fixture(autouse=True)
async def clean_jobs(app, db):
    await db.execute(text("DELETE FROM ai_jobs WHERE status IN ('queued','running')"))
    await db.commit()


class SSEReader:
    """프레임 단위로 읽는다.

    **응답 하나에 이터레이터는 하나뿐이다** — httpx 는 두 번 열면 거절한다.
    그래서 리더를 들고 다니며 필요한 만큼 꺼내 쓴다.
    """

    def __init__(self, response) -> None:
        self._chunks = response.aiter_text()
        self._buffer = ""
        self._pending: list[tuple[str, dict]] = []

    def _drain(self) -> None:
        while "\n\n" in self._buffer:
            block, self._buffer = self._buffer.split("\n\n", 1)
            if block.startswith(":") or not block.strip():
                continue  # 하트비트
            name, payload = "", "{}"
            for line in block.splitlines():
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    payload = line[6:]
            self._pending.append((name, json.loads(payload)))

    async def read(self, count: int, wait_sec: float = 5.0) -> list[tuple[str, dict]]:
        async def pump() -> None:
            while len(self._pending) < count:
                self._buffer += await anext(self._chunks)
                self._drain()

        async with asyncio.timeout(wait_sec):
            await pump()
        out, self._pending = self._pending[:count], self._pending[count:]
        return out


@pytest.fixture
async def http(live_server):
    async with httpx.AsyncClient(base_url=live_server, timeout=10.0) as ac:
        yield ac


async def test_stream_starts_with_a_snapshot(http, client, unique_email):
    """**붙자마자 현재 상태를 보낸다.** 구독 시작 전에 끝난 잡의 메시지는
    pub/sub 에서 사라지므로, 이게 없으면 클라이언트가 영원히 기다린다"""
    token = await signup(client, unique_email)
    job = (
        await client.post(
            "/v1/jobs", json={"kind": "generate_melody"}, headers=auth(token)
        )
    ).json()

    async with http.stream("GET", "/v1/events", headers=auth(token)) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        # 프록시가 버퍼링하면 이벤트가 뭉쳐서 늦게 온다
        assert response.headers["x-accel-buffering"] == "no"

        name, data = (await SSEReader(response).read(1))[0]
        assert name == "snapshot"
        assert [j["job_id"] for j in data["jobs"]] == [job["id"]]


async def test_worker_progress_reaches_the_stream(http, client, unique_email):
    """워커는 **어느 API 인스턴스에 그 사용자가 붙어 있는지 모른다.**
    그래서 Redis pub/sub 으로 던지고, 스트림을 든 쪽이 받는다"""
    token = await signup(client, unique_email)
    await client.post("/v1/jobs", json={"kind": "generate_melody"}, headers=auth(token))

    async with http.stream("GET", "/v1/events", headers=auth(token)) as response:
        reader = SSEReader(response)
        await reader.read(1)  # snapshot

        pending = asyncio.create_task(reader.read(2))
        await asyncio.sleep(0.2)  # 구독이 붙을 틈을 준다
        assert await Worker()._tick() is True

        frames = await pending
        statuses = [data["status"] for _, data in frames]
        assert statuses == ["running", "succeeded"]
        assert all(name == "job" for name, _ in frames)


async def test_events_require_auth(client):
    res = await client.get("/v1/events")
    assert res.status_code == 401


async def test_publish_never_raises_when_redis_is_down(monkeypatch):
    """**알림이 안 갔다고 잡 처리를 실패시키지 않는다.** 클라이언트는 폴링으로 안다"""
    import app.core.redis as r

    class Broken:
        async def publish(self, *a, **kw):
            raise ConnectionError("redis down")

    monkeypatch.setattr(r, "core", lambda: Broken())
    await events.publish("user-1", events.job_event("job-1", "running"))  # 안 터진다


async def test_stream_isolates_users(http, client, unique_email):
    """남의 잡 진행 상황이 흘러들면 안 된다"""
    mine = await signup(client, unique_email)
    other = await signup(client, f"other-{unique_email}")
    await client.post("/v1/jobs", json={"kind": "generate_melody"}, headers=auth(other))

    async with http.stream("GET", "/v1/events", headers=auth(mine)) as response:
        name, data = (await SSEReader(response).read(1))[0]
        assert name == "snapshot"
        assert data["jobs"] == [], "남의 잡이 보이면 안 된다"
