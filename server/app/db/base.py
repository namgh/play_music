"""SQLAlchemy 기반 — **제약 이름 규칙이 여기 있다.**

`SERVER_DATA.md` 1-1: 이걸 첫 마이그레이션 전에 정해야 한다. 안 정하면 Postgres 가
지어 준 이름(`projects_owner_id_fkey1` 같은)이 마이그레이션에 그대로 박히고,
나중에 그 제약을 지울 때 **환경마다 이름이 달라서** 운영에서만 실패한다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, MetaData, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    metadata = metadata


def uuid_pk() -> Mapped[uuid.UUID]:
    """UUID 기본키. 생성은 DB 에 맡긴다 — 워커가 여러 개라 중앙에서 나는 편이 안전하다"""
    return mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))


def created_at_col() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
