"""테스트 준비 — **진짜 Postgres·Redis 로 돈다** (`SERVER_DATA.md` 6절).

SQLite 로 대체하지 않는다. JSONB·배열·부분 인덱스·자문 락이 전부 다르게 동작해서,
통과해도 아무것도 보장하지 못한다.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import uuid
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("ENV", "local")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://resona:resona@localhost:55432/resona"
)

# ---------------------------------------------------------------------------
# ⚠ **아래 셋은 `setdefault` 가 아니라 강제다.**
#
# `setdefault` 는 이미 있는 환경변수를 덮지 않는다. 그래서 `.env` 를 읽은 셸에서
# (`set -a; . ./.env`) 테스트를 돌리면 개발용 Redis **0·1번**을 그대로 쓰게 되는데,
# 아래 `app` 픽스처가 매 테스트마다 `flushdb()` 를 부른다 —
# **개발자의 로컬 Redis 가 통째로 지워진다.**
#
# 테스트 격리도 함께 깨진다. 개발 중 쌓인 레이트리밋·캐시·락이 남아 있는 상태로
# 돌게 되어, 어떤 테스트는 "혼자 돌리면 통과하는데 전체로는 실패"한다.
# 그런 실패는 원인을 찾는 데 몇 시간이 든다.
#
# 테스트가 볼 수 있는 자원은 테스트만의 것이어야 한다. 선택지가 아니다.
# ---------------------------------------------------------------------------
os.environ["KEY_PREFIX"] = "test:v1"
os.environ["REDIS_CACHE_URL"] = "redis://localhost:56379/8"
os.environ["REDIS_CORE_URL"] = "redis://localhost:56379/9"

# **원격 DB 를 향해 테스트를 돌리지 못하게 막는다.** 테스트는 데이터를 만들고
# 지운다. 실수로 스테이징이나 운영을 가리키면 되돌릴 수 없다
_db_url = os.environ["DATABASE_URL"]
if not any(host in _db_url for host in ("localhost", "127.0.0.1", "@postgres")):
    raise RuntimeError(
        "테스트가 로컬이 아닌 DB 를 가리키고 있다. 테스트는 데이터를 지운다:\n"
        f"  DATABASE_URL={_db_url}"
    )
os.environ.setdefault("JWT_SECRET", "test-secret")
# 결제 — **테스트 키만 쓴다.** 운영 키(`live_`)를 넣으면 부팅이 막히도록
# `Settings` 에 역방향 게이트가 있다 (`resona/config.py`)
os.environ.setdefault("TOSS_CLIENT_KEY", "test_ck_forTests")
os.environ.setdefault("TOSS_SECRET_KEY", "test_sk_forTests")
os.environ.setdefault("PAYMENT_ENC_KEY", base64.b64encode(b"k" * 32).decode())
# **베타 무료 이용권은 기본으로 끈다.** 켜 두면 모든 가입자가 무제한이 되어
# 한도 테스트가 통째로 무의미해진다 — 그건 요금제를 안 보는 것과 같다.
# 베타 부여 자체는 `test_beta_grant.py` 가 켜서 따로 본다
os.environ.setdefault("BETA_FREE_MONTHS", "0")

from resona.core import redis as r  # noqa: E402
from resona.core.config import get_settings  # noqa: E402
from resona.core.db import dispose_engine, init_engine, session_scope  # noqa: E402
from resona.main import create_app  # noqa: E402


@pytest.fixture
def settings():
    """**세션 스코프로 두면 낡는다.**

    일부 테스트가 환경변수를 바꾸고 `get_settings.cache_clear()` 를 부른다
    (`test_admin.py`, `test_security.py`). 그러면 앱은 새 `Settings` 를 보는데
    이 픽스처만 옛 객체를 들고 있어서, 여기에 `monkeypatch` 를 걸어도 앱에는
    아무 영향이 없다 — 테스트가 혼자 돌 때만 통과하고 전체 실행에서 깨진다.
    매번 현재 캐시를 다시 읽는다.
    """
    return get_settings()


@pytest.fixture
async def app(settings):
    application = create_app()
    # lifespan 을 직접 돌린다 — ASGITransport 는 lifespan 을 안 태운다
    init_engine(settings)
    r.init_redis(settings)
    # 테스트끼리 레이트 리밋이 새지 않게 비운다
    await r.core().flushdb()
    await r.cache().flushdb()
    yield application
    await dispose_engine()
    await r.close_redis()


@pytest.fixture
async def client(app) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


@pytest.fixture
async def live_server(app, settings) -> AsyncIterator[str]:
    """**진짜 uvicorn 을 띄운다.**

    httpx 의 ASGI 트랜스포트는 응답 본문을 통째로 모아서 돌려준다 — 끝나지 않는
    SSE 스트림은 거기서 영원히 안 끝난다. 스트리밍을 검증하려면 진짜 HTTP 가 필요하다.
    포트는 0 을 줘서 커널이 비어 있는 것을 고르게 한다 (CI 에서 충돌 안 나게).
    """
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())

    for _ in range(100):  # 뜰 때까지 기다린다
        if server.started:
            break
        await asyncio.sleep(0.05)
    else:  # pragma: no cover
        raise RuntimeError("테스트 서버가 뜨지 않았다")

    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=5)


@pytest.fixture
def unique_email() -> str:
    return f"user-{uuid.uuid4().hex[:12]}@example.com"


@pytest.fixture
async def db():
    async with session_scope() as session:
        yield session
