"""결제 쿼리 (고객·빌링키·주문·결제·웹훅 이벤트). **commit 하지 않는다.**"""

import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.payments.models import (
    BillingCustomer,
    BillingKey,
    Payment,
    PaymentOrder,
)


async def customer(session: AsyncSession, org_id: uuid.UUID) -> BillingCustomer | None:
    return (
        await session.execute(
            select(BillingCustomer).where(BillingCustomer.org_id == org_id)
        )
    ).scalar_one_or_none()


async def active_key(session: AsyncSession, org_id: uuid.UUID) -> BillingKey | None:
    return (
        await session.execute(
            select(BillingKey).where(
                BillingKey.org_id == org_id, BillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()


async def order_by_external_id(session: AsyncSession, order_id: str) -> PaymentOrder | None:
    return (
        await session.execute(
            select(PaymentOrder).where(PaymentOrder.order_id == order_id)
        )
    ).scalar_one_or_none()


async def has_unresolved_order(session: AsyncSession, org_id: uuid.UUID) -> bool:
    """**미결 주문이 있으면 새로 긁지 않는다** — 결과를 모르는 채 또 청구하면 이중 청구다"""
    return (
        await session.execute(
            select(PaymentOrder.id).where(
                PaymentOrder.org_id == org_id, PaymentOrder.status == "pending"
            )
        )
    ).first() is not None


async def stale_pending_orders(session: AsyncSession, cutoff, limit: int) -> list[uuid.UUID]:
    return list(
        (
            await session.execute(
                text(
                    "SELECT id FROM payment_orders WHERE status = 'pending' "
                    "  AND created_at < :cutoff ORDER BY created_at LIMIT :n"
                ),
                {"cutoff": cutoff, "n": limit},
            )
        ).scalars()
    )


async def get_order(session: AsyncSession, order_id: uuid.UUID) -> PaymentOrder | None:
    return await session.get(PaymentOrder, order_id)


async def get_payment(session: AsyncSession, payment_id: uuid.UUID) -> Payment | None:
    return await session.get(Payment, payment_id)


async def list_payments(
    session: AsyncSession, org_id: uuid.UUID, *, limit: int = 50
) -> list[Payment]:
    return list(
        (
            await session.execute(
                select(Payment)
                .where(Payment.org_id == org_id)
                .order_by(Payment.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
