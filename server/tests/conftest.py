"""테스트 준비 — **진짜 Postgres·Redis 로 돈다** (`SERVER_DATA.md` 6절).

SQLite 로 대체하지 않는다. JSONB·배열·부분 인덱스·자문 락이 전부 다르게 동작해서,
통과해도 아무것도 보장하지 못한다.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("ENV", "local")
os.environ.setdefault("KEY_PREFIX", "test:v1")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://resona:resona@localhost:55432/resona"
)
os.environ.setdefault("REDIS_CACHE_URL", "redis://localhost:56379/8")
os.environ.setdefault("REDIS_CORE_URL", "redis://localhost:56379/9")
os.environ.setdefault("JWT_SECRET", "test-secret")

from app.config import get_settings  # noqa: E402
from app.core import redis as r  # noqa: E402
from app.db.session import dispose_engine, init_engine, session_scope  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture(scope="session")
def settings():
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
def unique_email() -> str:
    return f"user-{uuid.uuid4().hex[:12]}@example.com"


@pytest.fixture
async def db():
    async with session_scope() as session:
        yield session
