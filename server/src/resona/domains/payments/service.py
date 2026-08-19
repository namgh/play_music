"""정기결제 실행 — **매달 긁는 것은 우리 일이다** (`SERVER_PAYMENTS.md` 1-1).

토스는 Stripe 와 달리 구독을 대신 굴려주지 않는다. 빌링키만 주고, 언제 얼마를
청구할지는 우리가 정해서 API 를 부른다. 그래서 이 모듈이 필요하다.

---

## 이중 청구를 막는 세 겹

1. **주문번호가 곧 멱등키다.** 토스 쪽에서 같은 키를 두 번 처리하지 않는다
2. **DB 부분 유니크** — 한 주기에 `approved` 인 주문은 하나뿐이다
3. **미결 주문이 있으면 새로 만들지 않는다** — 아래의 "불확실" 규칙

셋 중 하나만 있어도 대개는 막히지만, 돈에서는 한 겹이 뚫렸을 때 다음 겹이 있어야
한다. 이중 청구는 되돌리는 비용이 가장 비싼 사고다.

## 결과가 불확실할 때 — 여기가 제일 조심스러운 곳

승인 요청이 타임아웃 나면 **결제가 됐는지 안 됐는지 모른다.** 그때:

  · 재시도하지 **않는다**
  · 주문을 `pending` 으로 남긴다
  · 구독 상태를 건드리지 **않는다**
  · `reconcile_pending_orders` 가 조회 API 로 진실을 확인한다

그리고 **미결 주문이 있는 구독은 다음 결제를 시도하지 않는다.** 이게 없으면
스케줄러가 다음 틱에 또 긁어서, 애써 만든 "재시도 안 함"이 무의미해진다.
"""

from __future__ import annotations

import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from resona.core import crypto
from resona.core.config import Settings
from resona.domains.billing import service as billing
from resona.domains.billing import service as entitlements

if TYPE_CHECKING:  # 타입 표기 전용 — **런타임 결합을 만들지 않는다.**
    # 결제는 구독을 긁는 일이라 `payments → billing` 방향 의존은 설계상 맞다.
    # 다만 그 반대는 없어야 하고, 실행 시점에는 임포트조차 없어야 한다
    from resona.domains.billing.models import Subscription
from resona.domains.payments import provider_toss as toss
from resona.domains.payments import repository
from resona.domains.payments.models import BillingKey, Payment, PaymentOrder

log = logging.getLogger(__name__)

#: 연속 실패 1·2·3회째에 **며칠 뒤** 다시 시도하는가.
#: 즉시 재시도는 의미가 없다 — 한도초과·정지는 시간이 지나야 풀린다
RETRY_AFTER_DAYS = (1, 3, 7)

#: 이 횟수를 넘기면 포기하고 해지한다
MAX_ATTEMPTS = len(RETRY_AFTER_DAYS) + 1

#: 미결 주문을 조회로 확인하기까지 기다리는 시간. 너무 짧으면 토스가 아직
#: 처리 중인 것을 "없다"고 읽을 수 있다
RECONCILE_AFTER = timedelta(minutes=2)


@dataclass(frozen=True)
class ChargeResult:
    outcome: str  # 'charged' | 'rejected' | 'uncertain' | 'skipped'
    detail: str = ""


def new_order_id(prefix: str = "sub") -> str:
    """토스에 보내는 주문번호. **추측 불가능해야 한다** — 남의 주문번호를 알면
    그 결제의 상태를 조회해 볼 수 있다"""
    return f"{prefix}-{secrets.token_urlsafe(18)}"


def add_month(at: datetime) -> datetime:
    """한 달 뒤. **말일을 넘기지 않게 자른다** — 1월 31일의 한 달 뒤는 2월 28일이다.

    안 자르면 3월 3일이 되어 사용자가 "왜 3월에 두 번 긁혔냐"고 묻게 된다.
    """
    year = at.year + (at.month == 12)
    month = at.month % 12 + 1
    # 다음 달의 마지막 날
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return at.replace(year=year, month=month, day=min(at.day, last))


