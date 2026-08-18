"""구독 API·웹훅·환불, 그리고 **가입부터 해지까지 한 번에 흐르는지**.

여기가 Day 7 의 통합 시험이다. 단위로 다 맞아도 이어 붙였을 때 어긋나는 곳이
반드시 있고, 결제에서는 그게 곧 돈이다.
"""

from __future__ import annotations

import json

import httpx
from sqlalchemy import text

from app.services import entitlements, toss
from tests.test_billing_run import _charge_ok, _charge_rejected, setup_org_with_card
from tests.test_projects import DOC, auth, signup


def _cancel_ok(status: str = "CANCELED"):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        return httpx.Response(
            200, json={"status": status, "cancelAmount": body.get("cancelAmount")}
        )

    return httpx.MockTransport(handler)


async def _subscribe(client, token, plan="pro", transport=None):
    with toss.use_transport(transport or _charge_ok()):
        return await client.post(
            "/v1/billing/toss/subscribe", json={"plan_code": plan}, headers=auth(token)
        )


# --- 구독 시작 ---------------------------------------------------------------


async def test_subscribing_without_a_card_is_refused(client, unique_email):
    """카드 없이 구독 상태만 만들면 **다음 달에야 문제를 안다**"""
    token = await signup(client, unique_email)
    res = await _subscribe(client, token)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "no_billing_key"


async def test_subscribe_charges_immediately(client, unique_email, db):
    token, org_id = await setup_org_with_card(client, db, unique_email)
    res = await _subscribe(client, token)
    assert res.status_code == 200, res.text

    body = res.json()
    assert body["status"] == "active"
    assert body["plan_code"] == "pro"
    assert body["commercial_license"] is True
    assert body["current_period_end"] is not None

    paid = (
        await db.execute(
            text("SELECT amount FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert paid == 4400


async def test_a_failed_first_charge_does_not_leave_a_phantom_past_due(
    client, unique_email, db
):
    """**결제된 적이 없는데 "밀린 요금"이 있는 상태가 되면 안 된다.**

    그 상태에서는 재시도 스케줄이 돌고, 사용자는 구독한 적 없는 요금을 독촉받는다.
    """
    token, org_id = await setup_org_with_card(client, db, unique_email)
    res = await _subscribe(client, token, transport=_charge_rejected())
    assert res.status_code == 402

    row = (
        await db.execute(
            text("SELECT status, next_charge_at FROM subscriptions WHERE org_id = :o"),
            {"o": org_id},
        )
    ).first()
    assert row.status == "canceled"
    assert row.next_charge_at is None


async def test_subscribing_twice_is_refused(client, unique_email, db):
    token, _ = await setup_org_with_card(client, db, unique_email)
    assert (await _subscribe(client, token)).status_code == 200
    again = await _subscribe(client, token)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "already_subscribed"


async def test_subscription_unlocks_unlimited_songs(client, unique_email, db):
    """구독이 실제로 **한도를 푸는지** — 결제만 되고 권한이 안 열리면 최악이다"""
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)

    for i in range(7):
        res = await client.post(
            "/v1/projects", json={"name": f"곡 {i}", "document": DOC}, headers=auth(token)
        )
        assert res.status_code == 201, f"{i}번째에서 막혔다: {res.text}"


# --- 해지·재개 ---------------------------------------------------------------


async def test_cancel_keeps_the_paid_period(client, unique_email, db):
    """**이미 낸 달은 끝까지 쓴다.** 즉시 끊으면 환불 요구가 따라오고 사용자가 손해다"""
    token, org_id = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)

    res = await client.post("/v1/billing/toss/cancel", headers=auth(token))
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "canceling"
    assert body["next_charge_at"] is None, "다음 달부터는 안 긁는다"
    assert body["current_period_end"] is not None, "이번 달은 남아 있다"

    # 아직 유료다 — 곡을 계속 만들 수 있다
    assert (
        await client.post(
            "/v1/projects", json={"name": "해지 예약 중", "document": DOC}, headers=auth(token)
        )
    ).status_code == 201


async def test_resume_undoes_a_cancellation(client, unique_email, db):
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)
    await client.post("/v1/billing/toss/cancel", headers=auth(token))

    res = await client.post("/v1/billing/toss/resume", headers=auth(token))
    assert res.status_code == 200
    assert res.json()["status"] == "active"
    assert res.json()["next_charge_at"] is not None


