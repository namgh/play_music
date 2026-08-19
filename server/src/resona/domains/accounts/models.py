"""계정 — 사람과 로그인 수단.

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
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False, server_default="")

    # 생명주기 (`SERVER_ACCOUNTS.md` 1절)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="pending_verification"
    )
    # **플랫폼 역할은 리소스 접근을 자동으로 주지 않는다** (2축 권한, 3절)
    platform_role: Mapped[str] = mapped_column(Text, nullable=False, server_default="user")

    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_verification','active','suspended','deleted','purged')",
            name="status",
        ),
        CheckConstraint(
            "platform_role IN ('user','support','admin','owner')", name="platform_role"
        ),
        Index("ix_users_status_created_at", "status", "created_at"),
    )


class AuthIdentity(Base):
    __tablename__ = "auth_identities"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    # password 일 때만. Argon2 인코딩 문자열이라 파라미터가 안에 들어 있다
    secret_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (UniqueConstraint("provider", "subject", name="provider_subject"),)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # 원문을 저장하지 않는다. DB 가 유출돼도 세션이 털리지 않게
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    issued_at: Mapped[datetime] = created_at_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(Text)
    # **재사용 감지용** — 이미 회전된 토큰이 다시 오면 탈취로 보고 전 세션을 끊는다
    rotated_from: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("refresh_tokens.id"))

    __table_args__ = (
        Index(
            "ix_refresh_tokens_user_id_active",
            "user_id",
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )


class EmailToken(Base):
    """이메일 확인·비밀번호 재설정. 원문은 메일로만 가고 DB 에는 해시만 남는다"""

    __tablename__ = "email_tokens"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)  # 'verify' | 'reset'
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (CheckConstraint("kind IN ('verify','reset')", name="kind"),)
