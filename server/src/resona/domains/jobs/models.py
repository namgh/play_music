"""AI 잡 — 큐와 그 결과.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


class AiJob(Base):
    __tablename__ = "ai_jobs"

    id: Mapped[uuid.UUID] = uuid_pk()
    # 한도를 깎는 단위
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # 누가 눌렀는지. 진행 알림(SSE)도 이 사람에게 간다
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    base_version_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("project_versions.id"))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    request: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="3")
    run_after: Mapped[datetime] = created_at_col()
    # 임대. 워커가 죽어도 만료되면 다른 워커가 집는다 → **처리는 멱등해야 한다**
    locked_by: Mapped[str | None] = mapped_column(Text)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("project_versions.id")
    )
    error: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="user_id_idempotency_key"),
        CheckConstraint(
            "status IN ('queued','running','succeeded','failed','canceled')", name="status"
        ),
        Index(
            "ix_ai_jobs_status_priority_run_after",
            "status",
            text("priority DESC"),
            "run_after",
            postgresql_where=text("status IN ('queued','running')"),
        ),
        Index("ix_ai_jobs_user_id_created_at", "user_id", text("created_at DESC")),
    )


class UserMemory(Base):
    """컨텍스트 기억 (차별점 ①). 무료는 만료로 세션 1회성을 만든다"""

    __tablename__ = "user_memory"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    source_job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ai_jobs.id"))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index("ix_user_memory_user_id_kind_created_at", "user_id", "kind", text("created_at DESC")),
    )
