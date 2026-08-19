"""결제 — 구독 조회와 **웹훅** (`SERVER_BILLING.md`).

웹훅에 대해 셋을 전부 전제한다:

  **중복** — 결제사는 최소 한 번 보낸다. 같은 이벤트가 두 번 온다. `billing_events`
      의 PK 가 결제사 event id 라 두 번째는 INSERT 에서 걸린다.
  **역순** — `canceled` 가 `updated` 보다 먼저 도착할 수 있다. 그래서 `occurred_at`
      을 보고 **더 오래된 이벤트는 상태에 반영하지 않는다.** 순서를 믿으면 해지한
      사용자가 유료로 남거나 그 반대가 된다.
  **지연** — 며칠 뒤 재전송이 온다. 그때 반영하면 안 되는 것을 반영하지 않도록
      역시 `occurred_at` 비교로 막는다.

그리고 **먼저 저장하고 나중에 처리한다.** 처리 중 죽어도 이벤트는 남아 있어서
재처리할 수 있다. 처리부터 하면 죽는 순간 이벤트가 사라진다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from resona.core.deps import Db
from resona.domains.accounts.deps import CurrentUser
from resona.domains.billing import service as entitlements
from resona.domains.billing.models import Plan, Subscription
from resona.domains.workspaces import service as orgs

log = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])


class SubscriptionOut(BaseModel):
    plan_code: str
    status: str
    commercial_license: bool
    current_period_end: datetime | None
    limits: dict[str, int]
    usage: dict[str, int]


@router.get("/billing/subscription", response_model=SubscriptionOut)
async def my_subscription(
    session: Db, user: CurrentUser, org_id: uuid.UUID | None = None
) -> SubscriptionOut:
    """`org_id` 를 안 주면 개인 워크스페이스. **과금 단위는 조직이다**"""
    org = await orgs.resolve_org(session, user_id=user.id, org_id=org_id)
    ent = await entitlements.resolve(session, org.id)
    sub = await session.get(Subscription, org.id)
    return SubscriptionOut(
        plan_code=ent.plan_code,
        status=ent.status,
        commercial_license=ent.commercial_license,
        current_period_end=sub.current_period_end if sub else None,
        limits=ent.limits,
        usage={
            "ai_job": await entitlements.usage_in_period(session, org.id, "ai_job"),
            "export": await entitlements.usage_in_period(session, org.id, "export"),
        },
    )


class PlanOut(BaseModel):
    code: str
    display_name: str
    # **`None` 은 무제한이다.** `int` 로만 두면 무제한 플랜에서 응답이 터진다
    limits: dict[str, int | None]


@router.get("/billing/plans", response_model=list[PlanOut])
async def list_plans(session: Db) -> list[PlanOut]:
    """**인증 없이 연다.** 가격표는 가입 전에 보여 줘야 하는 것이다"""
    rows = (
        await session.execute(select(Plan).where(Plan.active.is_(True)).order_by(Plan.code))
    ).scalars()
    return [
        PlanOut(code=p.code, display_name=p.display_name, limits=dict(p.limits)) for p in rows
    ]
