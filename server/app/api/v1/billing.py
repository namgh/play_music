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

import hashlib
import hmac
import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, Db
from app.core import audit
from app.core.errors import Unauthorized
from app.db.models import BillingEvent, Subscription, User
from app.services import entitlements

log = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])

# 이벤트 종류 → 구독 상태. 결제사 문자열을 서비스 도메인으로 **한 곳에서** 번역한다
_STATUS_BY_EVENT = {
    "subscription.created": "active",
    "subscription.updated": None,  # payload 의 status 를 그대로 쓴다
    "subscription.canceled": "canceled",
    "subscription.paused": "canceling",
    "invoice.payment_failed": "past_due",
    "invoice.payment_succeeded": "active",
}


class SubscriptionOut(BaseModel):
    plan_code: str
    status: str
    commercial_license: bool
    current_period_end: datetime | None
    limits: dict[str, int]
    usage: dict[str, int]


@router.get("/billing/subscription", response_model=SubscriptionOut)
async def my_subscription(session: Db, user: CurrentUser) -> SubscriptionOut:
    ent = await entitlements.resolve(session, user.id)
    sub = await session.get(Subscription, user.id)
    return SubscriptionOut(
        plan_code=ent.plan_code,
        status=ent.status,
        commercial_license=ent.commercial_license,
        current_period_end=sub.current_period_end if sub else None,
        limits=ent.limits,
        usage={
            "ai_job": await entitlements.usage_in_period(session, user.id, "ai_job"),
            "export": await entitlements.usage_in_period(session, user.id, "export"),
        },
    )


def verify_signature(*, secret: str, payload: bytes, header: str | None) -> None:
    """서명이 없거나 틀리면 **아무것도 하지 않는다.**

    웹훅 URL 은 공개된 주소다. 서명을 안 보면 누구나 자기 계정을 Pro 로 만들 수 있다.
    `compare_digest` 를 쓰는 것은 타이밍으로 서명을 맞춰 나가는 공격을 막기 위해서다.
    """
    if not header:
        raise Unauthorized("서명이 없습니다", code="missing_signature")
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, header.strip()):
        raise Unauthorized("서명이 올바르지 않습니다", code="invalid_signature")


@router.post("/billing/webhook", status_code=status.HTTP_204_NO_CONTENT)
async def webhook(
    request: Request,
    session: Db,
    signature: Annotated[str | None, Header(alias="X-Signature")] = None,
) -> Response:
    import os

    raw = await request.body()
    secret = os.environ.get("BILLING_WEBHOOK_SECRET", "")
    if secret:
        verify_signature(secret=secret, payload=raw, header=signature)
    else:
        log.warning("billing_webhook_secret_missing")  # 로컬 개발용 경로

    import json

    event = json.loads(raw)
    event_id = str(event.get("id") or "")
    if not event_id:
        # id 가 없으면 중복을 못 막는다 → 받지 않는다
        raise Unauthorized("이벤트 id 가 없습니다", code="missing_event_id")

    occurred_at = datetime.fromtimestamp(float(event.get("created", 0)), tz=UTC)

    session.add(
        BillingEvent(
            id=event_id,
            type=event.get("type", "unknown"),
            payload=event,
            occurred_at=occurred_at,
        )
    )
    try:
        await session.flush()
    except IntegrityError:
        # **이미 받은 이벤트다.** 204 로 답해야 결제사가 재전송을 멈춘다.
        # 여기서 5xx 를 주면 영원히 재전송받는다
        await session.rollback()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    await _apply(session, event, occurred_at)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _apply(session: Db, event: dict[str, Any], occurred_at: datetime) -> None:
    data = event.get("data", {})
    email = (data.get("customer_email") or "").lower()
    if not email:
        return

    user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None:
        # 결제는 됐는데 계정이 없다. **삼키지 않는다** — 사람이 봐야 하는 상황이라
        # 이벤트 행에 남기고 일일 대사(reconciliation)가 잡는다
        log.error("billing_event_unknown_customer", extra={"event_id": event.get("id")})
        return

    sub = await session.get(Subscription, user.id)
    if sub is None:
        sub = Subscription(user_id=user.id, plan_code="free", status="active")
        session.add(sub)
        await session.flush()

    # **역순 방어.** 이미 더 최신 이벤트를 반영했으면 무시한다
    if sub.last_event_at is not None and occurred_at <= sub.last_event_at:
        log.info("billing_event_out_of_order", extra={"event_id": event.get("id")})
        return

    event_type = event.get("type", "")
    mapped = _STATUS_BY_EVENT.get(event_type)
    if event_type not in _STATUS_BY_EVENT:
        return

    sub.status = mapped or data.get("status", sub.status)
    if plan := data.get("plan_code"):
        sub.plan_code = plan
    if period_end := data.get("current_period_end"):
        sub.current_period_end = datetime.fromtimestamp(float(period_end), tz=UTC)
    sub.external_ref = data.get("subscription_id") or sub.external_ref
    sub.last_event_at = occurred_at

    # 상업 이용 권리는 **유료가 살아 있는 동안만 새로 부여된다.** 이미 내보낸
    # 결과물의 권리는 여기서 건드리지 않는다 — 그건 export 행에 고정돼 있다
    sub.commercial_license = sub.plan_code != "free" and sub.status in ("active", "canceling")

    ev = await session.get(BillingEvent, event["id"])
    if ev is not None:
        ev.processed_at = datetime.now(UTC)

    await audit.record(
        session,
        action="billing.apply",
        target_type="user",
        target_id=user.id,
        detail={"type": event_type, "plan": sub.plan_code, "status": sub.status},
    )
    # 캐시를 즉시 무효화한다. 안 그러면 결제 직후 60초 동안 무료 한도가 걸린다
    await entitlements.invalidate(user.id)
