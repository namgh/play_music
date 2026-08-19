"""결제사 어댑터 — Stripe.

**결제사를 바꾸는 일은 실제로 일어난다** (수수료, 지원 국가, 심사 거절). 그때
도메인 코드까지 흔들리지 않도록 경계를 여기 하나로 둔다. 라우터는 "체크아웃 URL 을
받는다"까지만 알고, 그 URL 이 어떻게 만들어지는지는 모른다.

**우리 화면에서 카드 정보를 받지 않는다.** 받는 순간 PCI-DSS 범위가 통째로
넘어온다 — 결제사가 호스팅하는 페이지로 보내고 우리는 결과만 웹훅으로 받는다.

`org_id` 를 `client_reference_id` 와 메타데이터에 **반드시** 실어 보낸다.
웹훅이 돌아왔을 때 "어느 워크스페이스의 결제인가"를 이메일로 추측하면, 팀 결제에서
결제한 사람의 개인 워크스페이스에 붙는 사고가 난다.
"""

from __future__ import annotations

import logging
import uuid

import httpx

from resona.config import Settings
from resona.core.errors import AppError
from resona.db.models import Plan

log = logging.getLogger(__name__)

API_BASE = "https://api.stripe.com/v1"
TIMEOUT_SEC = 15.0


class PaymentsUnavailable(AppError):
    status_code = 503
    code = "payments_unavailable"


def _secret(settings: Settings) -> str:
    key = settings.stripe_secret_key.get_secret_value()
    if not key:
        # 로컬에서 결제 없이 나머지를 개발할 수 있어야 한다. 운영에서는
        # 부팅 검증이 막는다 (`config.Settings`)
        raise PaymentsUnavailable("결제가 설정되지 않았습니다")
    return key


async def _post(settings: Settings, path: str, data: dict[str, str]) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
        res = await client.post(
            f"{API_BASE}{path}",
            data=data,
            auth=(_secret(settings), ""),
        )
    if res.status_code >= 400:
        # **결제사 오류 본문을 그대로 내보내지 않는다.** 로그에만 남긴다
        log.error(
            "stripe_error",
            extra={"path": path, "status": res.status_code, "body": res.text[:500]},
        )
        raise PaymentsUnavailable("결제를 시작할 수 없습니다. 잠시 후 다시 시도해 주세요")
    return res.json()


async def create_checkout_session(
    settings: Settings,
    *,
    org_id: uuid.UUID,
    org_name: str,
    plan: Plan,
    customer_email: str,
    return_url: str,
) -> str:
    """결제사 호스팅 체크아웃 페이지 URL 을 만든다"""
    price_id = (plan.limits or {}).get("_price_id") if isinstance(plan.limits, dict) else None
    price_id = plan.external_price_id or price_id
    if not price_id:
        raise PaymentsUnavailable(f"'{plan.code}' 플랜에 결제사 가격 ID 가 없습니다")

    payload = {
        "mode": "subscription",
        "line_items[0][price]": str(price_id),
        "line_items[0][quantity]": "1",
        "success_url": f"{return_url}?checkout=success",
        "cancel_url": f"{return_url}?checkout=canceled",
        "customer_email": customer_email,
        # **여기가 핵심이다.** 웹훅이 돌아왔을 때 어느 워크스페이스인지 알아야 한다.
        # 이메일로 추측하면 팀 결제가 결제한 사람의 개인 워크스페이스에 붙는다
        "client_reference_id": str(org_id),
        "metadata[org_id]": str(org_id),
        "metadata[org_name]": org_name,
        "metadata[plan_code]": plan.code,
        "subscription_data[metadata][org_id]": str(org_id),
        "subscription_data[metadata][plan_code]": plan.code,
    }
    session = await _post(settings, "/checkout/sessions", payload)
    return str(session["url"])


async def create_portal_session(
    settings: Settings, *, external_ref: str, return_url: str
) -> str:
    """결제수단 변경·영수증·해지를 결제사 화면에 맡긴다"""
    session = await _post(
        settings,
        "/billing_portal/sessions",
        {"customer": external_ref, "return_url": return_url},
    )
    return str(session["url"])
