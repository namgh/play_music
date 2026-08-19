"""토스페이먼츠 — 카드 등록(빌링키) (`SERVER_PAYMENTS.md` 3-1).

`billing.py` 와 나눠 둔다. 저기는 Stripe 모양(체크아웃 세션·포털)이고 여기는
빌링키 모양이라, 한 파일에 섞으면 "지금 어느 결제사의 흐름을 읽고 있는가"가
헷갈린다. 결제사는 언젠가 또 늘어난다.

## 흐름

    ① POST /v1/billing/toss/prepare   서버가 customer_key 를 만들어 준다
    ② 브라우저가 토스 SDK 로 카드 등록창을 띄운다  ← **카드번호는 여기까지만 간다**
    ③ POST /v1/billing/toss/issue     authKey 를 빌링키로 교환해 암호화 저장

**카드번호가 우리 서버에 오는 구간이 없다.** 그래서 PCI-DSS 범위 밖에 남는다.
"""

from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from resona.api.deps import ActiveUser, Config, Db, client_ip
from resona.core import audit, crypto
from resona.core.errors import Conflict, NotFound
from resona.core.ratelimit import check as rate_check
from resona.db.models import (
    BillingCustomer,
    BillingEvent,
    BillingKey,
    Payment,
    PaymentOrder,
    Plan,
    Subscription,
)
from resona.services import billing_run, entitlements, orgs, toss

log = logging.getLogger(__name__)
router = APIRouter(tags=["billing"], prefix="/billing/toss")


class PrepareOut(BaseModel):
    customer_key: str
    #: 브라우저가 SDK 를 초기화할 때 쓰는 **공개** 키
    client_key: str


