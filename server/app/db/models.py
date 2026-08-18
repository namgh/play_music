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


# --- 조직(워크스페이스) ------------------------------------------------------


class Organization(Base):
    """**모든 것이 조직에 속한다. 개인 계정은 1인 조직이다.**

    개인용 경로와 팀용 경로를 따로 만들면 권한·과금·목록 조회가 전부 두 벌이 되고,
    한쪽에만 있는 버그가 반드시 생긴다. 그래서 가입 시 `kind='personal'` 조직을
    자동으로 만들고, 팀은 같은 테이블에 `kind='team'` 으로 얹는다.

    나중에 넣으면 프로젝트·구독·권한을 전부 옮겨야 해서 지금 넣는다.
    """

    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = uuid_pk()
    # URL 에 쓰는 이름. 개인 조직은 자동 생성하고 사용자가 바꿀 수 있다
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="personal")
    # 사용자와 같은 생명주기다 — `deleted` 는 되돌릴 수 있고 `purged` 는 못 되돌린다.
    # **`purged` 라도 행을 지우지 않는다**: 지우면 CASCADE 로 구독·사용량 원장까지
    # 사라져서 결제 분쟁을 풀 수 없다. 콘텐츠만 지우고 이름을 익명화한다
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created_at_col()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("kind IN ('personal','team')", name="kind"),
        CheckConstraint("status IN ('active','deleted','purged')", name="status"),
        # 슬러그는 소문자·숫자·하이픈만. 대소문자만 다른 두 조직은 사람이 구분 못 한다
        CheckConstraint("slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'", name="slug_format"),
    )


class OrgMember(Base):
    """**리소스 권한의 유일한 출처다.**

    플랫폼 역할(`users.platform_role`)과 섞지 않는다 — 2축 권한
    (`SERVER_ACCOUNTS.md` 3절). admin 이라고 남의 조직에 들어갈 수 없다.
    """

    __tablename__ = "org_members"

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # owner: 과금·삭제 / admin: 초대·설정 / editor: 편집 / viewer: 보기·반출
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="editor")
    joined_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("role IN ('owner','admin','editor','viewer')", name="role"),
        Index("ix_org_members_user_id", "user_id"),
    )


class OrgInvite(Base):
    """초대는 **이메일로 건다.** 아직 가입 안 한 사람도 초대할 수 있어야 한다"""

    __tablename__ = "org_invites"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="editor")
    # 토큰 자체는 저장하지 않는다 — 유출되면 그대로 초대 수락에 쓰인다
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("role IN ('admin','editor','viewer')", name="role"),
        # 같은 조직에 같은 주소로 **살아 있는 초대는 하나만**
        Index(
            "uq_org_invites_org_id_email_live",
            "org_id",
            "email",
            unique=True,
            postgresql_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
        ),
    )


# --- 프로젝트 ---------------------------------------------------------------


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


