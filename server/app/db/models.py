"""테이블 정의 — `SERVER.md` 4절의 스키마를 SQLAlchemy 로 옮긴 것.

설계 판단은 전부 그 문서에 있다. 여기서는 **코드에서만 보이는 것**만 주석으로 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_col, uuid_pk

# --- 계정 -------------------------------------------------------------------


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


# --- 프로젝트 ---------------------------------------------------------------


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = uuid_pk()
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
        Index(
            "ix_projects_owner_id_updated_at",
            "owner_id",
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


# --- 에셋 -------------------------------------------------------------------


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # 업로드는 3단계다. 완료 통지 전 행은 pending 이고 scheduler 가 청소한다
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = created_at_col()
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("kind IN ('export','sample','ir')", name="kind"),
        CheckConstraint("status IN ('pending','ready')", name="status"),
        Index(
            "ix_assets_status_created_at",
            "status",
            "created_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )


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


# --- AI ---------------------------------------------------------------------


class AiJob(Base):
    __tablename__ = "ai_jobs"

    id: Mapped[uuid.UUID] = uuid_pk()
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


# --- 과금 -------------------------------------------------------------------


class Plan(Base):
    """한도를 **데이터로** 둔다 — 캠페인·기업 플랜이 코드 배포 없이 된다"""

    __tablename__ = "plans"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    limits: Mapped[dict] = mapped_column(JSONB, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))


class Subscription(Base):
    __tablename__ = "subscriptions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    plan_code: Mapped[str] = mapped_column(
        ForeignKey("plans.code"), nullable=False, server_default="free"
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    commercial_license: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    external_ref: Mapped[str | None] = mapped_column(Text)
    # 이보다 오래된 웹훅 이벤트는 무시한다 — 순서를 믿지 않는다
    last_event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint(
            "status IN ('active','canceling','past_due','canceled')", name="status"
        ),
    )


class UsageEvent(Base):
    """**카운터가 아니라 원장이다.** 경쟁도 없고 분쟁 시 근거가 남는다"""

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ai_jobs.id"))
    occurred_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index(
            "ix_usage_events_user_id_kind_occurred_at",
            "user_id",
            "kind",
            text("occurred_at DESC"),
        ),
    )


class UsageRollup(Base):
    __tablename__ = "usage_rollups"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(Text, primary_key=True)
    period_start: Mapped[date] = mapped_column(Date, primary_key=True)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    rolled_at: Mapped[datetime] = created_at_col()


class BillingEvent(Base):
    """웹훅은 **중복·역순·지연을 전부 전제**한다 (`SERVER_BILLING.md` 5절)"""

    __tablename__ = "billing_events"

    id: Mapped[str] = mapped_column(Text, primary_key=True)  # 결제사의 event id
    type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = created_at_col()
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


# --- 운영 -------------------------------------------------------------------


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
