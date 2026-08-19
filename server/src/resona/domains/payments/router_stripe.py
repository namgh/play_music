"""Stripe 결제 라우터.

**결제사는 payments 도메인이다.** 이 코드가 billing 에 있으면 "무엇을 할 수 있는가"를
읽으러 간 사람이 웹훅 서명 검증을 만나고, 무엇보다 billing 이 payments 의 웹훅
이벤트 테이블을 임포트하게 되어 **두 도메인이 서로를 물게 된다.**

국내는 토스(`router.py`)를 쓰고 여기는 해외용으로 남겨 둔다.
"""

import hashlib
import hmac
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from resona.core.deps import Config, Db, client_ip
from resona.core.errors import Conflict, NotFound, Unauthorized, Unprocessable
from resona.domains.accounts import service as accounts
from resona.domains.accounts.deps import ActiveUser
from resona.domains.billing import provider_stripe as gateway
from resona.domains.billing import service as entitlements
from resona.domains.ops import audit
from resona.domains.payments.models import BillingEvent
from resona.domains.workspaces import service as orgs

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
    settings: Config,
    signature: Annotated[str | None, Header(alias="X-Signature")] = None,
) -> Response:
    raw = await request.body()
    secret = settings.billing_webhook_secret.get_secret_value()
    if secret:
        verify_signature(secret=secret, payload=raw, header=signature)
    elif settings.is_production:
        # **fail-open 을 막는다.** 이 주소는 인증 없는 공개 엔드포인트라, 검증을
        # 건너뛰면 누구나 자기 조직을 Pro 로 올릴 수 있다. 운영에서는 애초에
        # 부팅이 막히지만(`config`), 방어선을 여기에도 둔다
        raise Unauthorized("웹훅 서명 검증이 설정되지 않았습니다", code="webhook_not_configured")
    else:
        log.warning("billing_webhook_secret_missing")  # 로컬 개발 전용 경로

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

    user = await accounts.get_by_email(session, email)
    if user is None:
        # 결제는 됐는데 계정이 없다. **삼키지 않는다** — 사람이 봐야 하는 상황이라
        # 이벤트 행에 남기고 일일 대사(reconciliation)가 잡는다
        log.error("billing_event_unknown_customer", extra={"event_id": event.get("id")})
        return

    # **어느 워크스페이스에 붙일 결제인가.** 체크아웃을 만들 때 `client_reference_id`
    # 와 메타데이터에 org_id 를 실어 보냈다(`services/payments.py`) — 그걸 읽는다.
    # 이메일로 추측하면 팀 결제가 결제한 사람의 개인 워크스페이스에 붙는다
    metadata = data.get("metadata") or {}
    raw_org = data.get("org_id") or data.get("client_reference_id") or metadata.get("org_id")
    if raw_org:
        org_id = uuid.UUID(str(raw_org))
    else:
        org_id = (await orgs.personal_org(session, user.id)).id

    sub = await entitlements.get_subscription(session, org_id)
    if sub is None:
        sub = await entitlements.start_free(session, org_id)
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
    if plan := (data.get("plan_code") or metadata.get("plan_code")):
        sub.plan_code = plan
    if period_end := data.get("current_period_end"):
        sub.current_period_end = datetime.fromtimestamp(float(period_end), tz=UTC)
    sub.external_ref = (
        data.get("customer") or data.get("subscription_id") or sub.external_ref
    )
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
        target_type="org",
        target_id=org_id,
        detail={"type": event_type, "plan": sub.plan_code, "status": sub.status},
    )
    # 캐시를 즉시 무효화한다. 안 그러면 결제 직후 60초 동안 무료 한도가 걸린다
    await entitlements.invalidate(org_id)


# --- 유료 전환 --------------------------------------------------------------
#
# **결제사 연동은 어댑터 뒤에 둔다.** 지금은 Stripe 를 전제하지만, 결제사를 바꾸는
# 일은 실제로 일어나고(수수료·지원 국가·심사) 그때 도메인 코드까지 흔들리면 안 된다.
# 그래서 이 라우터는 "체크아웃 세션을 만들어 URL 을 돌려준다"까지만 알고,
# 어떻게 만드는지는 `services/payments.py` 가 안다.


class CheckoutIn(BaseModel):
    plan_code: str = Field(min_length=1, max_length=50)
    org_id: uuid.UUID | None = None
    # 결제 후 돌아올 곳. **우리 앱 경로만 받는다** (열린 리다이렉트 방지)
    return_path: str = Field(default="/", max_length=200)


class CheckoutOut(BaseModel):
    checkout_url: str
    plan_code: str
    org_id: uuid.UUID


@router.post("/billing/checkout", response_model=CheckoutOut)
async def start_checkout(
    body: CheckoutIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> CheckoutOut:
    """유료 전환 시작. **과금 단위가 조직이라 owner 만 시작할 수 있다.**

    editor 가 결제를 시작할 수 있으면 팀원 아무나 조직에 청구를 만들 수 있다.
    """
    org = await orgs.resolve_org(session, user_id=user.id, org_id=body.org_id, need=orgs.BILLING)

    plan = await entitlements.get_plan(session, body.plan_code)
    if plan is None or not plan.active:
        raise NotFound("플랜을 찾을 수 없습니다", code="plan_not_found")
    if plan.code == "free":
        raise Unprocessable("무료 플랜은 결제가 필요 없습니다", code="plan_not_payable")

    sub = await entitlements.get_subscription(session, org.id)
    if sub is not None and sub.plan_code == plan.code and sub.status == "active":
        raise Conflict("이미 이 플랜을 쓰고 있습니다", code="already_subscribed")

    return_path = body.return_path
    if not return_path.startswith("/") or return_path.startswith("//"):
        return_path = "/"

    url = await gateway.create_checkout_session(
        settings,
        org_id=org.id,
        org_name=org.name,
        plan=plan,
        customer_email=user.email,
        return_url=f"{settings.app_base_url.rstrip('/')}{return_path}",
    )

    await audit.record(
        session,
        action="billing.checkout_start",
        actor_id=user.id,
        target_type="org",
        target_id=org.id,
        detail={"plan": plan.code},
        ip=client_ip(request),
    )
    return CheckoutOut(checkout_url=url, plan_code=plan.code, org_id=org.id)


class PortalOut(BaseModel):
    portal_url: str


@router.post("/billing/portal", response_model=PortalOut)
async def billing_portal(
    request: Request, session: Db, settings: Config, user: ActiveUser,
    org_id: uuid.UUID | None = None,
) -> PortalOut:
    """결제수단 변경·영수증·해지. **우리가 직접 만들지 않는다** —
    카드 정보를 우리 화면에서 받는 순간 PCI 범위가 통째로 넘어온다"""
    org = await orgs.resolve_org(session, user_id=user.id, org_id=org_id, need=orgs.BILLING)
    sub = await entitlements.get_subscription(session, org.id)
    if sub is None or not sub.external_ref:
        raise Conflict("결제 내역이 없습니다", code="no_subscription")

    url = await gateway.create_portal_session(
        settings,
        external_ref=sub.external_ref,
        return_url=settings.app_base_url.rstrip("/"),
    )
    await audit.record(
        session,
        action="billing.portal",
        actor_id=user.id,
        target_type="org",
        target_id=org.id,
        ip=client_ip(request),
    )
    return PortalOut(portal_url=url)