# --- 에셋 -------------------------------------------------------------------


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = uuid_pk()
    # **용량 한도를 세는 단위는 조직이다.** 개인 기준으로 세면 두 방향으로 틀린다 —
    # 팀이 Pro 를 결제해도 올리는 사람의 무료 한도에 막히고, 반대로 무료 조직에
    # 5명을 초대하면 같은 워크스페이스에 5배를 올릴 수 있다 (비용이 인원수만큼 샌다)
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # 올린 사람. 권한 판단에는 안 쓰고 표시와 감사에만 쓴다
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
        # 용량 합계를 조직으로 낸다 — 그 쿼리가 매 업로드마다 돈다
        Index(
            "ix_assets_org_id_status",
            "org_id",
            "status",
            postgresql_where=text("status = 'ready'"),
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


# --- 과금 -------------------------------------------------------------------


class Plan(Base):
    """한도를 **데이터로** 둔다 — 캠페인·기업 플랜이 코드 배포 없이 된다"""

    __tablename__ = "plans"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    limits: Mapped[dict] = mapped_column(JSONB, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    # 결제사의 가격 ID. **코드에 박지 않는다** — 가격을 바꿀 때마다 배포하게 된다
    external_price_id: Mapped[str | None] = mapped_column(Text)
    # **원 단위, 부가세 포함 표시가.** 토스는 우리가 금액을 정해서 보내는 구조라
    # (Stripe 처럼 결제사에 가격 객체가 있는 게 아니라) 서버가 값을 알아야 한다.
    # `NULL` 이면 살 수 없는 플랜이다 (무료)
    price_krw: Mapped[int | None] = mapped_column(Integer)
    # 이 플랜이 상업 이용권을 주는가. **플랜이 선언해야 한다** — 구독을 만드는
    # 자리마다 이걸 코드로 알고 있으면 한 곳만 빠뜨려도 권리가 어긋난다
    commercial_license: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )


class Subscription(Base):
    """**과금 단위는 조직이다.** 개인도 1인 조직이라 경로가 하나뿐이다 —
    개인 요금제와 팀 요금제를 따로 구현하면 한쪽에만 있는 버그가 반드시 생긴다"""

    __tablename__ = "subscriptions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
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

    # --- 정기결제 (`SERVER_PAYMENTS.md` 1-1) --------------------------------
    # **토스는 구독을 대신 굴려주지 않는다.** 매달 긁는 건 우리 일이라 "언제 긁을
    # 것인가"를 우리가 들고 있어야 한다. `NULL` 이면 자동결제가 없는 상태다
    # (무료, 해지 예정, 또는 완전 해지)
    next_charge_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 연속 실패 횟수. 재시도 간격(1일·3일·7일)과 포기 시점을 여기서 정한다.
    # 성공하면 0 으로 되돌린다 — **누적이 아니라 연속이다**
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # 마지막 실패 이유. 사용자에게 "카드 한도를 확인해 주세요"를 말해 주려면 필요하다
    last_failure_code: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint(
            "status IN ('active','canceling','past_due','canceled')", name="status"
        ),
    )


class BillingCustomer(Base):
    """결제사가 아는 우리 고객 식별자 (`SERVER_PAYMENTS.md` 3-1).

    **`customer_key` 는 추측 불가능해야 한다.** 결제창 SDK 에 넘어가 브라우저에
    노출되는 값이라, 조직 UUID 를 그대로 쓰면 내부 식별자가 밖으로 나가고
    "이 조직이 존재하는가"를 남이 물어볼 수 있게 된다.
    """

    __tablename__ = "billing_customers"

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False, server_default="toss")
    customer_key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (CheckConstraint("provider IN ('toss','paypal')", name="provider"),)


class BillingKey(Base):
    """자동결제 자격증명 (`SERVER_PAYMENTS.md` 6절).

    **카드번호가 아니지만 결제를 일으킬 수 있다.** 그래서 평문으로 두지 않는다 —
    이게 새면 우리 시크릿 키 없이도 그 카드에 청구가 가능해진다.
    카드번호 자체는 우리 서버에 절대 오지 않는다(토스 SDK 가 직접 받는다).
    """

    __tablename__ = "billing_keys"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # **암호화해서 넣는다.** 복호화는 `app/core/crypto.py` 한 곳에서만 한다
    billing_key_enc: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # 화면에 "신한 ****1234" 를 보여주기 위한 것. 카드번호가 아니다
    card_brand: Mapped[str | None] = mapped_column(Text)
    card_last4: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    created_at: Mapped[datetime] = created_at_col()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("status IN ('active','revoked')", name="status"),
        # **조직당 살아 있는 카드는 하나다.** 둘이면 "어느 카드로 긁을 것인가"가
        # 애매해지고, 그 애매함은 결국 엉뚱한 카드에 청구하는 사고가 된다.
        # 카드를 바꾸면 이전 것을 revoke 한다 (이력은 남는다)
        Index(
            "uq_billing_keys_one_active_per_org",
            "org_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )


class PaymentOrder(Base):
    """**결제를 시작하기 전에 서버가 금액을 확정해 둔다** (`SERVER_PAYMENTS.md` 2절).

    이 행이 없으면 승인 시점에 대조할 기준이 없어서, 클라이언트가 보낸 금액을
    그대로 믿게 된다 — ₩4,400 짜리를 ₩100 에 파는 길이 열린다.
    """

    __tablename__ = "payment_orders"

    id: Mapped[uuid.UUID] = uuid_pk()
    # 토스에 보내는 주문번호. **멱등키로도 쓴다** — 같은 주기를 두 번 긁지 않는다
    order_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # **대조 기준.** 승인은 반드시 이 값으로만 한다
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False, server_default="subscription")
    plan_code: Mapped[str | None] = mapped_column(ForeignKey("plans.code"))
    # 구독 결제가 어느 달의 것인가. 중복 청구를 DB 가 막는 근거
    cycle_start: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    # 왜 실패했나 — 사용자에게 "카드 한도를 확인해 주세요"를 말해 주려면 필요하다
    failure_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','approved','failed','canceled')", name="status"
        ),
        CheckConstraint("purpose IN ('subscription','onetime')", name="purpose"),
        CheckConstraint("amount > 0", name="amount_positive"),
        # **같은 달을 두 번 청구하는 사고를 DB 가 막는다.** 코드로만 막으면
        # 스케줄러 프로세스 둘이 나란히 통과한다.
        # 조건을 `approved` 로 건다 — 실패한 시도는 여러 번 있을 수 있고
        # 재시도마다 새 주문번호가 필요하다. 막아야 하는 것은 **성공한 청구**가
        # 한 주기에 둘인 경우다
        Index(
            "uq_payment_orders_one_approved_per_cycle",
            "org_id",
            "cycle_start",
            unique=True,
            postgresql_where=text("purpose = 'subscription' AND status = 'approved'"),
        ),
    )


