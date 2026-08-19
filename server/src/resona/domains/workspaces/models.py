"""워크스페이스 — **모든 것이 조직에 속한다.** 개인 계정도 1인 조직이다.

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
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


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
