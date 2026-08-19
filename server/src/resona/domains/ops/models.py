"""운영 — 감사·멱등·대리접속·메일 아웃박스.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    # 같은 키에 다른 본문이 오면 재시도가 아니라 버그다 → 422
    request_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    response_status: Mapped[int | None] = mapped_column(Integer)
    response_body: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_col()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_idempotency_keys_created_at", "created_at"),)


class AuditLog(Base):
    """**append only.** 수정·삭제 API 를 만들지 않는다"""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # 대리 접속이면 담당자와 대상을 **둘 다** 남긴다. 하나면 누가/누구를 알 수 없다
    on_behalf_of: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str | None] = mapped_column(Text)
    target_id: Mapped[uuid.UUID | None] = mapped_column()
    detail: Mapped[dict | None] = mapped_column(JSONB)
    ip: Mapped[str | None] = mapped_column(INET)
    occurred_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index(
            "ix_audit_log_target_type_target_id_occurred_at",
            "target_type",
            "target_id",
            text("occurred_at DESC"),
        ),
    )


class ImpersonationSession(Base):
    __tablename__ = "impersonation_sessions"

    id: Mapped[uuid.UUID] = uuid_pk()
    operator_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    subject_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)  # 필수. 빈 문자열 금지
    ticket_ref: Mapped[str | None] = mapped_column(Text)
    write_allowed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    started_at: Mapped[datetime] = created_at_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("length(reason) > 0", name="reason_not_empty"),
        Index(
            "ix_impersonation_sessions_subject_id_started_at",
            "subject_id",
            text("started_at DESC"),
        ),
    )


class EmailOutbox(Base):
    """**메일은 아웃박스를 거친다.** 요청 안에서 직접 보내지 않는다.

    두 가지 때문이다:
      1. **롤백**. 가입 트랜잭션이 뒤에서 실패했는데 확인 메일은 이미 나가면,
         존재하지 않는 계정의 링크를 사용자가 받는다. 아웃박스는 같은 트랜잭션에
         들어가므로 롤백되면 메일도 없던 일이 된다.
      2. **지연**. SMTP 는 몇 초씩 걸리고 가끔 안 된다. 그동안 API 워커 하나가
         묶여 있으면 그게 그대로 장애다.

    워커가 임대해 보낸다 — 잡 큐와 같은 방식이라 재시도·관측이 공짜로 따라온다.
    """

    __tablename__ = "email_outbox"

    id: Mapped[uuid.UUID] = uuid_pk()
    to_email: Mapped[str] = mapped_column(String(320), nullable=False)
    template: Mapped[str] = mapped_column(Text, nullable=False)
    # 템플릿에 넣을 값. **비밀번호나 원문 토큰이 아니라 링크만** 담는다
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="5")
    run_after: Mapped[datetime] = created_at_col()
    locked_by: Mapped[str | None] = mapped_column(Text)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("status IN ('queued','sending','sent','failed')", name="status"),
        Index(
            "ix_email_outbox_run_after",
            "run_after",
            postgresql_where=text("status IN ('queued','sending')"),
        ),
    )
