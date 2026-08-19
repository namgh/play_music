"""Alembic 환경 — `SERVER_DATA.md` 1절.

`compare_type` 과 `compare_server_default` 를 켠다. 기본은 꺼져 있어서
`varchar(50) → varchar(100)` 같은 변경이 **조용히 누락**된다.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from resona.config import get_settings
from resona.db import models  # noqa: F401 — 모델을 임포트해야 metadata 가 채워진다
from resona.db.base import metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", str(get_settings().database_url))
target_metadata = metadata


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        # 마이그레이션마다 트랜잭션을 나눈다 — CONCURRENTLY 같은 것을 쓰려면 필요하다
        transaction_per_migration=True,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(lambda conn: (_configure(conn), context.run_migrations())[1])
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