async def _resolve_customer(session: Db, org_id) -> BillingCustomer:
    """조직당 하나. **추측 불가능한 값으로 만든다.**

    이 값은 결제창 SDK 로 넘어가 브라우저에 노출된다. 조직 UUID 를 그대로 쓰면
    내부 식별자가 밖으로 나가고, 남이 "이 조직이 있는가"를 물어볼 수 있게 된다.
    """
    row = (
        await session.execute(
            select(BillingCustomer).where(BillingCustomer.org_id == org_id)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row

    customer = BillingCustomer(
        org_id=org_id, provider="toss", customer_key=secrets.token_urlsafe(24)
    )
    session.add(customer)
    await session.flush()
    return customer


@router.post("/prepare", response_model=PrepareOut)
async def prepare_billing(
    request: Request,
    session: Db,
    settings: Config,
    user: ActiveUser,
    org_id: uuid.UUID | None = None,
) -> PrepareOut:
    """카드 등록창을 띄우기 전에 부른다.

    **과금은 소유자만 건드린다** (`orgs.BILLING`). 편집자가 팀 카드를 바꿀 수 있으면
    그건 권한 설계가 아니라 사고다.
    """
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    if not settings.toss_client_key:
        raise toss.TossUnavailable("결제가 설정되지 않았습니다")

    customer = await _resolve_customer(session, org.id)
    await audit.record(
        session,
        action="billing.prepare",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )
    return PrepareOut(customer_key=customer.customer_key, client_key=settings.toss_client_key)


class IssueIn(BaseModel):
    # 토스 카드 등록창이 성공 URL 로 돌려주는 값
    auth_key: str = Field(min_length=1, max_length=300)
    customer_key: str = Field(min_length=1, max_length=300)
    org_id: uuid.UUID | None = None


class CardOut(BaseModel):
    brand: str | None
    last4: str | None
    registered_at: datetime


@router.post("/issue", response_model=CardOut)
async def issue_billing_key(
    body: IssueIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> CardOut:
    """`authKey` 를 **빌링키로 교환**해 암호화 저장한다.

    `customer_key` 를 그대로 믿지 않는다 — 남의 것을 보내서 그 조직에 카드를
    붙이려는 시도가 가능하다. **우리가 저장해 둔 값과 대조**한다.
    """
    await rate_check("billing_issue", str(user.id))
    org = await orgs.resolve_org(
        session, user=user, org_id=body.org_id, need=orgs.BILLING
    )

    customer = (
        await session.execute(
            select(BillingCustomer).where(BillingCustomer.org_id == org.id)
        )
    ).scalar_one_or_none()
    if customer is None or not secrets.compare_digest(
        customer.customer_key, body.customer_key
    ):
        # 남의 customer_key 로 붙이려는 시도. **무엇이 틀렸는지 알려주지 않는다**
        await audit.record(
            session,
            action="billing.issue_customer_mismatch",
            actor_id=user.id,
            target_type="organization",
            target_id=org.id,
            ip=client_ip(request),
        )
        await audit.persist_and_raise(
            session, NotFound("카드 등록 정보를 찾을 수 없습니다", code="customer_not_found")
        )

    issued = await toss.issue_billing_key(
        settings, auth_key=body.auth_key, customer_key=customer.customer_key
    )
    billing_key = str(issued.get("billingKey") or "")
    if not billing_key:
        raise toss.TossRejected("카드 등록에 실패했습니다", toss_code="no_billing_key")

    card = issued.get("card") or {}
    now = datetime.now(UTC)

    # **이전 카드를 먼저 회수한다.** 조직당 살아 있는 카드는 하나라는 규칙이
    # DB 인덱스로도 걸려 있어서, 안 끄면 여기서 유니크 위반이 난다.
    # 이력은 남는다 — "언제 어느 카드로 긁혔나"를 나중에 물어보게 된다
    await session.execute(
        update(BillingKey)
        .where(BillingKey.org_id == org.id, BillingKey.status == "active")
        .values(status="revoked", revoked_at=now)
    )

    session.add(
        BillingKey(
            org_id=org.id,
            billing_key_enc=crypto.encrypt(settings, billing_key),
            card_brand=card.get("issuerCode") or card.get("company"),
            card_last4=(card.get("number") or "")[-4:] or None,
            status="active",
        )
    )
    # **빌링키 자체는 절대 감사에 남기지 않는다.** 남기면 감사 로그가 곧 결제 수단이 된다
    await audit.record(
        session,
        action="billing.issue_key",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        detail={"card_last4": (card.get("number") or "")[-4:]},
        ip=client_ip(request),
    )
    return CardOut(
        brand=card.get("issuerCode") or card.get("company"),
        last4=(card.get("number") or "")[-4:] or None,
        registered_at=now,
    )


@router.get("/card", response_model=CardOut | None)
async def current_card(
    session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> CardOut | None:
    """등록된 카드를 보여준다. **복호화하지 않는다** — 표시용 컬럼만 읽는다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    row = (
        await session.execute(
            select(BillingKey).where(
                BillingKey.org_id == org.id, BillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return CardOut(brand=row.card_brand, last4=row.card_last4, registered_at=row.created_at)


@router.delete("/card", status_code=204)
async def remove_card(
    request: Request, session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> None:
    """카드를 뺀다. **구독은 여기서 해지하지 않는다** — 그건 별도 행위다
    (Day 6). 카드만 빠지면 다음 결제가 실패해 `past_due` 로 흘러간다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    await session.execute(
        update(BillingKey)
        .where(BillingKey.org_id == org.id, BillingKey.status == "active")
        .values(status="revoked", revoked_at=datetime.now(UTC))
    )
    await audit.record(
        session,
        action="billing.remove_card",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )


# --- 웹훅 -------------------------------------------------------------------


class WebhookResult(BaseModel):
    received: bool


@router.post("/webhook", response_model=WebhookResult)
async def toss_webhook(request: Request, session: Db, settings: Config) -> WebhookResult:
    """토스가 "뭔가 바뀌었다"고 알려 준다 (`SERVER_PAYMENTS.md` 2절).

    ## 본문을 믿지 않는다

    이 URL 은 공개 주소다. 토스의 검증 방식이 무엇이든(서명·IP 허용목록) **그것
    하나에 기대지 않는다** — 웹훅 본문을 그대로 반영하면 위조 요청 하나로 남의
    조직을 유료로 만들 수 있다.

        ① 통째로 적는다 (판단하지 않는다)
        ② 주문번호로 **토스에 직접 조회한다** ← 유일한 진실
        ③ 조회 결과로만 상태를 바꾼다

    그래서 위조 웹훅이 와도 아무 일도 안 일어난다. 토스에 물어보면 "그런 결제
    없음"이 나오기 때문이다.

    ## 항상 200 을 준다

    우리가 처리하다 실패했다고 4xx/5xx 를 주면 토스가 계속 재전송한다. 받아서
    적는 데 성공했으면 200 이고, 반영은 우리 쪽 일이다.
    """
    raw = await request.body()
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        log.warning("toss_webhook_unparseable")
        return WebhookResult(received=True)
    if not isinstance(payload, dict):
        return WebhookResult(received=True)

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    order_id = str(data.get("orderId") or "")
    event_type = str(payload.get("eventType") or "UNKNOWN")
    now = datetime.now(UTC)

    # **먼저 적는다.** 판단은 그 다음이다 — 적기 전에 판단하다 죽으면 흔적이 없다.
    # `eventType + orderId + status` 를 키로 삼는다: 토스가 이벤트 ID 를 주지 않는
    # 형태여도 같은 전이가 두 번 반영되지 않는다
    event_id = f"{event_type}:{order_id}:{data.get('status') or ''}"
    if await session.get(BillingEvent, event_id) is not None:
        return WebhookResult(received=True)  # 이미 봤다

    session.add(
        BillingEvent(
            id=event_id, type=event_type, payload=payload, occurred_at=now
        )
    )
    await session.flush()

    if not order_id:
        return WebhookResult(received=True)

    order = (
        await session.execute(
            select(PaymentOrder).where(PaymentOrder.order_id == order_id)
        )
    ).scalar_one_or_none()
    if order is None:
        # **우리가 만들지 않은 주문번호다.** 위조이거나 남의 것 — 아무것도 하지 않는다
        log.warning("toss_webhook_unknown_order", extra={"event": event_type})
        return WebhookResult(received=True)

    try:
        # ② 유일한 진실은 조회 API 다
        await billing_run.reconcile_order(session, settings, order)
    except Exception:  # noqa: BLE001
        # 반영에 실패해도 200 이다. 적어 뒀으니 `reconcile_pending_payments` 가 마저 한다
        log.exception("toss_webhook_apply_failed", extra={"order_id": order_id})
        return WebhookResult(received=True)

    ev = await session.get(BillingEvent, event_id)
    if ev is not None:
        ev.processed_at = datetime.now(UTC)
    return WebhookResult(received=True)


# --- 구독 -------------------------------------------------------------------


class SubscribeIn(BaseModel):
    plan_code: str = Field(min_length=1, max_length=40)
    org_id: uuid.UUID | None = None


class SubscriptionOut(BaseModel):
    plan_code: str
    status: str
    commercial_license: bool
    current_period_end: datetime | None
    next_charge_at: datetime | None
    last_failure_code: str | None


def _sub_out(sub: Subscription) -> SubscriptionOut:
    return SubscriptionOut(
        plan_code=sub.plan_code,
        status=sub.status,
        commercial_license=sub.commercial_license,
        current_period_end=sub.current_period_end,
        next_charge_at=sub.next_charge_at,
        last_failure_code=sub.last_failure_code,
    )


@router.get("/subscription", response_model=SubscriptionOut | None)
async def my_subscription(
    session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> SubscriptionOut | None:
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    sub = await session.get(Subscription, org.id)
    return _sub_out(sub) if sub else None


@router.post("/subscribe", response_model=SubscriptionOut)
async def subscribe(
    body: SubscribeIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> SubscriptionOut:
    """구독을 시작한다 — **첫 결제를 즉시 긁는다.**

    "가입만 시켜 두고 다음 달에 긁는다"로 하면 카드가 잘못돼 있어도 한 달 뒤에야
    알게 되고, 그 사이 사용자는 유료 기능을 다 쓴 뒤다.
    """
    await rate_check("billing_issue", str(user.id))
    org = await orgs.resolve_org(session, user=user, org_id=body.org_id, need=orgs.BILLING)

    plan = await session.get(Plan, body.plan_code)
    if plan is None or not plan.active or not plan.price_krw:
        raise NotFound("구독할 수 있는 플랜이 아닙니다", code="plan_not_purchasable")

    if await billing_run.active_billing_key(session, org.id) is None:
        raise Conflict("결제 카드를 먼저 등록해 주세요", code="no_billing_key")

    sub = await session.get(Subscription, org.id)
    if sub is None:
        sub = Subscription(org_id=org.id, plan_code=plan.code, status="active")
        session.add(sub)
        await session.flush()

    if sub.status in ("active", "past_due") and sub.plan_code == plan.code and sub.next_charge_at:
        raise Conflict("이미 구독 중입니다", code="already_subscribed")

    # **새로 시작하는 건가.** 첫 결제가 실패하면 `past_due` 로 두면 안 된다 —
    # 결제된 적이 없는데 "밀린 요금"이 있는 상태가 되어 버린다
    starting_fresh = sub.current_period_end is None
    sub.plan_code = plan.code
    sub.commercial_license = plan.commercial_license

    result = await billing_run.charge_subscription(session, settings, sub)

    if result.outcome == "charged":
        await audit.record(
            session,
            action="billing.subscribe",
            actor_id=user.id,
            target_type="organization",
            target_id=org.id,
            detail={"plan": plan.code, "amount": plan.price_krw},
            ip=client_ip(request),
        )
        return _sub_out(sub)

    if result.outcome == "uncertain":
        # 결과를 모른다. **여기서 재시도하지 않는다** — 조회 잡이 정리한다
        raise toss.TossUncertain(
            "결제 결과를 확인하는 중입니다. 잠시 후 구독 상태를 확인해 주세요"
        )

    if starting_fresh:
        sub.status = "canceled"
        sub.next_charge_at = None
        sub.retry_count = 0
    await audit.record(
        session,
        action="billing.subscribe_failed",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        detail={"code": sub.last_failure_code},
        ip=client_ip(request),
    )
    await audit.persist_and_raise(
        session,
        toss.TossRejected(
            "결제에 실패했습니다. 카드 상태를 확인해 주세요",
            toss_code=sub.last_failure_code or "",
        ),
    )
    raise AssertionError("unreachable")  # pragma: no cover


@router.post("/cancel", response_model=SubscriptionOut)
async def cancel_subscription(
    request: Request, session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> SubscriptionOut:
    """해지 예약. **이미 낸 달은 끝까지 쓴다** (`SERVER_BILLING.md` 2절).

    즉시 끊으면 환불 요구가 따라오고, 무엇보다 사용자가 손해를 본다.
    """
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    sub = await session.get(Subscription, org.id)
    if sub is None or sub.status not in ("active", "past_due"):
        raise Conflict("해지할 구독이 없습니다", code="not_subscribed")

    sub.status = "canceling"
    sub.next_charge_at = None  # 다음 달부터 안 긁는다
    sub.updated_at = datetime.now(UTC)
    await entitlements.invalidate(org.id)
    await audit.record(
        session,
        action="billing.cancel",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )
    return _sub_out(sub)


@router.post("/resume", response_model=SubscriptionOut)
async def resume_subscription(
    request: Request, session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> SubscriptionOut:
    """해지를 무른다. **기간이 아직 남아 있을 때만** 된다 — 이미 끝났으면
    새로 구독하는 것이지 무르는 게 아니다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    sub = await session.get(Subscription, org.id)
    now = datetime.now(UTC)
    if sub is None or sub.status != "canceling":
        raise Conflict("해지 예약 상태가 아닙니다", code="not_canceling")
    if sub.current_period_end is None or sub.current_period_end <= now:
        raise Conflict("이용 기간이 끝났습니다. 다시 구독해 주세요", code="period_ended")

    sub.status = "active"
    sub.next_charge_at = sub.current_period_end
    sub.updated_at = now
    await entitlements.invalidate(org.id)
    await audit.record(
        session,
        action="billing.resume",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )
    return _sub_out(sub)


# --- 영수증·환불 -------------------------------------------------------------


class PaymentOut(BaseModel):
    id: uuid.UUID
    amount: int
    refunded_amount: int
    status: str
    method: str | None
    receipt_url: str | None
    approved_at: datetime | None


@router.get("/payments", response_model=list[PaymentOut])
async def list_payments(
    session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> list[PaymentOut]:
    """결제 내역. **사용자가 스스로 확인할 수 있어야 한다** — 문의가 반으로 준다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    rows = (
        await session.execute(
            select(Payment)
            .where(Payment.org_id == org.id)
            .order_by(Payment.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    return [
        PaymentOut(
            id=p.id,
            amount=p.amount,
            refunded_amount=p.refunded_amount,
            status=p.status,
            method=p.method,
            receipt_url=p.receipt_url,
            approved_at=p.approved_at,
        )
        for p in rows
    ]


class RefundIn(BaseModel):
    reason: str = Field(min_length=1, max_length=200)
    # 없으면 남은 전액
    amount: int | None = Field(default=None, gt=0)


@router.post("/payments/{payment_id}/refund", response_model=PaymentOut)
async def refund_payment(
    payment_id: uuid.UUID,
    body: RefundIn,
    request: Request,
    session: Db,
    settings: Config,
    user: ActiveUser,
) -> PaymentOut:
    """환불. **부분 환불을 지원한다** — 전액만 되면 운영이 "다 돌려주거나 안 주거나"
    가 되어 분쟁이 커진다.

    금액은 **서버가 계산한 남은 금액**을 넘지 못한다. 클라이언트 값을 그대로
    믿으면 결제액보다 많이 돌려주는 길이 열린다.
    """
    payment = await session.get(Payment, payment_id)
    if payment is None:
        raise NotFound("결제를 찾을 수 없습니다", code="payment_not_found")
    # 소유 확인 — 남의 결제를 환불시킬 수 없다
    await orgs.resolve_org(session, user=user, org_id=payment.org_id, need=orgs.BILLING)

    remaining = payment.amount - payment.refunded_amount
    if remaining <= 0:
        raise Conflict("이미 전액 환불되었습니다", code="already_refunded")
    amount = min(body.amount or remaining, remaining)

    result = await toss.cancel_payment(
        settings,
        payment_key=payment.payment_key,
        reason=body.reason,
        amount=amount if amount < payment.amount else None,
        idempotency_key=f"refund-{payment.id}-{payment.refunded_amount + amount}",
    )

    payment.refunded_amount += amount
    payment.status = str(result.get("status") or payment.status)
    payment.raw = result or payment.raw
    await audit.record(
        session,
        action="billing.refund",
        actor_id=user.id,
        target_type="payment",
        target_id=payment.id,
        detail={"amount": amount, "reason": body.reason},
        ip=client_ip(request),
    )
    return PaymentOut(
        id=payment.id,
        amount=payment.amount,
        refunded_amount=payment.refunded_amount,
        status=payment.status,
        method=payment.method,
        receipt_url=payment.receipt_url,
        approved_at=payment.approved_at,
    )