async def active_billing_key(session: AsyncSession, org_id: uuid.UUID) -> BillingKey | None:
    return (
        await session.execute(
            select(BillingKey).where(
                BillingKey.org_id == org_id, BillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()


async def has_unresolved_order(session: AsyncSession, org_id: uuid.UUID) -> bool:
    """**미결 주문이 있으면 새로 긁지 않는다.**

    타임아웃으로 결과를 모르는 주문이 떠 있는데 또 청구하면, 앞의 것이 사실은
    성공이었을 때 두 번 긁힌다.
    """
    return (
        await session.execute(
            select(PaymentOrder.id).where(
                PaymentOrder.org_id == org_id, PaymentOrder.status == "pending"
            )
        )
    ).first() is not None


def _cycle_start(sub: Subscription, now: datetime) -> date:
    """이번 청구가 **어느 주기의 것인가.** 중복 청구를 막는 DB 제약의 기준이다"""
    if sub.current_period_end is None:
        return now.date()
    return sub.current_period_end.date()


async def _record_success(
    session: AsyncSession,
    *,
    sub: Subscription,
    order: PaymentOrder,
    payload: dict,
    now: datetime,
) -> None:
    order.status = "approved"
    order.failure_code = None

    session.add(
        Payment(
            payment_key=str(payload.get("paymentKey") or order.order_id),
            order_id=order.id,
            org_id=sub.org_id,
            amount=int(payload.get("totalAmount") or order.amount),
            status=str(payload.get("status") or "DONE"),
            method=payload.get("method"),
            receipt_url=(payload.get("receipt") or {}).get("url"),
            approved_at=now,
            # 분쟁에서 "그때 토스가 뭐라고 했는지"가 유일한 증거다
            raw=payload,
        )
    )

    base = sub.current_period_end or now
    # **과거로 밀리지 않게 한다.** 오래 멈춰 있던 구독을 되살릴 때 이미 지난
    # 날짜로 갱신하면 다음 틱에 또 긁는다
    sub.current_period_end = add_month(max(base, now))
    sub.next_charge_at = sub.current_period_end
    sub.status = "active"
    sub.retry_count = 0
    sub.last_failure_code = None
    sub.updated_at = now
    await entitlements.invalidate(sub.org_id)


def _schedule_retry(sub: Subscription, now: datetime, failure_code: str) -> str:
    """실패 상태기계 (`SERVER_PAYMENTS.md` 3-3).

    **즉시 막지 않는다** — 카드 만료로 작업이 잠기는 경험이 해지보다 나쁘다.
    다만 무한정 끌지도 않는다.
    """
    sub.retry_count += 1
    sub.last_failure_code = failure_code
    sub.updated_at = now

    if sub.retry_count >= MAX_ATTEMPTS:
        sub.status = "canceled"
        sub.next_charge_at = None
        # **해지돼도 만든 곡은 안 지운다.** 새 곡만 막힌다 (`SERVER_PAYMENTS.md` 3-3)
        return "canceled"

    sub.status = "past_due"
    sub.next_charge_at = now + timedelta(days=RETRY_AFTER_DAYS[sub.retry_count - 1])
    return "past_due"


async def charge_subscription(
    session: AsyncSession, settings: Settings, sub: Subscription, *, now: datetime | None = None
) -> ChargeResult:
    """구독 하나를 청구한다. **부르는 쪽이 잠금을 쥔 상태여야 한다**"""
    now = now or datetime.now(UTC)

    plan = await billing.get_plan(session, sub.plan_code)
    if plan is None or not plan.price_krw:
        return ChargeResult("skipped", "유료 플랜이 아니다")

    if await has_unresolved_order(session, sub.org_id):
        # 앞선 시도의 결과를 아직 모른다. **확인이 끝나기 전에는 손대지 않는다**
        return ChargeResult("skipped", "미결 주문이 있다")

    key = await active_billing_key(session, sub.org_id)
    if key is None:
        outcome = _schedule_retry(sub, now, "NO_BILLING_KEY")
        return ChargeResult("rejected", outcome)

    order = PaymentOrder(
        order_id=new_order_id(),
        org_id=sub.org_id,
        amount=plan.price_krw,
        purpose="subscription",
        plan_code=sub.plan_code,
        cycle_start=_cycle_start(sub, now),
        status="pending",
    )
    session.add(order)
    # **여기서 유니크 제약이 걸린다.** 같은 주기가 이미 승인돼 있으면 터진다
    await session.flush()

    try:
        payload = await toss.charge_with_billing_key(
            settings,
            billing_key=crypto.decrypt(settings, bytes(key.billing_key_enc)),
            customer_key=await _customer_key(session, sub.org_id),
            amount=order.amount,
            order_id=order.order_id,
            order_name=f"{plan.display_name} 구독",
        )
    except toss.TossUncertain:
        # ⚠ **재시도하지 않는다.** 주문을 미결로 남기고 조회로 확인한다
        log.warning("charge_uncertain", extra={"order_id": order.order_id})
        return ChargeResult("uncertain", order.order_id)
    except toss.TossRejected as exc:
        order.status = "failed"
        order.failure_code = exc.toss_code or "REJECTED"
        outcome = _schedule_retry(sub, now, order.failure_code)
        await entitlements.invalidate(sub.org_id)
        log.info("charge_rejected", extra={"code": order.failure_code, "next": outcome})
        return ChargeResult("rejected", outcome)

    await _record_success(session, sub=sub, order=order, payload=payload, now=now)
    return ChargeResult("charged", order.order_id)


async def _customer_key(session: AsyncSession, org_id: uuid.UUID) -> str:
    row = (
        await session.execute(
            text("SELECT customer_key FROM billing_customers WHERE org_id = :o"),
            {"o": org_id},
        )
    ).scalar_one_or_none()
    return str(row or "")


async def reconcile_order(
    session: AsyncSession, settings: Settings, order: PaymentOrder, *, now: datetime | None = None
) -> ChargeResult:
    """미결 주문의 **진실을 토스에 물어본다.**

    이게 "타임아웃에 재시도하지 않는다"를 성립시키는 반쪽이다. 확인할 길이 없으면
    결국 재시도할 수밖에 없고, 그러면 이중 청구가 난다.
    """
    now = now or datetime.now(UTC)
    sub = await billing.get_subscription(session, order.org_id)

    try:
        payload = await toss.get_payment_by_order_id(settings, order_id=order.order_id)
    except toss.TossRejected:
        # 그런 결제가 없다 = **긁히지 않았다.** 실패로 확정해도 안전하다
        order.status = "failed"
        order.failure_code = "NOT_FOUND"
        if sub is not None:
            _schedule_retry(sub, now, "NOT_FOUND")
            await entitlements.invalidate(sub.org_id)
        return ChargeResult("rejected", "결제되지 않았다")
    except toss.TossUncertain:
        # 아직도 모른다. **그대로 둔다** — 다음 주기에 다시 물어본다
        return ChargeResult("uncertain", order.order_id)

    status = str(payload.get("status") or "")
    if status in ("DONE", "CANCELED", "PARTIAL_CANCELED"):
        if sub is None:
            order.status = "approved"
            return ChargeResult("charged", order.order_id)
        await _record_success(session, sub=sub, order=order, payload=payload, now=now)
        return ChargeResult("charged", order.order_id)

    order.status = "failed"
    order.failure_code = status or "UNKNOWN"
    if sub is not None:
        _schedule_retry(sub, now, order.failure_code)
        await entitlements.invalidate(sub.org_id)
    return ChargeResult("rejected", status)


async def active_card(session: AsyncSession, org_id: uuid.UUID):
    """**표시용 뒷자리만 읽는다.** 빌링키는 복호화하지 않는다"""
    return await repository.active_key(session, org_id)


async def recent_payments(session: AsyncSession, org_id: uuid.UUID, *, limit: int = 24) -> list:
    return await repository.list_payments(session, org_id, limit=limit)
