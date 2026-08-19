"""에셋 — 오브젝트 스토리지에 올라간 파일의 그림자.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


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
