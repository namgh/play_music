"""어드민 — **권한 경계가 여기서 가장 위험하다** (`SERVER_ACCOUNTS.md` 3·4절).

지키려는 규칙:
  1. 플랫폼 역할이 **리소스 접근을 자동으로 주지 않는다.** admin 이라고 남의
     프로젝트를 열 수 있으면 그건 기능이 아니라 사고다
  2. 정지는 **편집만** 막는다. 로그인과 반출은 된다 — 창작물을 인질로 잡지 않는다
  3. 대리 접속은 사유·시한·감사 없이는 시작되지 않는다
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.db.models import AuditLog, ImpersonationSession, User
from tests.test_projects import DOC, auth, signup


async def _make(client, db, email: str, role: str) -> str:
    await signup(client, email)
    user = (await db.execute(select(User).where(User.email == email))).scalar_one()
    user.platform_role = role
    await db.commit()
    # 역할은 액세스 토큰 안에 들어가므로 **다시 로그인해야** 반영된다
    res = await client.post(
        "/v1/auth/login", json={"email": email, "password": "correct-horse-battery"}
    )
    return res.json()["access_token"]


async def test_regular_user_cannot_touch_admin(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.get("/v1/admin/users", headers=auth(token))
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "insufficient_role"


async def test_there_is_no_endpoint_to_read_another_users_project(client, unique_email, db):
    """**설계상 그런 엔드포인트가 없다.** admin 토큰으로도 일반 경로는 404 다 —
    소유자 조건이 쿼리에 박혀 있어서 역할로 우회할 수 없다"""
    owner = await signup(client, unique_email)
    project = (
        await client.post(
            "/v1/projects", json={"name": "비밀", "document": DOC}, headers=auth(owner)
        )
    ).json()

    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    res = await client.get(f"/v1/projects/{project['id']}", headers=auth(admin))
    assert res.status_code == 404, "어드민이라고 남의 곡을 열 수 있으면 안 된다"

    # 어드민 표면 어디에도 남의 문서를 읽는 경로가 **없다**는 것을 확인한다.
    # 있으면 언젠가 쓰이고, 쓰이면 사고가 난다
    from app.api.v1 import admin as admin_router

    admin_paths = [r.path for r in admin_router.router.routes]
    assert not any("project" in p or "document" in p for p in admin_paths), admin_paths


async def test_suspended_user_can_still_login_and_export(client, unique_email, db):
    """**정지는 서비스 이용 제한이지 창작물 압류가 아니다.**
    편집은 막히지만 내려받기는 된다"""
    token = await signup(client, unique_email)
    project = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()

    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    res = await client.post(
        f"/v1/admin/users/{user.id}/status",
        json={"status": "suspended", "reason": "결제 도용 의심"},
        headers=auth(admin),
    )
    assert res.status_code == 200

    # 로그인 된다
    login = await client.post(
        "/v1/auth/login", json={"email": unique_email, "password": "correct-horse-battery"}
    )
    assert login.status_code == 200
    suspended_token = login.json()["access_token"]

    # 읽기·반출 된다
    assert (
        await client.get(f"/v1/projects/{project['id']}", headers=auth(suspended_token))
    ).status_code == 200
    assert (
        await client.get(
            f"/v1/projects/{project['id']}/exports", headers=auth(suspended_token)
        )
    ).status_code == 200

    # 편집은 막힌다
    blocked = await client.put(
        f"/v1/projects/{project['id']}",
        json={"document": DOC},
        headers={**auth(suspended_token), "If-Match": project["head_version_id"]},
    )
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "account_suspended"


async def test_support_cannot_change_status(client, unique_email, db):
    """support 는 보기만 한다. 정지 권한까지 주면 최소 권한이 무너진다"""
    await signup(client, unique_email)
    support = await _make(client, db, f"sup-{unique_email}", "support")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    res = await client.post(
        f"/v1/admin/users/{user.id}/status",
        json={"status": "suspended", "reason": "이유"},
        headers=auth(support),
    )
    assert res.status_code == 403


async def test_admin_cannot_suspend_an_owner(client, unique_email, db):
    """**권한 상승을 막는다.** admin 이 owner 를 정지시킬 수 있으면
    어드민 하나가 조직 전체를 잠글 수 있다"""
    await _make(client, db, f"owner-{unique_email}", "owner")
    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    owner = (
        await db.execute(select(User).where(User.email == f"owner-{unique_email}"))
    ).scalar_one()

    res = await client.post(
        f"/v1/admin/users/{owner.id}/status",
        json={"status": "suspended", "reason": "권한 상승 시도"},
        headers=auth(admin),
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "insufficient_role"


async def test_impersonation_requires_reason_and_is_time_limited(client, unique_email, db):
    await signup(client, unique_email)
    support = await _make(client, db, f"sup-{unique_email}", "support")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    # 사유가 짧으면 거절한다 — 빈 사유는 감사 기록을 무의미하게 만든다
    bad = await client.post(
        f"/v1/admin/users/{user.id}/impersonate",
        json={"reason": "ㅇㅇ"},
        headers=auth(support),
    )
    assert bad.status_code == 422

    ok = await client.post(
        f"/v1/admin/users/{user.id}/impersonate",
        json={"reason": "결제 문의 티켓 #1234 재현", "ticket_ref": "1234", "minutes": 15},
        headers=auth(support),
    )
    assert ok.status_code == 200
    body = ok.json()
    assert body["write_allowed"] is False  # 기본은 읽기 전용

    row = (
        await db.execute(
            select(ImpersonationSession).where(
                ImpersonationSession.id == uuid.UUID(body["session_id"])
            )
        )
    ).scalar_one()
    assert row.expires_at is not None
    assert row.reason.startswith("결제 문의")

    # **감사 로그에 담당자와 대상이 둘 다 남는다**
    audit_row = (
        await db.execute(
            select(AuditLog)
            .where(AuditLog.action == "admin.impersonate.start")
            .order_by(AuditLog.id.desc())
            .limit(1)
        )
    ).scalar_one()
    assert audit_row.on_behalf_of == user.id
    assert audit_row.actor_id != user.id


async def test_only_owner_can_change_roles(client, unique_email, db):
    await signup(client, unique_email)
    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    denied = await client.post(
        f"/v1/admin/users/{user.id}/role",
        json={"platform_role": "admin"},
        headers=auth(admin),
    )
    assert denied.status_code == 403

    owner = await _make(client, db, f"owner-{unique_email}", "owner")
    allowed = await client.post(
        f"/v1/admin/users/{user.id}/role",
        json={"platform_role": "support"},
        headers=auth(owner),
    )
    assert allowed.status_code == 200


async def test_admin_actions_are_all_audited(client, unique_email, db):
    """어드민이 한 일은 **전부 남는다.** 남지 않으면 사고가 났을 때 아무 말도 못 한다"""
    await signup(client, unique_email)
    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    await client.post(
        f"/v1/admin/users/{user.id}/status",
        json={"status": "suspended", "reason": "감사 확인용"},
        headers=auth(admin),
    )
    res = await client.get("/v1/admin/audit?action=admin.users.status", headers=auth(admin))
    assert res.status_code == 200
    assert any(row["target_id"] == str(user.id) for row in res.json())


@pytest.mark.parametrize("status_value", ["deleted", "not-a-status", ""])
async def test_status_values_are_constrained(client, unique_email, db, status_value):
    """상태 문자열을 자유 입력으로 두면 오타 하나로 **계정이 잠긴다**"""
    await signup(client, unique_email)
    admin = await _make(client, db, f"admin-{unique_email}", "admin")
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    res = await client.post(
        f"/v1/admin/users/{user.id}/status",
        json={"status": status_value, "reason": "값 검증"},
        headers=auth(admin),
    )
    assert res.status_code == 422