class Payment(Base):
    """승인된 결제. **분쟁이 나면 이 행이 우리 쪽 증거다**"""

    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = uuid_pk()
    # 토스의 결제 식별자. 취소·조회가 전부 이걸로 간다
    payment_key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("payment_orders.id", ondelete="RESTRICT"), nullable=False
    )
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    refunded_amount: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str | None] = mapped_column(Text)
    receipt_url: Mapped[str | None] = mapped_column(Text)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # **조회 API 응답을 통째로 넣는다.** 분쟁에서 "그때 토스가 뭐라고 했는지"가
    # 유일한 증거인데, 파싱한 컬럼만 남기면 나중에 필요한 필드가 없다
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("refunded_amount >= 0 AND refunded_amount <= amount", name="refund_range"),
        Index("ix_payments_org_id_created_at", "org_id", text("created_at DESC")),
    )


class EntitlementGrant(Base):
    """**구독이 아닌 방식으로 주는 권한** (`SERVER_PAYMENTS.md` 4절).

    앞으로 들어올 것들이 전부 구독이 아니다 — 베타 3개월 무료, "AI 를 많이 쓰면
    DAW 면제", 쿠폰, 파트너, 내부 계정. 이걸 구독 행에 우겨넣으면 "결제는 안 했는데
    구독 상태가 active" 같은 거짓말을 하게 되고, 결제 코드가 그걸 다시 해석한다.

    그래서 판정을 **`구독 + 유효한 부여들`의 합성**으로 둔다. 넷이 같은 자리로 들어온다.

    **행동은 `kind` 가 아니라 `limits`/`commercial_license` 가 정한다.** `kind` 는
    "왜 줬나"를 사람이 읽기 위한 것이라 제약을 걸지 않는다 — 새 프로모션마다
    마이그레이션을 하게 되면 `plans.limits` 를 데이터로 둔 이유가 무너진다.
    """

    __tablename__ = "entitlement_grants"

    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # 구독 한도 **위에 덮어쓴다.** 합성 규칙은 `services/entitlements.py` 에 있다
    limits: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'"))
    commercial_license: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    starts_at: Mapped[datetime] = created_at_col()
    # NULL 이면 무기한. 베타 3개월 무료는 여기에 만료일이 들어간다
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # **왜 줬는지 남긴다.** 공짜 권한은 나중에 반드시 "이건 누가 왜 줬나"를 묻게 된다
    reason: Mapped[str | None] = mapped_column(Text)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        # 유효한 부여만 찾는 질의가 매 요청에 붙는다
        Index("ix_entitlement_grants_org_id_ends_at", "org_id", "ends_at"),
    )


class UsageEvent(Base):
    """**카운터가 아니라 원장이다.** 경쟁도 없고 분쟁 시 근거가 남는다"""

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # 한도를 세는 단위
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # 누가 썼는지. 팀에서 "누가 이번 달 크레딧을 다 썼나"를 답할 수 있어야 한다
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ai_jobs.id"))
    occurred_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index(
            "ix_usage_events_org_id_kind_occurred_at",
            "org_id",
            "kind",
            text("occurred_at DESC"),
        ),
    )


class UsageRollup(Base):
    __tablename__ = "usage_rollups"

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
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