async def test_the_period_actually_ends_when_it_expires(client, unique_email, db):
    """해지 예약이 만료에 도달하면 스케줄러가 끝낸다"""
    from app.scheduler import main as sched

    token, org_id = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)
    await client.post("/v1/billing/toss/cancel", headers=auth(token))

    await db.execute(
        text("UPDATE subscriptions SET current_period_end = now() - interval '1 hour' "
             "WHERE org_id = :o"),
        {"o": org_id},
    )
    await db.commit()

    await sched.expire_canceling_subscriptions()
    await entitlements.invalidate(org_id)

    status = (
        await db.execute(
            text("SELECT status FROM subscriptions WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert status == "canceled"


# --- 웹훅 -------------------------------------------------------------------


async def test_a_forged_webhook_cannot_make_anyone_paid(client, unique_email, db):
    """⚠ **이 URL 은 공개 주소다.**

    본문을 그대로 반영하면 위조 요청 하나로 남의 조직을 유료로 만들 수 있다.
    우리는 주문번호를 우리 DB 에서 찾고, 없으면 아무것도 하지 않는다.
    """
    res = await client.post(
        "/v1/billing/toss/webhook",
        json={
            "eventType": "PAYMENT_STATUS_CHANGED",
            "data": {"orderId": "sub-완전히-지어낸-것", "status": "DONE"},
        },
    )
    assert res.status_code == 200, "토스가 재전송하지 않게 200 을 준다"

    count = (
        await db.execute(
            text("SELECT count(*) FROM payments WHERE payment_key LIKE 'pk-sub-완전%'")
        )
    ).scalar_one()
    assert count == 0


async def test_a_webhook_claiming_success_is_verified_against_the_provider(
    client, unique_email, db
):
    """⚠ **웹훅 본문을 믿지 않는다.**

    "결제 성공했다"는 본문이 와도, 조회 API 가 아니라고 하면 아무 일도 안 일어난다.
    서명 검증이 뚫려도 돈이 안 움직이는 이유가 이것이다.
    """
    _, org_id = await setup_org_with_card(client, db, unique_email)
    order_id = f"sub-webhook-{org_id}"
    await db.execute(
        text(
            "INSERT INTO payment_orders (order_id, org_id, amount, purpose, plan_code, "
            "  cycle_start, status) VALUES (:oid, :o, 4400, 'subscription', 'pro', "
            "  current_date, 'pending')"
        ),
        {"oid": order_id, "o": org_id},
    )
    await db.execute(
        text("UPDATE subscriptions SET plan_code = 'pro' WHERE org_id = :o"), {"o": org_id}
    )
    await db.commit()

    def says_no(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": "NOT_FOUND_PAYMENT", "message": "x"})

    with toss.use_transport(httpx.MockTransport(says_no)):
        res = await client.post(
            "/v1/billing/toss/webhook",
            json={
                "eventType": "PAYMENT_STATUS_CHANGED",
                "data": {"orderId": order_id, "status": "DONE"},
            },
        )
    assert res.status_code == 200

    status = (
        await db.execute(
            text("SELECT status FROM payment_orders WHERE order_id = :oid"), {"oid": order_id}
        )
    ).scalar_one()
    assert status == "failed", "본문이 성공이라 해도 조회가 아니라면 성공이 아니다"

    paid = (
        await db.execute(
            text("SELECT count(*) FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert paid == 0, "위조된 성공 통보로 결제 기록이 생기면 안 된다"


async def test_the_same_webhook_twice_changes_nothing_extra(client, unique_email, db):
    """웹훅은 **중복이 기본**이다 (`SERVER_BILLING.md` 5절)"""
    token, org_id = await setup_org_with_card(client, db, unique_email)
    order_id = f"sub-dup-{org_id}"
    await db.execute(
        text(
            "INSERT INTO payment_orders (order_id, org_id, amount, purpose, plan_code, "
            "  cycle_start, status) VALUES (:oid, :o, 4400, 'subscription', 'pro', "
            "  current_date, 'pending')"
        ),
        {"oid": order_id, "o": org_id},
    )
    await db.execute(
        text("UPDATE subscriptions SET plan_code = 'pro' WHERE org_id = :o"), {"o": org_id}
    )
    await db.commit()

    body = {
        "eventType": "PAYMENT_STATUS_CHANGED",
        "data": {"orderId": order_id, "status": "DONE"},
    }
    with toss.use_transport(_charge_ok()):
        assert (await client.post("/v1/billing/toss/webhook", json=body)).status_code == 200
        assert (await client.post("/v1/billing/toss/webhook", json=body)).status_code == 200

    payments = (
        await db.execute(
            text("SELECT count(*) FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert payments == 1, "같은 이벤트가 두 번 와도 결제는 하나여야 한다"


async def test_garbage_webhook_bodies_do_not_crash(client):
    assert (
        await client.post(
            "/v1/billing/toss/webhook",
            content=b"not json",
            headers={"content-type": "application/json"},
        )
    ).status_code == 200


# --- 영수증·환불 -------------------------------------------------------------


async def test_payments_are_listed_for_the_user(client, unique_email, db):
    """**사용자가 스스로 확인할 수 있어야 한다** — 문의가 반으로 준다"""
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)

    rows = (await client.get("/v1/billing/toss/payments", headers=auth(token))).json()
    assert len(rows) == 1
    assert rows[0]["amount"] == 4400
    assert rows[0]["receipt_url"]


async def test_partial_then_full_refund(client, unique_email, db):
    """부분 환불이 되어야 운영이 "다 돌려주거나 안 주거나"가 되지 않는다"""
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)
    payment = (await client.get("/v1/billing/toss/payments", headers=auth(token))).json()[0]

    with toss.use_transport(_cancel_ok("PARTIAL_CANCELED")):
        first = await client.post(
            f"/v1/billing/toss/payments/{payment['id']}/refund",
            json={"reason": "일부 환불", "amount": 1400},
            headers=auth(token),
        )
    assert first.status_code == 200
    assert first.json()["refunded_amount"] == 1400

    with toss.use_transport(_cancel_ok("CANCELED")):
        second = await client.post(
            f"/v1/billing/toss/payments/{payment['id']}/refund",
            json={"reason": "나머지"},
            headers=auth(token),
        )
    assert second.json()["refunded_amount"] == 4400

    with toss.use_transport(_cancel_ok()):
        third = await client.post(
            f"/v1/billing/toss/payments/{payment['id']}/refund",
            json={"reason": "또"},
            headers=auth(token),
        )
    assert third.status_code == 409, "이미 전액 환불된 것을 또 환불하면 안 된다"


async def test_refund_cannot_exceed_the_payment(client, unique_email, db):
    """**클라이언트 금액을 그대로 믿으면 결제액보다 많이 돌려주는 길이 열린다**"""
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)
    payment = (await client.get("/v1/billing/toss/payments", headers=auth(token))).json()[0]

    with toss.use_transport(_cancel_ok()):
        res = await client.post(
            f"/v1/billing/toss/payments/{payment['id']}/refund",
            json={"reason": "과다 요청", "amount": 999_999},
            headers=auth(token),
        )
    assert res.status_code == 200
    assert res.json()["refunded_amount"] == 4400, "결제액을 넘지 못한다"


async def test_cannot_refund_someone_elses_payment(client, unique_email, db):
    token, _ = await setup_org_with_card(client, db, unique_email)
    await _subscribe(client, token)
    payment = (await client.get("/v1/billing/toss/payments", headers=auth(token))).json()[0]

    other = await signup(client, f"other-{unique_email}")
    with toss.use_transport(_cancel_ok()):
        res = await client.post(
            f"/v1/billing/toss/payments/{payment['id']}/refund",
            json={"reason": "남의 것"},
            headers=auth(other),
        )
    assert res.status_code in (403, 404)


# --- 통합 -------------------------------------------------------------------


async def test_full_lifecycle_signup_to_cancellation(client, unique_email, db):
    """가입 → 한도 → 카드 → 구독 → 갱신 → 실패 → 복구 → 해지.

    **단위로 다 맞아도 이어 붙이면 어긋나는 곳이 있다.**
    """
    from app.scheduler import main as sched

    # ① 무료로 5곡까지
    token, org_id = await setup_org_with_card(client, db, unique_email)
    for i in range(5):
        assert (
            await client.post(
                "/v1/projects", json={"name": f"무료 {i}", "document": DOC}, headers=auth(token)
            )
        ).status_code == 201
    assert (
        await client.post(
            "/v1/projects", json={"name": "여섯째", "document": DOC}, headers=auth(token)
        )
    ).status_code == 402

    # ② 구독하면 풀린다
    assert (await _subscribe(client, token)).status_code == 200
    assert (
        await client.post(
            "/v1/projects", json={"name": "유료", "document": DOC}, headers=auth(token)
        )
    ).status_code == 201

    # ③ 다음 달 갱신.
    #
    # **`next_charge_at` 만 당긴다.** `current_period_end` 까지 오늘로 당기면
    # 청구 주기(`cycle_start`)가 첫 결제와 같은 날이 되어, "한 주기에 승인은
    # 하나" 제약에 걸린다 — 제약이 맞고 시뮬레이션이 틀린 것이다.
    # 실제로는 한 달 뒤에 갱신되므로 주기가 다르다.
    await db.execute(
        text("UPDATE subscriptions SET next_charge_at = now() - interval '1 minute' "
             "WHERE org_id = :o"),
        {"o": org_id},
    )
    await db.commit()
    with toss.use_transport(_charge_ok()):
        await sched.charge_due_subscriptions()

    paid = (
        await db.execute(
            text("SELECT count(*) FROM payments WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert paid == 2, "갱신이 한 번 더 긁혀야 한다"

    # ④ 그 다음 달은 카드가 막힌다 → past_due, 하지만 곡은 그대로
    await db.execute(
        text("UPDATE subscriptions SET next_charge_at = now() - interval '1 minute' "
             "WHERE org_id = :o"),
        {"o": org_id},
    )
    await db.commit()
    with toss.use_transport(_charge_rejected()):
        await sched.charge_due_subscriptions()
    await entitlements.invalidate(org_id)

    status = (
        await db.execute(
            text("SELECT status FROM subscriptions WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert status == "past_due"

    listed = (await client.get("/v1/projects", headers=auth(token))).json()
    assert len(listed["items"]) >= 6, "결제가 밀렸다고 곡이 사라지면 안 된다"

    # ⑤ 해지 — 이미 낸 기간은 남는다
    cancel = await client.post("/v1/billing/toss/cancel", headers=auth(token))
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "canceling"
