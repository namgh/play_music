"""내 계정 — 프로필·비밀번호·**탈퇴와 파기**.

탈퇴가 여기서 가장 중요하다. `SERVER_ACCOUNTS.md` 가 상태기계
(본인 삭제 → `deleted` → 30일 → `purged`)를 정해 뒀는데 코드에 한 줄도 없었다.
개인정보 삭제 요청을 처리할 수단이 없으면 서비스 오픈 자체가 성립하지 않는다.

파기에서 지키는 선: **개인정보는 지우고, 돈과 감사의 근거는 남긴다.** 둘을 같이
지우면 분쟁이 났을 때 우리도 사용자도 아무것도 증명할 수 없다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from app.db.models import AuditLog, Project, User
from app.scheduler import main as sched
from tests.test_projects import DOC, auth, signup

PASSWORD = "correct-horse-battery"


async def test_me_returns_everything_the_first_screen_needs(client, unique_email):
    """나눠 놓으면 첫 화면에서 요청을 네 번 하게 되고, 그 넷이 서로 다른 시점을 본다"""
    token = await signup(client, unique_email)
    res = await client.get("/v1/me", headers=auth(token))
    assert res.status_code == 200, res.text

    body = res.json()
    assert body["email"] == unique_email
    assert body["auth_providers"] == ["password"]
    assert body["email_verified"] is False

    ws = body["workspaces"]
    assert len(ws) == 1
    assert ws[0]["kind"] == "personal"
    assert ws[0]["my_role"] == "owner"
    assert ws[0]["plan_code"] == "free"
    assert ws[0]["commercial_license"] is False
    # 무료 체험은 **누적 5곡**이다 (`SERVER_PAYMENTS.md` 0절)
    assert ws[0]["limits"]["songs_total"] == 5
    assert ws[0]["usage"]["projects"] == 0
    assert ws[0]["usage"]["songs_total"] == 0, "체험을 몇 칸 썼는지 화면이 알아야 한다"


async def test_me_project_count_tracks_reality(client, unique_email):
    token = await signup(client, unique_email)
    await client.post(
        "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
    )
    body = (await client.get("/v1/me", headers=auth(token))).json()
    assert body["workspaces"][0]["usage"]["projects"] == 1


async def test_suspended_user_can_still_see_why(client, unique_email, db):
    """**정지된 계정도 자기 정보는 볼 수 있어야 한다** — 왜 막혔는지 알아야 하니까"""
    token = await signup(client, unique_email)
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    user.status = "suspended"
    await db.commit()

    res = await client.get("/v1/me", headers=auth(token))
    assert res.status_code == 200
    assert res.json()["status"] == "suspended"


async def test_update_profile(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.patch(
        "/v1/me", json={"display_name": "남기훈"}, headers=auth(token)
    )
    assert res.status_code == 200
    assert res.json()["display_name"] == "남기훈"


async def test_password_change_requires_the_current_one(client, unique_email):
    """**액세스 토큰만으로 바꿀 수 있으면, 토큰이 한 번 새는 순간 계정이 넘어간다** —
    원래 주인은 비밀번호가 바뀌어 되찾을 수 없다"""
    token = await signup(client, unique_email)

    wrong = await client.post(
        "/v1/me/password",
        json={"current_password": "not-the-password", "new_password": "brand-new-pass-1"},
        headers=auth(token),
    )
    assert wrong.status_code == 401

    ok = await client.post(
        "/v1/me/password",
        json={"current_password": PASSWORD, "new_password": "brand-new-pass-1"},
        headers=auth(token),
    )
    assert ok.status_code == 204

    assert (
        await client.post(
            "/v1/auth/login", json={"email": unique_email, "password": "brand-new-pass-1"}
        )
    ).status_code == 200


async def test_password_change_kills_other_sessions(client, unique_email, db):
    """바꾸는 이유의 절반은 "누가 들어온 것 같다"이고,
    그때 옛 세션이 살아 있으면 바꾼 의미가 없다"""
    from app.db.models import RefreshToken

    token = await signup(client, unique_email)
    user_id = (
        await db.execute(select(User).where(User.email == unique_email))
    ).scalar_one().id

    await client.post(
        "/v1/me/password",
        json={"current_password": PASSWORD, "new_password": "brand-new-pass-1"},
        headers=auth(token),
    )
    live = (
        await db.execute(
            select(RefreshToken).where(
                RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
            )
        )
    ).scalars().all()
    assert live == []


async def test_password_change_is_rejected_for_google_only_accounts(client, db, unique_email):
    """비밀번호가 없는 계정에 "현재 비밀번호"를 물으면 답할 수가 없다"""
    from app.db.models import AuthIdentity

    token = await signup(client, unique_email)
    await db.execute(
        text("DELETE FROM auth_identities WHERE provider = 'password' AND subject = :e"),
        {"e": unique_email},
    )
    await db.commit()

    res = await client.post(
        "/v1/me/password",
        json={"current_password": "x" * 12, "new_password": "y" * 12},
        headers=auth(token),
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "no_password_identity"
    assert AuthIdentity is not None  # 임포트 사용


# --- 탈퇴 -------------------------------------------------------------------


async def test_delete_requires_password_and_confirmation(client, unique_email):
    """실수로 누르는 것을 막는다"""
    token = await signup(client, unique_email)

    no_confirm = await client.post(
        "/v1/me/delete", json={"password": PASSWORD, "confirm": "네"}, headers=auth(token)
    )
    assert no_confirm.status_code == 422

    wrong_pw = await client.post(
        "/v1/me/delete",
        json={"password": "wrong-password-xx", "confirm": "삭제합니다"},
        headers=auth(token),
    )
    assert wrong_pw.status_code == 401


async def test_delete_marks_deleted_and_kills_sessions(client, unique_email, db):
    from app.db.models import RefreshToken

    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )
    assert res.status_code == 202
    assert res.json()["purge_after_days"] == 30

    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    await db.refresh(user)
    assert user.status == "deleted"
    assert user.deleted_at is not None

    live = (
        await db.execute(
            select(RefreshToken).where(
                RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
            )
        )
    ).scalars().all()
    assert live == []


async def test_deleted_user_can_log_back_in_and_restore(client, unique_email):
    """**30일은 실수와 탈취를 위한 창이다.** 로그인이 막히면 되돌릴 수가 없다"""
    token = await signup(client, unique_email)
    await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )

    login = await client.post(
        "/v1/auth/login", json={"email": unique_email, "password": PASSWORD}
    )
    assert login.status_code == 200, "삭제 유예 중에는 로그인이 되어야 복구할 수 있다"
    new_token = login.json()["access_token"]

    # 편집은 막혀 있다
    blocked = await client.post(
        "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(new_token)
    )
    assert blocked.status_code == 403

    restored = await client.post("/v1/me/restore", headers=auth(new_token))
    assert restored.status_code == 200
    assert restored.json()["status"] == "active"

    # 이제 다시 만들 수 있다
    assert (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(new_token)
        )
    ).status_code == 201


async def test_cannot_delete_while_owning_a_shared_team(client, unique_email, db):
    """**남의 작업물을 지우는 일이 되면 안 된다.** 마지막 owner 는 먼저 정리해야 한다"""
    from tests.test_orgs import _invite_token, _team

    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    mate_email = f"mate-{unique_email}"
    mate = await signup(client, mate_email)
    await client.post(
        f"/v1/orgs/{team['id']}/invites", json={"email": mate_email}, headers=auth(owner)
    )
    await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, mate_email)},
        headers=auth(mate),
    )

    res = await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(owner),
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "owns_shared_workspace"


async def test_solo_team_does_not_block_deletion(client, unique_email):
    """혼자 있는 팀은 막을 이유가 없다"""
    from tests.test_orgs import _team

    token = await signup(client, unique_email)
    await _team(client, token)
    res = await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )
    assert res.status_code == 202


async def test_purge_removes_personal_data_but_keeps_the_ledger(client, unique_email, db):
    """**개인정보는 지우고 근거는 남긴다.**

    둘을 같이 지우면 결제 분쟁이 났을 때 아무것도 증명할 수 없고,
    반대로 안 지우면 개인정보 파기 의무를 못 지킨다.
    """
    token = await signup(client, unique_email)
    project = (
        await client.post(
            "/v1/projects", json={"name": "지워질 곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    user_id = user.id

    org_id = (
        await db.execute(
            text("SELECT org_id FROM projects WHERE id = :p"), {"p": project["id"]}
        )
    ).scalar_one()

    await db.execute(
        text(
            "INSERT INTO usage_events (org_id, user_id, kind, quantity) "
            "VALUES (:o, :u, 'ai_job', 1)"
        ),
        {"o": org_id, "u": user_id},
    )
    # 돈이 걸린 행 — 파기가 이걸 지우면 결제 분쟁에서 아무것도 증명할 수 없다
    await db.execute(
        text(
            "INSERT INTO subscriptions (org_id, plan_code, status) VALUES (:o, 'pro', 'canceled') "
            "ON CONFLICT (org_id) DO UPDATE SET plan_code = 'pro'"
        ),
        {"o": org_id},
    )
    await db.commit()

    await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )
    # 30일이 지난 것으로 만든다
    await db.execute(
        text("UPDATE users SET deleted_at = :old WHERE id = :id"),
        {"old": datetime.now(UTC) - timedelta(days=31), "id": user_id},
    )
    await db.commit()

    await sched.purge_deleted_users()

    purged = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
    await db.refresh(purged)
    assert purged.status == "purged"
    # **개인정보는 사라졌다**
    assert unique_email not in purged.email
    assert purged.email.endswith("@purged.invalid")
    assert purged.display_name == ""

    # 곡과 개인 워크스페이스도 사라졌다
    gone = (
        await db.execute(select(Project).where(Project.id == project["id"]))
    ).scalar_one_or_none()
    assert gone is None

    # ------------------------------------------------------------------
    # **원장은 남고 식별자만 끊긴다.**
    #
    # 예전 이 테스트는 `count(*) WHERE user_id = :u == 0` 만 봤는데, 그건 행이
    # **삭제돼도** 통과한다. 지워졌는지 남았는지를 구분하지 못하는 단언이라,
    # 파기가 조직을 DELETE 해서 원장을 통째로 날리는 동안에도 초록불이었다.
    # 그래서 이제 **행이 몇 개 남았는지**를 조직 기준으로 센다.
    # ------------------------------------------------------------------
    kept = (
        await db.execute(
            text("SELECT count(*) FROM usage_events WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert kept > 0, "사용량 원장이 남아 있어야 한다 — 지우면 결제 분쟁을 못 푼다"

    orphaned = (
        await db.execute(
            text("SELECT count(*) FROM usage_events WHERE org_id = :o AND user_id IS NOT NULL"),
            {"o": org_id},
        )
    ).scalar_one()
    assert orphaned == 0, "원장은 남기되 사람과의 연결은 끊겨야 한다"

    subs = (
        await db.execute(
            text("SELECT count(*) FROM subscriptions WHERE org_id = :o"), {"o": org_id}
        )
    ).scalar_one()
    assert subs == 1, "구독 이력이 남아 있어야 한다"

    # **조직도 사람처럼 익명화한다 — 지우지 않는다.** 지우면 위 둘이 CASCADE 로 따라간다
    org = (
        await db.execute(
            text("SELECT status, name, slug FROM organizations WHERE id = :o"), {"o": org_id}
        )
    ).first()
    assert org is not None, "조직 행을 지우면 구독·원장이 CASCADE 로 사라진다"
    assert org.status == "purged"
    assert org.name == ""
    assert org.slug.startswith("purged-")

    audit_rows = (
        await db.execute(select(AuditLog).where(AuditLog.actor_id == user_id))
    ).scalars().all()
    assert audit_rows == [], "감사 로그의 식별자도 끊겨야 한다"


async def test_purge_leaves_recent_deletions_alone(client, unique_email, db):
    """**유예 기간 안의 계정을 지우면 되돌릴 수 없다**"""
    token = await signup(client, unique_email)
    await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )

    await sched.purge_deleted_users()

    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    await db.refresh(user)
    assert user.status == "deleted", "아직 30일이 안 지났다"


async def test_the_same_address_can_sign_up_again_after_purge(client, unique_email, db):
    """파기 뒤에는 그 주소를 다시 쓸 수 있어야 한다 — 못 쓰면 사실상 영구 차단이다"""
    token = await signup(client, unique_email)
    await client.post(
        "/v1/me/delete",
        json={"password": PASSWORD, "confirm": "삭제합니다"},
        headers=auth(token),
    )
    await db.execute(
        text("UPDATE users SET deleted_at = :old WHERE email = :e"),
        {"old": datetime.now(UTC) - timedelta(days=31), "e": unique_email},
    )
    await db.commit()
    await sched.purge_deleted_users()

    again = await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": PASSWORD}
    )
    assert again.status_code == 201
