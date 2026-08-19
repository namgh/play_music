"""결제사 어댑터 — 토스페이먼츠 (`SERVER_PAYMENTS.md`).

**토스는 Stripe 와 구조가 다르다.** Stripe 는 구독 객체를 만들면 자기가 매달
청구하지만, 토스가 주는 건 빌링키뿐이고 **매달 긁는 건 우리 일이다.** 그래서 이
모듈은 "결제를 실행하는 도구"까지 제공하고, 언제 실행할지는 스케줄러가 정한다.

**우리 화면에서 카드번호를 받지 않는다.** 받는 순간 PCI-DSS 범위가 통째로 넘어온다 —
토스 SDK 가 브라우저에서 직접 받고, 우리는 `authKey`/`billingKey` 만 다룬다.

---

## 이 모듈에서 가장 중요한 것: 실패를 두 종류로 나눈다

    TossRejected   토스가 **명확히 거절**했다 (카드 한도초과, 잘못된 요청)
                   → 결과를 안다. 상태를 실패로 확정해도 된다

    TossUncertain  타임아웃·연결 끊김·5xx — **결과를 모른다**
                   → **절대 재시도하지 않는다.** 조회 API 로 진실을 확인한다

승인 요청이 타임아웃 났을 때 "실패했나 보다" 하고 다시 보내면 **두 번 청구된다.**
돈에서 이건 되돌리기가 가장 비싼 사고라, 타입으로 갈라 두어 호출하는 쪽이 실수로
뭉뚱그릴 수 없게 한다.
"""

from __future__ import annotations

import base64
import contextlib
import logging
from collections.abc import Iterator
from typing import Any

import httpx

from resona.core.config import Settings
from resona.core.errors import AppError

log = logging.getLogger(__name__)

API_BASE = "https://api.tosspayments.com"
TIMEOUT_SEC = 20.0

#: 테스트가 실제 네트워크로 나가지 않게 갈아 끼우는 자리.
#: 운영 코드에서는 절대 건드리지 않는다
_TRANSPORT: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None


@contextlib.contextmanager
def use_transport(transport: httpx.AsyncBaseTransport) -> Iterator[None]:
    """테스트 전용 — 토스 대신 가짜 응답을 물린다"""
    global _TRANSPORT
    before = _TRANSPORT
    _TRANSPORT = transport
    try:
        yield
    finally:
        _TRANSPORT = before


class TossUnavailable(AppError):
    """설정이 없어 부를 수 없다. 로컬에서 결제 없이 나머지를 개발할 수 있어야 한다"""

    status_code = 503
    code = "payments_unavailable"


class TossRejected(AppError):
    """토스가 **명확히 거절**했다. 결과를 알고 있으므로 실패로 확정해도 된다"""

    status_code = 402
    code = "payment_rejected"

    def __init__(self, message: str, *, toss_code: str = "", **kw: Any) -> None:
        super().__init__(message, **kw)
        self.toss_code = toss_code


class TossUncertain(AppError):
    """**결과를 모른다.** 재시도하지 말고 조회로 확인해야 한다.

    타임아웃·연결 실패·5xx 가 여기로 온다. 요청이 토스에 닿아서 승인까지 됐는데
    응답만 못 받았을 수 있다 — 그 상태에서 다시 보내면 두 번 청구된다.
    """

    status_code = 503
    code = "payment_result_unknown"


def _auth_header(settings: Settings) -> str:
    key = settings.toss_secret_key.get_secret_value()
    if not key:
        raise TossUnavailable("결제가 설정되지 않았습니다")
    # 토스는 시크릿 키 뒤에 콜론을 붙인 Basic 인증을 쓴다 (비밀번호가 빈 문자열)
    return "Basic " + base64.b64encode(f"{key}:".encode()).decode()


async def _request(
    settings: Settings,
    method: str,
    path: str,
    *,
    json: dict | None = None,
    idempotency_key: str | None = None,
) -> dict:
    headers = {"Authorization": _auth_header(settings)}
    if idempotency_key:
        # 같은 키로 두 번 와도 토스가 한 번만 처리한다. 우리 쪽 방어(주문번호 유일)와
        # **둘 다** 둔다 — 한쪽이 뚫려도 다른 쪽이 막는 게 돈에서는 맞다
        headers["Idempotency-Key"] = idempotency_key

    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SEC, transport=_TRANSPORT, base_url=API_BASE
        ) as client:
            res = await client.request(method, path, json=json, headers=headers)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        # **여기서 재시도하면 안 된다.** 요청이 닿았는지조차 모른다
        log.error("toss_request_uncertain", extra={"path": path, "error": type(exc).__name__})
        raise TossUncertain(
            "결제 결과를 확인하지 못했습니다. 잠시 후 상태를 확인해 주세요"
        ) from exc

    if res.status_code >= 500:
        # 5xx 도 결과를 모르는 쪽이다 — 토스가 받아서 처리하다 죽었을 수 있다
        log.error("toss_server_error", extra={"path": path, "status": res.status_code})
        raise TossUncertain("결제사 응답이 불안정합니다. 상태를 확인해 주세요")

    if res.status_code >= 400:
        body = _safe_json(res)
        code = str(body.get("code") or "")
        # **결제사 오류 본문을 그대로 사용자에게 내보내지 않는다.** 로그에만 남긴다
        log.warning(
            "toss_rejected",
            extra={"path": path, "status": res.status_code, "toss_code": code},
        )
        raise TossRejected(_user_message(code), toss_code=code, details={"toss_code": code})

    return _safe_json(res)


