"""토스 어댑터 — **실패를 두 종류로 가르는 것**이 전부다.

    TossRejected   토스가 명확히 거절했다 → 실패로 확정해도 된다
    TossUncertain  결과를 모른다 → **재시도 금지.** 조회로 확인한다

승인 요청이 타임아웃 났을 때 "실패했나 보다" 하고 다시 보내면 **두 번 청구된다.**
돈에서 가장 되돌리기 비싼 사고라, 여기가 무너지면 나머지가 다 맞아도 소용없다.

토스 키가 아직 없어서 실제 호출은 못 하지만, **경계의 계약은 전부 여기서 고정한다** —
나중에 진짜 키를 넣었을 때 달라지는 건 응답 내용이지 이 규칙이 아니다.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from app.services import toss


def _transport(handler):
    return httpx.MockTransport(handler)


def _ok(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload)


async def test_confirm_sends_amount_and_idempotency_key(settings):
    """**멱등키를 반드시 싣는다.** 우리 쪽 주문번호 유일 제약과 이중으로 막는다"""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["idempotency"] = request.headers.get("Idempotency-Key")
        seen["auth"] = request.headers.get("Authorization")
        return _ok({"paymentKey": "pk_1", "status": "DONE", "totalAmount": 4400})

    with toss.use_transport(_transport(handler)):
        out = await toss.confirm_payment(
            settings, payment_key="pk_1", order_id="sub-abc", amount=4400
        )

    assert out["status"] == "DONE"
    assert seen["url"].endswith("/v1/payments/confirm")
    assert seen["body"] == {"paymentKey": "pk_1", "orderId": "sub-abc", "amount": 4400}
    assert seen["idempotency"] == "sub-abc", "주문번호가 멱등키여야 한다"


async def test_secret_key_is_sent_as_basic_auth_with_trailing_colon(settings):
    """토스는 시크릿 키 뒤에 콜론을 붙인 Basic 인증을 쓴다 (비밀번호가 빈 문자열)"""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        return _ok({})

    with toss.use_transport(_transport(handler)):
        await toss.get_payment(settings, payment_key="pk_1")

    scheme, _, encoded = seen["auth"].partition(" ")
    assert scheme == "Basic"
    decoded = base64.b64decode(encoded).decode()
    assert decoded.endswith(":"), "키 뒤에 콜론이 붙어야 한다"
    assert decoded[:-1] == settings.toss_secret_key.get_secret_value()


async def test_timeout_is_uncertain_never_rejected(settings):
    """⚠ **가장 중요한 테스트.**

    타임아웃은 "실패"가 아니다. 요청이 토스에 닿아 승인까지 됐는데 응답만 못
    받았을 수 있다. 이걸 실패로 확정하고 재시도하면 두 번 청구된다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with toss.use_transport(_transport(handler)), pytest.raises(toss.TossUncertain):
        await toss.charge_with_billing_key(
            settings,
            billing_key="bk_1",
            customer_key="ck_1",
            amount=4400,
            order_id="sub-1",
            order_name="구독",
        )


async def test_connection_error_is_uncertain(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with toss.use_transport(_transport(handler)), pytest.raises(toss.TossUncertain):
        await toss.confirm_payment(settings, payment_key="p", order_id="o", amount=1)


async def test_server_error_is_uncertain_not_rejected(settings):
    """5xx 도 결과를 모르는 쪽이다 — 토스가 받아서 처리하다 죽었을 수 있다"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"code": "INTERNAL", "message": "..."})

    with toss.use_transport(_transport(handler)), pytest.raises(toss.TossUncertain):
        await toss.confirm_payment(settings, payment_key="p", order_id="o", amount=1)


async def test_client_error_is_a_definite_rejection(settings):
    """4xx 는 결과를 안다 — 실패로 확정해도 안전하다"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"code": "NOT_ENOUGH_BALANCE", "message": "잔액 부족"}
        )

    with toss.use_transport(_transport(handler)), pytest.raises(toss.TossRejected) as exc:
        await toss.confirm_payment(settings, payment_key="p", order_id="o", amount=1)

    assert exc.value.toss_code == "NOT_ENOUGH_BALANCE"
    assert "잔액" in str(exc.value)


async def test_unknown_error_codes_do_not_leak_the_providers_message(settings):
    """**결제사 본문을 그대로 사용자에게 내보내지 않는다.**

    내부 코드·시스템 정보가 섞여 나오고, 사용자는 그걸 읽어도 뭘 해야 할지 모른다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": "SOME_INTERNAL_CODE",
                "message": "내부 시스템 오류: db-node-7 커넥션 풀 고갈",
            },
        )

    with toss.use_transport(_transport(handler)), pytest.raises(toss.TossRejected) as exc:
        await toss.confirm_payment(settings, payment_key="p", order_id="o", amount=1)

    assert "db-node-7" not in str(exc.value)
    assert "카드 상태" in str(exc.value)


async def test_missing_secret_key_is_unavailable_not_a_crash(settings, monkeypatch):
    """로컬에서 **결제 없이 나머지를 개발할 수 있어야 한다**"""
    from pydantic import SecretStr

    monkeypatch.setattr(settings, "toss_secret_key", SecretStr(""))
    with pytest.raises(toss.TossUnavailable):
        await toss.get_payment(settings, payment_key="pk")


async def test_billing_key_issue_passes_customer_key(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return _ok({"billingKey": "bk_secret", "card": {"number": "12345678****1234"}})

    with toss.use_transport(_transport(handler)):
        out = await toss.issue_billing_key(settings, auth_key="ak", customer_key="ck")

    assert out["billingKey"] == "bk_secret"
    assert seen["body"] == {"authKey": "ak", "customerKey": "ck"}
    assert seen["url"].endswith("/v1/billing/authorizations/issue")


async def test_charge_uses_order_id_as_idempotency_key(settings):
    """스케줄러가 두 번 돌아도 한 주기에 한 번만 긁혀야 한다"""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["idempotency"] = request.headers.get("Idempotency-Key")
        seen["url"] = str(request.url)
        return _ok({"paymentKey": "pk", "status": "DONE"})

    with toss.use_transport(_transport(handler)):
        await toss.charge_with_billing_key(
            settings,
            billing_key="bk_1",
            customer_key="ck",
            amount=4400,
            order_id="sub-2026-09",
            order_name="구독",
        )

    assert seen["idempotency"] == "sub-2026-09"
    assert seen["url"].endswith("/v1/billing/bk_1")


async def test_lookup_by_order_id_exists_for_reconciliation(settings):
    """타임아웃 뒤 **결과를 확인하는 길**. `paymentKey` 를 못 받았어도 주문번호는
    우리가 만든 것이라 항상 안다 — 이게 있어서 "재시도 대신 조회"가 성립한다"""

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/v1/payments/orders/sub-1")
        return _ok({"paymentKey": "pk", "status": "DONE"})

    with toss.use_transport(_transport(handler)):
        out = await toss.get_payment_by_order_id(settings, order_id="sub-1")
    assert out["status"] == "DONE"
