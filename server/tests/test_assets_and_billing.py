"""에셋 업로드·내보내기·결제 웹훅.

여기서 지키려는 것 셋:
  1. 파일 바이트가 API 를 통과하지 않는다 (서명 URL만 나간다)
  2. 상업 이용 권리는 **내보낸 시점에 고정**되고 해지해도 안 사라진다
  3. 웹훅은 중복·역순이 와도 상태를 망가뜨리지 않는다
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

from sqlalchemy import select

from app.db.models import Asset, ProjectExport, Subscription
from tests.test_projects import DOC, auth, signup

WAV_SHA = hashlib.sha256(b"fake wav bytes").hexdigest()


async def _project(client, token) -> dict:
    res = await client.post(
        "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _ready_asset(client, token) -> dict:
    created = (
        await client.post(
            "/v1/assets",
            json={
                "kind": "export",
                "content_type": "audio/wav",
                "size_bytes": 4_000_000,
                "sha256": WAV_SHA,
                "filename": "song.wav",
            },
            headers=auth(token),
        )
    ).json()
    await client.post(f"/v1/assets/{created['id']}/complete", headers=auth(token))
    return created


async def test_upload_returns_presigned_url_and_never_takes_bytes(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/assets",
        json={
            "kind": "export",
            "content_type": "audio/wav",
            "size_bytes": 1024,
            "sha256": WAV_SHA,
            "filename": "song.wav",
        },
        headers=auth(token),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["status"] == "pending"

    q = parse_qs(urlparse(body["upload_url"]).query)
    assert q["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert q["X-Amz-Signature"][0]
    assert q["X-Amz-Expires"] == ["900"]
    # 키에 소유자가 들어가야 버킷 정책으로 접두어 격리를 걸 수 있다
    assert body["storage_key"].startswith("export/")


async def test_rejects_unsupported_content_type(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/assets",
        json={
            "kind": "ir",
            "content_type": "application/zip",
            "size_bytes": 1024,
            "sha256": WAV_SHA,
        },
        headers=auth(token),
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "unsupported_content_type"


async def test_complete_is_idempotent(client, unique_email, db):
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/assets",
            json={
                "kind": "export",
                "content_type": "audio/wav",
                "size_bytes": 2048,
                "sha256": WAV_SHA,
            },
            headers=auth(token),
        )
    ).json()

    first = await client.post(f"/v1/assets/{created['id']}/complete", headers=auth(token))
    second = await client.post(f"/v1/assets/{created['id']}/complete", headers=auth(token))
    assert first.status_code == second.status_code == 200
    assert second.json()["status"] == "ready"

    row = (await db.execute(select(Asset).where(Asset.id == created["id"]))).scalar_one()
    assert row.status == "ready"


async def test_export_requires_ready_asset(client, unique_email):
    """올리다 만 파일로 내보내기를 만들면 **재생 안 되는 결과물**이 목록에 뜬다"""
    token = await signup(client, unique_email)
    project = await _project(client, token)
    pending = (
        await client.post(
            "/v1/assets",
            json={
                "kind": "export",
                "content_type": "audio/wav",
                "size_bytes": 2048,
                "sha256": WAV_SHA,
            },
            headers=auth(token),
        )
    ).json()

    res = await client.post(
        "/v1/exports",
        json={
            "project_id": project["id"],
            "version_id": project["head_version_id"],
            "asset_id": pending["id"],
            "format": "wav",
        },
        headers=auth(token),
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "asset_not_ready"


async def test_free_export_is_personal_license(client, unique_email):
    token = await signup(client, unique_email)
    project = await _project(client, token)
    asset = await _ready_asset(client, token)

    res = await client.post(
        "/v1/exports",
        json={
            "project_id": project["id"],
            "version_id": project["head_version_id"],
            "asset_id": asset["id"],
            "format": "wav",
            "sample_rate": 48000,
            "bit_depth": 24,
            "peak_dbfs": -1.2,
        },
        headers=auth(token),
    )
    assert res.status_code == 201, res.text
    assert res.json()["license"] == "personal"


async def test_commercial_license_survives_cancellation(client, unique_email, db):
    """**핵심 규칙.** 해지해도 이미 내보낸 곡의 권리는 살아 있다
    (`SERVER_BILLING.md` 3절) — 취소하면 그건 제품이 아니라 인질이다"""
    token = await signup(client, unique_email)
    project = await _project(client, token)
    asset = await _ready_asset(client, token)

    # 유료로 만든다 (웹훅 경로로)
    await _webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "subscription.created",
            "created": 1_800_000_000,
            "data": {"customer_email": unique_email, "plan_code": "pro", "status": "active"},
        },
    )

    export = (
        await client.post(
            "/v1/exports",
            json={
                "project_id": project["id"],
                "version_id": project["head_version_id"],
                "asset_id": asset["id"],
                "format": "wav",
            },
            headers=auth(token),
        )
    ).json()
    assert export["license"] == "commercial"

    # 해지한다
    await _webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "subscription.canceled",
            "created": 1_800_001_000,
            "data": {"customer_email": unique_email, "plan_code": "free"},
        },
    )

    row = (
        await db.execute(select(ProjectExport).where(ProjectExport.id == export["id"]))
    ).scalar_one()
    assert row.license == "commercial", "이미 내보낸 결과물의 권리를 회수하지 않는다"
    assert row.license_snapshot["plan"] == "pro"

    # 앞으로의 권리는 사라지지만, 이미 나간 결과물은 그대로 내려받힌다
    listed = await client.get(f"/v1/projects/{project['id']}/exports", headers=auth(token))
    assert listed.json()[0]["license"] == "commercial"
    assert listed.json()[0]["download_url"]


async def _subscription(db, email: str):
    """구독은 **개인 워크스페이스**에 붙어 있다 — 과금 단위가 조직이다"""
    from app.db.models import Organization, OrgMember, User

    user = (await db.execute(select(User).where(User.email == email))).scalar_one()
    org = (
        await db.execute(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user.id, Organization.kind == "personal")
        )
    ).scalar_one()
    return (
        await db.execute(select(Subscription).where(Subscription.org_id == org.id))
    ).scalar_one()


async def _webhook(client, event: dict, *, secret: str | None = None):
    raw = json.dumps(event).encode()
    headers = {"content-type": "application/json"}
    if secret is None:
        from app.config import get_settings

        secret = get_settings().billing_webhook_secret.get_secret_value()
    if secret:
        headers["X-Signature"] = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return await client.post("/v1/billing/webhook", content=raw, headers=headers)


async def test_webhook_duplicate_is_accepted_once(client, unique_email, db):
    """중복이 와도 204 를 준다. 5xx 를 주면 결제사가 **영원히 재전송**한다"""
    await signup(client, unique_email)
    event = {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "subscription.created",
        "created": 1_800_000_000,
        "data": {"customer_email": unique_email, "plan_code": "pro", "status": "active"},
    }
    assert (await _webhook(client, event)).status_code == 204
    assert (await _webhook(client, event)).status_code == 204

    sub = await _subscription(db, unique_email)
    assert sub.plan_code == "pro"


async def test_webhook_out_of_order_is_ignored(client, unique_email, db):
    """**늦게 도착한 옛 이벤트가 최신 상태를 덮지 않는다.**
    이걸 안 막으면 해지한 사용자가 유료로 되살아난다"""
    await signup(client, unique_email)
    await _webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "subscription.canceled",
            "created": 1_800_002_000,  # 최신
            "data": {"customer_email": unique_email, "plan_code": "free"},
        },
    )
    await _webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "subscription.created",
            "created": 1_800_000_000,  # 오래된 것 — 늦게 도착
            "data": {"customer_email": unique_email, "plan_code": "pro", "status": "active"},
        },
    )

    sub = await _subscription(db, unique_email)
    assert sub.status == "canceled"
    assert sub.commercial_license is False


async def test_webhook_signature_is_verified(client, unique_email, monkeypatch):
    """설정이 `Settings` 로 모였으므로 캐시를 비워야 반영된다"""
    from app.config import get_settings

    monkeypatch.setenv("BILLING_WEBHOOK_SECRET", "whsec_test")
    get_settings.cache_clear()
    event = {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "subscription.created",
        "created": 1_800_000_000,
        "data": {"customer_email": unique_email},
    }
    # 서명 없이
    bad = await client.post("/v1/billing/webhook", content=json.dumps(event).encode())
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "missing_signature"

    # 틀린 서명
    wrong = await client.post(
        "/v1/billing/webhook",
        content=json.dumps(event).encode(),
        headers={"X-Signature": "0" * 64},
    )
    assert wrong.status_code == 401

    # 맞는 서명
    ok = await _webhook(client, event, secret="whsec_test")
    assert ok.status_code == 204
    get_settings.cache_clear()


async def test_presign_is_deterministic_for_fixed_time(settings):
    """서명이 **재현 가능해야** 테스트할 수 있다 — 그래서 시각을 주입받는다"""
    from app.services import storage

    at = datetime(2026, 8, 11, 12, 0, 0, tzinfo=UTC)
    a = storage.presign(
        settings, method="PUT", key="export/a.wav", expires_sec=900,
        access_key="AK", secret_key="SK", now=at,
    )
    b = storage.presign(
        settings, method="PUT", key="export/a.wav", expires_sec=900,
        access_key="AK", secret_key="SK", now=at,
    )
    assert a == b
    c = storage.presign(
        settings, method="PUT", key="export/b.wav", expires_sec=900,
        access_key="AK", secret_key="SK", now=at,
    )
    assert c != a  # 키가 다르면 서명도 달라야 한다


# --- 삭제와 용량 ------------------------------------------------------------


async def test_delete_asset_frees_the_quota(client, unique_email):
    """**삭제 API 가 없으면 용량 한도가 영구히 잠긴다**"""
    token = await signup(client, unique_email)
    asset = await _ready_asset(client, token)

    before = (await client.get("/v1/storage", headers=auth(token))).json()
    assert before["used_bytes"] == 4_000_000
    assert before["asset_count"] == 1

    res = await client.delete(f"/v1/assets/{asset['id']}", headers=auth(token))
    assert res.status_code == 204

    after = (await client.get("/v1/storage", headers=auth(token))).json()
    assert after["used_bytes"] == 0
    assert after["asset_count"] == 0


async def test_cannot_delete_an_asset_an_export_depends_on(client, unique_email):
    """지우면 목록에 **재생도 다운로드도 안 되는 내보내기**가 남는다"""
    token = await signup(client, unique_email)
    project = await _project(client, token)
    asset = await _ready_asset(client, token)
    await client.post(
        "/v1/exports",
        json={
            "project_id": project["id"],
            "version_id": project["head_version_id"],
            "asset_id": asset["id"],
            "format": "wav",
        },
        headers=auth(token),
    )

    res = await client.delete(f"/v1/assets/{asset['id']}", headers=auth(token))
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "asset_in_use"


async def test_deleting_the_export_first_unblocks_it(client, unique_email):
    token = await signup(client, unique_email)
    project = await _project(client, token)
    asset = await _ready_asset(client, token)
    export = (
        await client.post(
            "/v1/exports",
            json={
                "project_id": project["id"],
                "version_id": project["head_version_id"],
                "asset_id": asset["id"],
                "format": "wav",
            },
            headers=auth(token),
        )
    ).json()

    assert (
        await client.delete(f"/v1/exports/{export['id']}", headers=auth(token))
    ).status_code == 204
    assert (
        await client.delete(f"/v1/assets/{asset['id']}", headers=auth(token))
    ).status_code == 204


async def test_storage_endpoint_shows_the_limit(client, unique_email):
    """한도에 걸렸을 때 **무엇이 얼마를 쓰는지** 못 보면 뭘 지울지 고를 수가 없다"""
    token = await signup(client, unique_email)
    res = await client.get("/v1/storage", headers=auth(token))
    assert res.status_code == 200
    assert res.json()["limit_bytes"] == 2000 * 1024 * 1024


async def test_outsider_cannot_delete_assets(client, unique_email):
    token = await signup(client, unique_email)
    asset = await _ready_asset(client, token)
    other = await signup(client, f"other-{unique_email}")
    assert (
        await client.delete(f"/v1/assets/{asset['id']}", headers=auth(other))
    ).status_code in (403, 404)


# --- 유료 전환 --------------------------------------------------------------


async def test_plans_are_public(client):
    """**가격표는 가입 전에 보여 줘야 하는 것이다**"""
    res = await client.get("/v1/billing/plans")
    assert res.status_code == 200
    codes = {p["code"] for p in res.json()}
    assert "free" in codes and "pro" in codes


async def test_only_owner_can_start_checkout(client, unique_email, db):
    """**editor 가 결제를 시작할 수 있으면 팀원 아무나 조직에 청구를 만든다**"""
    from tests.test_orgs import _invite_token, _team

    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    editor_email = f"ed-{unique_email}"
    editor = await signup(client, editor_email)
    await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": editor_email, "role": "editor"},
        headers=auth(owner),
    )
    await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, editor_email)},
        headers=auth(editor),
    )

    res = await client.post(
        "/v1/billing/checkout",
        json={"plan_code": "pro", "org_id": team["id"]},
        headers=auth(editor),
    )
    assert res.status_code == 403


async def test_checkout_rejects_unknown_and_free_plans(client, unique_email):
    token = await signup(client, unique_email)

    unknown = await client.post(
        "/v1/billing/checkout", json={"plan_code": "unicorn"}, headers=auth(token)
    )
    assert unknown.status_code == 404

    free = await client.post(
        "/v1/billing/checkout", json={"plan_code": "free"}, headers=auth(token)
    )
    assert free.status_code == 422
    assert free.json()["error"]["code"] == "plan_not_payable"


async def test_checkout_reports_unavailable_without_a_key(client, unique_email):
    """로컬에서 결제 없이 나머지를 개발할 수 있어야 한다 —
    **다만 조용히 성공한 척하지는 않는다**"""
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/billing/checkout", json={"plan_code": "pro"}, headers=auth(token)
    )
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "payments_unavailable"


async def test_webhook_attaches_payment_to_the_org_from_metadata(client, unique_email, db):
    """**팀 결제가 결제한 사람의 개인 워크스페이스에 붙으면 안 된다.**

    체크아웃을 만들 때 실어 보낸 `client_reference_id`/메타데이터를 읽어야 한다 —
    이메일로 추측하면 정확히 그 사고가 난다.
    """
    from tests.test_orgs import _team

    token = await signup(client, unique_email)
    team = await _team(client, token)

    await _webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "subscription.created",
            "created": 1_800_100_000,
            "data": {
                "customer_email": unique_email,
                "client_reference_id": team["id"],
                "metadata": {"org_id": team["id"], "plan_code": "pro"},
                "status": "active",
                "customer": "cus_test_123",
            },
        },
    )

    sub = (
        await db.execute(select(Subscription).where(Subscription.org_id == uuid.UUID(team["id"])))
    ).scalar_one()
    assert sub.plan_code == "pro"
    assert sub.commercial_license is True
    assert sub.external_ref == "cus_test_123"

    # **개인 워크스페이스는 그대로 무료다**
    personal = await _subscription(db, unique_email)
    assert personal.plan_code == "free"
