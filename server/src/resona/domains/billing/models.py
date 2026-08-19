"""권한과 한도 — **무엇을 할 수 있는가**. 돈이 오가는 것은 `payments`.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


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
