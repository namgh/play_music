"""권한·한도 쿼리 (플랜·구독·부여). **commit 하지 않는다.**

결제 수단과 주문은 `payments` 도메인이다 — 여기는 "무엇을 할 수 있는가"만 본다.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.billing.models import Plan, Subscription


async def get_plan(session: AsyncSession, code: str) -> Plan | None:
    return await session.get(Plan, code)


async def active_plans(session: AsyncSession) -> list[Plan]:
    return list(
        (
            await session.execute(
                select(Plan).where(Plan.active.is_(True)).order_by(Plan.code)
            )
        ).scalars()
    )


async def get_subscription(session: AsyncSession, org_id: uuid.UUID) -> Subscription | None:
    return await session.get(Subscription, org_id)


async def subscriptions_for(
    session: AsyncSession, org_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, Subscription]:
    """여러 조직의 구독을 한 번에. **어드민 목록이 N+1 로 돌지 않게 한다**"""
    if not org_ids:
        return {}
    rows = (
        await session.execute(select(Subscription).where(Subscription.org_id.in_(org_ids)))
    ).scalars()
    return {s.org_id: s for s in rows}


async def create_free(session: AsyncSession, org_id: uuid.UUID) -> Subscription:
    """가입·조직 생성 시 붙는 무료 구독.

    **다른 도메인이 `Subscription(...)` 을 직접 만들지 않게** 여기로 모은다 —
    무료 플랜의 초기값이 바뀔 때 고칠 곳이 하나여야 한다.
    """
    sub = Subscription(org_id=org_id, plan_code="free", status="active")
    session.add(sub)
    return sub


async def create(
    session: AsyncSession, org_id: uuid.UUID, *, plan_code: str, status: str = "active"
) -> Subscription:
    """유료 구독 시작. `payments` 가 첫 결제를 성공시킨 뒤 부른다"""
    sub = Subscription(org_id=org_id, plan_code=plan_code, status=status)
    session.add(sub)
    return sub


async def due_for_charge(session: AsyncSession, limit: int) -> list[uuid.UUID]:
    """갱신일이 지난 구독. 스케줄러가 후보를 훑는 용도라 **잠그지 않는다** —
    잠금은 건별로 다시 건다"""
    from sqlalchemy import text

    return list(
        (
            await session.execute(
                text(
                    "SELECT org_id FROM subscriptions "
                    "WHERE next_charge_at IS NOT NULL AND next_charge_at <= now() "
                    "  AND status IN ('active','past_due') "
                    "ORDER BY next_charge_at LIMIT :n"
                ),
                {"n": limit},
            )
        ).scalars()
    )


async def lock_if_due(session: AsyncSession, org_id: uuid.UUID) -> Subscription | None:
    """**한 건만 잠근다.** `SKIP LOCKED` 라 워커가 여럿이어도 같은 구독을 두 번 긁지 않는다"""
    from sqlalchemy import text

    locked = (
        await session.execute(
            text(
                "SELECT org_id FROM subscriptions "
                "WHERE org_id = :o AND next_charge_at IS NOT NULL "
                "  AND next_charge_at <= now() AND status IN ('active','past_due') "
                "FOR UPDATE SKIP LOCKED"
            ),
            {"o": org_id},
        )
    ).first()
    if locked is None:
        return None
    return await session.get(Subscription, org_id)
