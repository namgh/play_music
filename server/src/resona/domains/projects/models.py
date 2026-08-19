"""곡 — 프로젝트·버전·내보내기. **버전은 불변이다**.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = uuid_pk()
    # **소유는 조직이다.** 사람이 팀을 떠나도 곡은 팀에 남는다 —
    # 개인 소유로 두면 퇴사 한 번에 팀 작업물이 통째로 사라진다
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # 만든 사람. 권한 판단에는 안 쓰고 표시와 감사에만 쓴다
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # **순환 참조다.** `use_alter` 로 두 테이블이 생긴 뒤에 FK 를 걸게 한다 —
    # 이렇게 해야 `alembic check` 가 모델과 DB 를 같다고 본다
    head_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "project_versions.id",
            use_alter=True,
            name="fk_projects_head_version_id_project_versions",
        )
    )
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = created_at_col()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 파생 컬럼 — 진실은 문서다. 목록 한 번에 JSONB 를 전부 파싱하지 않으려고 둔다
    bpm: Mapped[float | None] = mapped_column(Numeric(7, 3))
    key_tonic: Mapped[str | None] = mapped_column(Text)
    key_mode: Mapped[str | None] = mapped_column(Text)
    length_bars: Mapped[int | None] = mapped_column(Integer)
    track_count: Mapped[int | None] = mapped_column(Integer)
    duration_sec: Mapped[float | None] = mapped_column(Numeric(10, 3))
    instrument_ids: Mapped[list[str] | None] = mapped_column(ARRAY(Text))

    __table_args__ = (
        # 목록 조회는 **조직 기준**이다 — 인덱스도 거기 맞춘다
        Index(
            "ix_projects_org_id_updated_at",
            "org_id",
            text("updated_at DESC"),
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_projects_instrument_ids", "instrument_ids", postgresql_using="gin"),
    )


class ProjectVersion(Base):
    """**불변.** 절대 UPDATE 하지 않는다 (`SERVER.md` 3-2)"""

    __tablename__ = "project_versions"

    id: Mapped[uuid.UUID] = uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("project_versions.id"))
    # 문서의 schemaVersion. **DB 스키마와 다른 축이다** (`SERVER_DATA.md` 3절)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)

    doc: Mapped[dict | None] = mapped_column(JSONB)
    doc_key: Mapped[str | None] = mapped_column(Text)  # 크면 객체 스토리지로
    doc_sha256: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    origin: Mapped[str] = mapped_column(Text, nullable=False, server_default="user")
    ai_job_id: Mapped[uuid.UUID | None] = mapped_column()
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        UniqueConstraint("project_id", "seq", name="project_id_seq"),
        CheckConstraint("(doc IS NULL) <> (doc_key IS NULL)", name="doc_location"),
        CheckConstraint("origin IN ('user','ai')", name="origin"),
        Index("ix_project_versions_project_id_seq", "project_id", text("seq DESC")),
        Index("ix_project_versions_project_id_doc_sha256", "project_id", "doc_sha256"),
    )


class ProjectMember(Base):
    """협업은 MVP 밖이지만 **나중에 넣으면 전체 마이그레이션**이라 먼저 둔다"""

    __tablename__ = "project_members"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    added_at: Mapped[datetime] = created_at_col()

    __table_args__ = (CheckConstraint("role IN ('owner','editor','viewer')", name="role"),)


class ProjectExport(Base):
    __tablename__ = "project_exports"

    id: Mapped[uuid.UUID] = uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_versions.id"), nullable=False
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assets.id"), nullable=False)
    format: Mapped[str] = mapped_column(Text, nullable=False)
    sample_rate: Mapped[int | None] = mapped_column(Integer)
    bit_depth: Mapped[int | None] = mapped_column(Integer)
    # 클라이언트가 렌더하며 잰 값. 넘쳤으면 그대로 남긴다 (`SOUND_QUALITY.md`)
    peak_dbfs: Mapped[float | None] = mapped_column(Numeric(6, 2))
    # **권리를 시점에 고정한다** (`SERVER_BILLING.md` 3절)
    license: Mapped[str] = mapped_column(Text, nullable=False, server_default="personal")
    license_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (CheckConstraint("license IN ('personal','commercial')", name="license"),)


class TonePreset(Base):
    """"내 음색" — 파라미터 JSON 이다 (`sound.md` 8절). 용량이 0 이라 링크로 공유된다"""

    __tablename__ = "tone_presets"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    instrument_id: Mapped[str] = mapped_column(Text, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    params: Mapped[dict] = mapped_column(JSONB, nullable=False)
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = created_at_col()
