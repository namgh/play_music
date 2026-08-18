"""정기결제 실행 — **이중 청구를 막는 세 겹**과 실패 상태기계.

토스는 구독을 대신 굴려주지 않는다. 매달 긁는 게 우리 일이라, 여기가 틀리면
사용자 카드에서 돈이 두 번 빠진다. 되돌리는 비용이 가장 비싼 사고다.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import text

from app.db.models import Subscription
from app.services import billing_run, toss
from tests.test_billing_toss import _issue, _prepare
from tests.test_projects import signup


def _charge_ok(prefix: str = "pk", amount: int = 4400):
    """**결제마다 다른 `paymentKey` 를 준다.**

    토스가 실제로 그렇고, `payments.payment_key` 도 전역 유니크다. 더블이 고정값을
    주면 두 번째 결제에서 우리 제약에 걸려 테스트가 엉뚱한 이유로 실패한다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        order_id = body.get("orderId") or request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(
            200,
            json={
                "paymentKey": f"{prefix}-{order_id}",
                "orderId": order_id,
                "status": "DONE",
                "totalAmount": amount,
                "method": "카드",
                "receipt": {"url": "https://receipt.example/1"},
            },
        )

    return httpx.MockTransport(handler)


def _charge_rejected(code: str = "NOT_ENOUGH_BALANCE"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": code, "message": "..."})

    return httpx.MockTransport(handler)


def _timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timeout", request=request)

    return httpx.MockTransport(handler)


async def setup_org_with_card(client, db, email) -> tuple[str, str]:
    """카드까지 등록된 조직을 만든다"""
    token = await signup(client, email)
    prepared = await _prepare(client, token)
    res = await _issue(client, token, prepared["customer_key"])
    assert res.status_code == 200, res.text
    org_id = (
        await db.execute(
            text("SELECT org_id FROM billing_customers WHERE customer_key = :ck"),
            {"ck": prepared["customer_key"]},
        )
    ).scalar_one()
    return token, org_id


async def _sub(db, org_id, **kw) -> Subscription:
    sub = await db.get(Subscription, org_id)
    sub.plan_code = kw.pop("plan_code", "pro")
    for k, v in kw.items():
        setattr(sub, k, v)
    await db.commit()
    return sub


# --- 성공 경로 ---------------------------------------------------------------


async def test_first_charge_starts_the_period(client, unique_email, db, settings):
    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    with toss.use_transport(_charge_ok()):
        result = await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    assert result.outcome == "charged", result.detail
    assert sub.status == "active"
    assert sub.current_period_end is not None
    assert sub.next_charge_at == sub.current_period_end
    assert sub.retry_count == 0

    row = (
        await db.execute(
            text("SELECT amount, status FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).first()
    assert row.amount == 4400, "플랜 가격(₩4,400)으로 긁혀야 한다"


async def test_month_end_does_not_overflow():
    """**1월 31일의 한 달 뒤는 2월 28일이다.**

    안 자르면 3월 3일이 되고, 사용자는 "왜 3월에 두 번 긁혔냐"고 묻게 된다.
    """
    jan31 = datetime(2026, 1, 31, tzinfo=UTC)
    assert billing_run.add_month(jan31).date().isoformat() == "2026-02-28"
    assert billing_run.add_month(datetime(2026, 3, 31, tzinfo=UTC)).day == 30


async def test_renewal_never_moves_the_period_into_the_past(
    client, unique_email, db, settings
):
    """오래 멈춰 있던 구독을 되살릴 때 이미 지난 날짜로 갱신하면 **다음 틱에 또 긁는다**"""
    _, org_id = await setup_org_with_card(client, db, unique_email)
    long_ago = datetime.now(UTC) - timedelta(days=200)
    sub = await _sub(db, org_id, status="past_due", current_period_end=long_ago)

    with toss.use_transport(_charge_ok()):
        await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    assert sub.current_period_end > datetime.now(UTC)


# --- 실패 상태기계 -----------------------------------------------------------


async def test_rejection_goes_past_due_and_retries_in_a_day(
    client, unique_email, db, settings
):
    """**즉시 막지 않는다** — 카드 만료로 작업이 잠기는 경험이 해지보다 나쁘다"""
    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    with toss.use_transport(_charge_rejected()):
        result = await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    assert result.outcome == "rejected"
    assert sub.status == "past_due"
    assert sub.retry_count == 1
    assert sub.last_failure_code == "NOT_ENOUGH_BALANCE"
    assert sub.next_charge_at > datetime.now(UTC)


async def test_retries_escalate_then_give_up(client, unique_email, db, settings):
    """1일 → 3일 → 7일 → 해지. **무한정 끌지 않는다**"""
    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    gaps = []
    for _ in range(billing_run.MAX_ATTEMPTS):
        now = datetime.now(UTC)
        with toss.use_transport(_charge_rejected()):
            await billing_run.charge_subscription(db, settings, sub, now=now)
        await db.commit()
        if sub.next_charge_at:
            gaps.append(round((sub.next_charge_at - now).total_seconds() / 86400))

    assert gaps == list(billing_run.RETRY_AFTER_DAYS)
    assert sub.status == "canceled"
    assert sub.next_charge_at is None


async def test_a_missing_card_is_a_rejection_not_a_crash(client, unique_email, db, settings):
    _, org_id = await setup_org_with_card(client, db, unique_email)
    await db.execute(
        text("UPDATE billing_keys SET status = 'revoked' WHERE org_id = :o"), {"o": org_id}
    )
    await db.commit()
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    result = await billing_run.charge_subscription(db, settings, sub)
    await db.commit()
    assert result.outcome == "rejected"
    assert sub.last_failure_code == "NO_BILLING_KEY"


# --- 불확실 (이 파일에서 가장 중요한 부분) -----------------------------------


async def test_timeout_leaves_the_order_pending_and_does_not_touch_the_subscription(
    client, unique_email, db, settings
):
    """⚠ 타임아웃은 **실패가 아니다.** 결제됐는지 안 됐는지 모른다.

    실패로 확정하고 재시도하면 두 번 청구된다.
    """
    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None, retry_count=0)

    with toss.use_transport(_timeout()):
        result = await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    assert result.outcome == "uncertain"
    assert sub.status == "active", "결과를 모르는데 상태를 바꾸면 안 된다"
    assert sub.retry_count == 0, "실패로 세면 안 된다"

    order = (
        await db.execute(
            text("SELECT status FROM payment_orders WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert order == "pending"


async def test_an_unresolved_order_blocks_the_next_charge(
    client, unique_email, db, settings
):
    """⚠ **이게 없으면 "재시도 안 함"이 무의미해진다.**

    미결 주문을 둔 채 스케줄러가 다음 틱에 또 긁으면, 앞의 것이 사실은 성공이었을
    때 두 번 청구된다.
    """
    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    with toss.use_transport(_timeout()):
        await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    charged = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        charged["count"] += 1
        return httpx.Response(200, json={"paymentKey": "pk", "status": "DONE"})

    with toss.use_transport(httpx.MockTransport(handler)):
        second = await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    assert second.outcome == "skipped"
    assert charged["count"] == 0, "미결 주문이 있는데 또 긁었다 — 이중 청구다"


async def test_reconcile_confirms_a_payment_that_actually_went_through(
    client, unique_email, db, settings
):
    """조회해 보니 **결제가 됐더라** — 재시도 대신 이 길로 간다"""
    from app.db.models import PaymentOrder

    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    with toss.use_transport(_timeout()):
        await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    order = (
        await db.execute(
            text("SELECT id FROM payment_orders WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    order_obj = await db.get(PaymentOrder, order)

    with toss.use_transport(_charge_ok("pk_recovered")):
        result = await billing_run.reconcile_order(db, settings, order_obj)
    await db.commit()

    assert result.outcome == "charged"
    assert order_obj.status == "approved"
    await db.refresh(sub)
    assert sub.status == "active"
    assert sub.current_period_end is not None


async def test_reconcile_marks_it_failed_when_nothing_was_charged(
    client, unique_email, db, settings
):
    """조회해 보니 **그런 결제가 없더라** = 안 긁혔다. 실패로 확정해도 안전하다"""
    from app.db.models import PaymentOrder

    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)

    with toss.use_transport(_timeout()):
        await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    order_id = (
        await db.execute(
            text("SELECT id FROM payment_orders WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    order_obj = await db.get(PaymentOrder, order_id)

    def not_found(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": "NOT_FOUND_PAYMENT", "message": "x"})

    with toss.use_transport(httpx.MockTransport(not_found)):
        result = await billing_run.reconcile_order(db, settings, order_obj)
    await db.commit()

    assert result.outcome == "rejected"
    assert order_obj.status == "failed"
    await db.refresh(sub)
    assert sub.status == "past_due"


async def test_reconcile_leaves_it_alone_when_still_unknown(
    client, unique_email, db, settings
):
    """아직도 모르면 **그대로 둔다.** 추측해서 확정하는 것이 제일 나쁘다"""
    from app.db.models import PaymentOrder

    _, org_id = await setup_org_with_card(client, db, unique_email)
    sub = await _sub(db, org_id, status="active", current_period_end=None)
    with toss.use_transport(_timeout()):
        await billing_run.charge_subscription(db, settings, sub)
    await db.commit()

    order_id = (
        await db.execute(
            text("SELECT id FROM payment_orders WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    order_obj = await db.get(PaymentOrder, order_id)

    with toss.use_transport(_timeout()):
        result = await billing_run.reconcile_order(db, settings, order_obj)
    await db.commit()

    assert result.outcome == "uncertain"
    assert order_obj.status == "pending"


# --- DB 가 막는 것 -----------------------------------------------------------


async def test_the_database_refuses_two_approved_charges_in_one_cycle(
    client, unique_email, db, settings
):
    """**코드가 다 뚫려도 여기서 막힌다.** 부분 유니크 인덱스가 마지막 방어선이다"""
    from sqlalchemy.exc import IntegrityError

    _, org_id = await setup_org_with_card(client, db, unique_email)
    cycle = datetime.now(UTC).date()

    await db.execute(
        text(
            "INSERT INTO payment_orders (order_id, org_id, amount, purpose, cycle_start, status) "
            "VALUES (:n, :o, 4400, 'subscription', :c, 'approved')"
        ),
        {"n": f"o1-{org_id}", "o": org_id, "c": cycle},
    )
    await db.commit()

    with pytest.raises(IntegrityError):
        await db.execute(
            text(
                "INSERT INTO payment_orders "
                "(order_id, org_id, amount, purpose, cycle_start, status) "
                "VALUES (:n, :o, 4400, 'subscription', :c, 'approved')"
            ),
            {"n": f"o2-{org_id}", "o": org_id, "c": cycle},
        )
    await db.rollback()


async def test_failed_attempts_may_repeat_in_the_same_cycle(client, unique_email, db):
    """실패한 시도는 여러 번 있을 수 있다 — 그래서 유니크 조건이 `approved` 다"""
    _, org_id = await setup_org_with_card(client, db, unique_email)
    cycle = datetime.now(UTC).date()
    for name in ("f1", "f2", "f3"):
        await db.execute(
            text(
                "INSERT INTO payment_orders "
                "(order_id, org_id, amount, purpose, cycle_start, status) "
                "VALUES (:n, :o, 4400, 'subscription', :c, 'failed')"
            ),
            {"n": f"{name}-{org_id}", "o": org_id, "c": cycle},
        )
    await db.commit()  # 안 터져야 한다


# --- 스케줄러 ----------------------------------------------------------------


async def test_scheduler_charges_due_subscriptions(client, unique_email, db, settings):
    from app.scheduler import main as sched

    _, org_id = await setup_org_with_card(client, db, unique_email)
    await _sub(
        db,
        org_id,
        status="active",
        current_period_end=datetime.now(UTC) - timedelta(minutes=1),
        next_charge_at=datetime.now(UTC) - timedelta(minutes=1),
    )

    with toss.use_transport(_charge_ok("pk_sched")):
        await sched.charge_due_subscriptions()

    row = (
        await db.execute(
            text("SELECT count(*) FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert row == 1


async def test_scheduler_skips_subscriptions_that_are_not_due(
    client, unique_email, db, settings
):
    from app.scheduler import main as sched

    _, org_id = await setup_org_with_card(client, db, unique_email)
    await _sub(
        db,
        org_id,
        status="active",
        next_charge_at=datetime.now(UTC) + timedelta(days=10),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("아직 갱신일이 아닌데 긁었다")

    with toss.use_transport(httpx.MockTransport(handler)):
        await sched.charge_due_subscriptions()