def _safe_json(res: httpx.Response) -> dict:
    try:
        parsed = res.json()
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


#: 사용자가 **무엇을 하면 되는지** 알 수 있는 말로만 바꾼다. 나머지는 뭉뚱그린다 —
#: 결제사 내부 코드를 그대로 보여주면 문의만 늘고 해결은 안 된다
_MESSAGES = {
    "EXCEED_MAX_CARD_INSTALLMENT_PLAN": "이 카드로는 해당 할부가 불가능합니다",
    "INVALID_CARD_EXPIRATION": "카드 유효기간을 다시 확인해 주세요",
    "INVALID_STOPPED_CARD": "정지된 카드입니다. 다른 카드를 사용해 주세요",
    "EXCEED_MAX_DAILY_PAYMENT_COUNT": "일일 결제 횟수를 초과했습니다. 내일 다시 시도해 주세요",
    "NOT_ENOUGH_BALANCE": "잔액이 부족합니다",
    "EXCEED_MAX_AMOUNT": "결제 한도를 초과했습니다",
    "REJECT_CARD_COMPANY": "카드사에서 거절했습니다. 카드사에 문의해 주세요",
}


def _user_message(code: str) -> str:
    return _MESSAGES.get(code, "결제에 실패했습니다. 카드 상태를 확인해 주세요")


# --- 일반 결제 ---------------------------------------------------------------


async def confirm_payment(
    settings: Settings, *, payment_key: str, order_id: str, amount: int
) -> dict:
    """결제창을 통과한 결제를 **서버가 확정한다.**

    ⚠ `amount` 는 **반드시 서버가 저장해 둔 값**이어야 한다. 클라이언트가 준 값을
    그대로 넘기면 ₩4,400 짜리를 ₩100 에 파는 길이 열린다 (`SERVER_PAYMENTS.md` 2절).
    """
    return await _request(
        settings,
        "POST",
        "/v1/payments/confirm",
        json={"paymentKey": payment_key, "orderId": order_id, "amount": amount},
        idempotency_key=order_id,
    )


async def get_payment(settings: Settings, *, payment_key: str) -> dict:
    """**유일한 진실.** 웹훅 본문이 아니라 이걸 믿는다"""
    return await _request(settings, "GET", f"/v1/payments/{payment_key}")


async def get_payment_by_order_id(settings: Settings, *, order_id: str) -> dict:
    """승인이 타임아웃 났을 때 **결과를 확인하는 길.**

    `paymentKey` 를 못 받았어도 주문번호는 우리가 만든 것이라 항상 알고 있다.
    이게 있어서 "재시도하지 않고 조회한다"가 성립한다.
    """
    return await _request(settings, "GET", f"/v1/payments/orders/{order_id}")


async def cancel_payment(
    settings: Settings,
    *,
    payment_key: str,
    reason: str,
    amount: int | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """전액 또는 부분 취소. `amount` 가 없으면 전액이다"""
    body: dict[str, Any] = {"cancelReason": reason}
    if amount is not None:
        body["cancelAmount"] = amount
    return await _request(
        settings,
        "POST",
        f"/v1/payments/{payment_key}/cancel",
        json=body,
        idempotency_key=idempotency_key,
    )


# --- 자동결제(빌링) ----------------------------------------------------------


async def issue_billing_key(settings: Settings, *, auth_key: str, customer_key: str) -> dict:
    """카드 등록창에서 받은 `authKey` 를 **빌링키로 교환한다.**

    돌려받는 `billingKey` 는 카드번호가 아니지만 **결제를 일으킬 수 있는
    자격증명**이라, 저장 전에 반드시 암호화한다 (`app/core/crypto.py`).
    """
    return await _request(
        settings,
        "POST",
        "/v1/billing/authorizations/issue",
        json={"authKey": auth_key, "customerKey": customer_key},
    )


async def charge_with_billing_key(
    settings: Settings,
    *,
    billing_key: str,
    customer_key: str,
    amount: int,
    order_id: str,
    order_name: str,
) -> dict:
    """등록된 카드로 **우리가 결제를 일으킨다.** 매달 스케줄러가 부른다.

    `order_id` 를 멱등키로 쓴다 — 스케줄러가 두 번 돌아도 한 주기에 한 번만 긁힌다.
    """
    return await _request(
        settings,
        "POST",
        f"/v1/billing/{billing_key}",
        json={
            "customerKey": customer_key,
            "amount": amount,
            "orderId": order_id,
            "orderName": order_name,
        },
        idempotency_key=order_id,
    )
