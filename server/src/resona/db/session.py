"""DB 세션 — 워커마다 자기 엔진을 갖는다.

**커넥션 풀 크기가 여기서 정해진다** (`SERVER.md` 1절):
    workers × (pool_size + max_overflow) ≤ max_connections − 예약분
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from resona.config import Settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(settings: Settings) -> AsyncEngine:
    """프로세스마다 한 번. `fork` 이후에 만들어야 커넥션이 공유되지 않는다"""
    global _engine, _sessionmaker
    _engine = create_async_engine(
        str(settings.database_url),
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout_sec,
        # 죽은 커넥션을 들고 있다가 첫 쿼리에서 실패하는 것을 막는다
        pool_pre_ping=True,
        # PgBouncer transaction 모드 뒤에서는 0 으로 (`SERVER.md` 1절)
        connect_args={"statement_cache_size": settings.db_statement_cache_size},
    )
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        raise RuntimeError("init_engine 을 먼저 불러야 한다")
    return _sessionmaker


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """요청·잡 하나에 트랜잭션 하나. 예외면 롤백한다"""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def db_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 의존성"""
    async with session_scope() as session:
        yield session
