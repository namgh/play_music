"""카드 등록(빌링키) 흐름 — `POST /billing/toss/prepare` → `issue`.

**카드번호가 우리 서버에 오는 구간이 없다.** 토스 SDK 가 브라우저에서 직접 받고,
우리는 `authKey` → `billingKey` 교환만 한다. 그래서 PCI-DSS 범위 밖에 남는다.

여기서 지키는 선 셋:
  1. `customer_key` 는 추측 불가능하고 **내부 식별자가 아니다**
  2. 남의 `customer_key` 로 내 조직에 카드를 붙일 수 없다
  3. 빌링키는 **DB 에 평문으로 안 들어간다**
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import text

from app.core import crypto
from app.services import toss
from tests.test_projects import auth, signup

BILLING_KEY = "bk_super_secret_value"


def _issue_ok(billing_key: str = BILLING_KEY, last4: str = "1234"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "billingKey": billing_key,
                "customerKey": "whatever",
                "card": {"number": f"12345678****{last4}", "issuerCode": "신한"},
            },
        )

    return httpx.MockTransport(handler)


async def _prepare(client, token) -> dict:
    res = await client.post("/v1/billing/toss/prepare", headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


async def _issue(client, token, customer_key: str, transport=None):
    with toss.use_transport(transport or _issue_ok()):
        return await client.post(
            "/v1/billing/toss/issue",
            json={"auth_key": "ak_from_toss", "customer_key": customer_key},
            headers=auth(token),
        )


async def test_prepare_gives_an_unguessable_customer_key(client, unique_email, db):
    """**조직 UUID 를 그대로 쓰지 않는다.** 이 값은 결제창 SDK 로 넘어가 브라우저에
    노출된다 — 내부 식별자를 내보내면 "이 조직이 있는가"를 남이 물어볼 수 있다"""
    token = await signup(client, unique_email)
    body = await _prepare(client, token)

    assert body["client_key"], "SDK 초기화에 공개 키가 필요하다"
    key = body["customer_key"]
    assert len(key) >= 20

    org_id = (
        await db.execute(
            text(
                "SELECT o.id FROM organizations o JOIN org_members m ON m.org_id = o.id "
                "JOIN users u ON u.id = m.user_id WHERE u.email = :e"
            ),
            {"e": unique_email},
        )
    ).scalar_one()
    assert key != str(org_id)
    assert str(org_id) not in key


async def test_prepare_is_stable_across_calls(client, unique_email):
    """조직당 하나다. 부를 때마다 새로 만들면 토스 쪽 고객이 갈라진다"""
    token = await signup(client, unique_email)
    first = await _prepare(client, token)
    second = await _prepare(client, token)
    assert first["customer_key"] == second["customer_key"]


async def test_issue_stores_the_billing_key_encrypted(client, unique_email, db, settings):
    """⚠ **빌링키가 평문으로 DB 에 들어가면 안 된다.** 그것만 있으면 그 카드에
    청구가 된다 — 백업 한 번 새면 끝이다"""
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)

    res = await _issue(client, token, prepared["customer_key"])
    assert res.status_code == 200, res.text
    assert res.json()["last4"] == "1234"

    row = (
        await db.execute(
            text(
                "SELECT k.billing_key_enc FROM billing_keys k "
                "JOIN billing_customers c ON c.org_id = k.org_id "
                "WHERE c.customer_key = :ck AND k.status = 'active'"
            ),
            {"ck": prepared["customer_key"]},
        )
    ).scalar_one()

    assert BILLING_KEY.encode() not in bytes(row), "평문이 그대로 들어 있다"
    assert crypto.decrypt(settings, bytes(row)) == BILLING_KEY, "우리는 읽을 수 있어야 한다"


async def test_cannot_attach_a_card_using_someone_elses_customer_key(
    client, unique_email, db
):
    """**남의 `customer_key` 를 보내 그 조직에 카드를 붙이려는 시도를 막는다.**

    그대로 믿고 토스에 넘기면, 공격자가 자기 카드 등록 흐름으로 남의 워크스페이스에
    결제 수단을 심을 수 있다.
    """
    victim = await signup(client, unique_email)
    victim_key = (await _prepare(client, victim))["customer_key"]

    attacker = await signup(client, f"attacker-{unique_email}")
    await _prepare(client, attacker)

    res = await _issue(client, attacker, victim_key)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "customer_not_found"

    # 시도가 감사에 남아야 한다 — 이런 건 한 번이 아니라 반복해서 온다
    hits = (
        await db.execute(
            text("SELECT count(*) FROM audit_log WHERE action = 'billing.issue_customer_mismatch'")
        )
    ).scalar_one()
    assert hits >= 1


async def test_reissuing_revokes_the_previous_card(client, unique_email, db):
    """**조직당 살아 있는 카드는 하나다.** 둘이면 "어느 카드로 긁나"가 애매해지고,
    그 애매함은 엉뚱한 카드에 청구하는 사고가 된다"""
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)

    assert (await _issue(client, token, prepared["customer_key"])).status_code == 200
    second = await _issue(
        client, token, prepared["customer_key"], transport=_issue_ok("bk_second", "9999")
    )
    assert second.status_code == 200
    assert second.json()["last4"] == "9999"

    rows = (
        await db.execute(
            text(
                "SELECT k.status FROM billing_keys k "
                "JOIN billing_customers c ON c.org_id = k.org_id "
                "WHERE c.customer_key = :ck ORDER BY k.created_at"
            ),
            {"ck": prepared["customer_key"]},
        )
    ).scalars().all()
    assert sorted(rows) == ["active", "revoked"], "이력은 남기되 살아 있는 건 하나여야 한다"


async def test_card_endpoint_shows_the_masked_card(client, unique_email):
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)
    assert (await client.get("/v1/billing/toss/card", headers=auth(token))).json() is None

    await _issue(client, token, prepared["customer_key"])
    card = (await client.get("/v1/billing/toss/card", headers=auth(token))).json()
    assert card["last4"] == "1234"
    assert card["brand"] == "신한"


async def test_removing_the_card_leaves_no_active_key(client, unique_email):
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)
    await _issue(client, token, prepared["customer_key"])

    assert (
        await client.delete("/v1/billing/toss/card", headers=auth(token))
    ).status_code == 204
    assert (await client.get("/v1/billing/toss/card", headers=auth(token))).json() is None


async def test_a_provider_rejection_does_not_store_a_card(client, unique_email, db):
    """토스가 거절하면 아무것도 남지 않아야 한다 — 반쯤 등록된 상태가 제일 나쁘다"""
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "INVALID_AUTH_KEY", "message": "x"})

    res = await _issue(
        client, token, prepared["customer_key"], transport=httpx.MockTransport(handler)
    )
    assert res.status_code == 402

    count = (
        await db.execute(
            text(
                "SELECT count(*) FROM billing_keys k JOIN billing_customers c "
                "ON c.org_id = k.org_id WHERE c.customer_key = :ck"
            ),
            {"ck": prepared["customer_key"]},
        )
    ).scalar_one()
    assert count == 0


async def test_a_timeout_does_not_store_a_card(client, unique_email, db):
    """결과를 모를 때도 카드를 심어두면 안 된다 — 다음 결제가 유령 키로 나간다"""
    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timeout", request=request)

    res = await _issue(
        client, token, prepared["customer_key"], transport=httpx.MockTransport(handler)
    )
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "payment_result_unknown"


async def test_only_owners_can_manage_billing(client, unique_email, db):
    """**편집자가 팀 카드를 바꿀 수 있으면 그건 권한 설계가 아니라 사고다**"""
    owner = await signup(client, unique_email)
    org = (
        await client.post("/v1/orgs", json={"name": "밴드"}, headers=auth(owner))
    ).json()

    member_email = f"member-{unique_email}"
    member = await signup(client, member_email)
    member_id = (
        await db.execute(text("SELECT id FROM users WHERE email = :e"), {"e": member_email})
    ).scalar_one()
    await db.execute(
        text("INSERT INTO org_members (org_id, user_id, role) VALUES (:o, :u, 'editor')"),
        {"o": org["id"], "u": member_id},
    )
    await db.commit()

    res = await client.post(
        f"/v1/billing/toss/prepare?org_id={org['id']}", headers=auth(member)
    )
    assert res.status_code == 403, res.text


async def test_payments_are_unavailable_without_configuration(
    client, unique_email, settings, monkeypatch
):
    """로컬에서 **결제 없이 나머지를 개발할 수 있어야 한다** — 500 이 아니라 503"""
    token = await signup(client, unique_email)
    monkeypatch.setattr(settings, "toss_client_key", "")
    res = await client.post("/v1/billing/toss/prepare", headers=auth(token))
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "payments_unavailable"
    assert pytest is not None


# --- 운영자 조회 -------------------------------------------------------------


async def test_support_sees_billing_but_never_the_songs(client, unique_email, db):
    """문의 대응에 필요한 건 "얼마가 언제 왜 청구됐나"지 사용자의 곡이 아니다.

    운영자가 작업물을 직접 읽는 길은 **대리 접속뿐**이고 거기엔 동의·시간제한·
    배너·감사가 붙는다 (`SERVER_ACCOUNTS.md` 4절).
    """
    from sqlalchemy import text as _text

    from tests.test_admin import _make

    user_token = await signup(client, unique_email)
    prepared = await _prepare(client, user_token)
    await _issue(client, user_token, prepared["customer_key"])
    org_id = (
        await db.execute(
            _text("SELECT org_id FROM billing_customers WHERE customer_key = :ck"),
            {"ck": prepared["customer_key"]},
        )
    ).scalar_one()

    admin = await _make(client, db, f"support-{unique_email}", "support")
    res = await client.get(f"/v1/admin/orgs/{org_id}/billing", headers=auth(admin))
    assert res.status_code == 200, res.text

    body = res.json()
    assert body["card_last4"] == "1234"
    assert body["plan_code"] == "free"
    # **빌링키가 응답 어디에도 없어야 한다**
    assert BILLING_KEY not in res.text
    assert "billing_key" not in res.text


async def test_ordinary_users_cannot_read_admin_billing(client, unique_email, db):
    from sqlalchemy import text as _text

    token = await signup(client, unique_email)
    prepared = await _prepare(client, token)
    org_id = (
        await db.execute(
            _text("SELECT org_id FROM billing_customers WHERE customer_key = :ck"),
            {"ck": prepared["customer_key"]},
        )
    ).scalar_one()
    res = await client.get(f"/v1/admin/orgs/{org_id}/billing", headers=auth(token))
    assert res.status_code == 403
