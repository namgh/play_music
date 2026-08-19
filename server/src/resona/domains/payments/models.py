"""결제 — **돈이 어떻게 오가는가**. 권한 판정은 `billing`.

설계 판단은 `SERVER.md`·`SERVER_ERD.md` 에 있다. 여기에는 **코드에서만 보이는 것**만 남긴다.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from resona.shared.base_model import Base, created_at_col, uuid_pk


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
