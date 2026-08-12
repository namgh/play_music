"""워크스페이스 — **개인 계정도 1인 조직이다.**

이 파일이 지키는 것:
  1. 가입하면 개인 워크스페이스가 자동으로 생기고, `org_id` 없는 요청은 거기로 간다
  2. 팀 곡은 **만든 사람이 아니라 조직 구성원**이 연다 (퇴사해도 곡이 남는다)
  3. 역할이 실제로 막는다 — viewer 는 편집 못 한다
  4. 마지막 owner 는 나갈 수 없다 (아무도 과금·삭제 못 하는 조직을 만들지 않는다)
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db.models import EmailOutbox, OrgInvite
from tests.test_projects import DOC, auth, signup


async def _team(client, token, name: str = "밴드") -> dict:
    res = await client.post("/v1/orgs", json={"name": name}, headers=auth(token))
    assert res.status_code == 201, res.text
    return res.json()


async def _invite_token(db, email: str) -> str:
    """메일로 나간 초대 링크에서 토큰을 꺼낸다 — **응답에는 안 들어 있다**"""
    row = (
        await db.execute(
            select(EmailOutbox)
            .where(EmailOutbox.to_email == email, EmailOutbox.template == "org_invite")
            .order_by(EmailOutbox.created_at.desc())
            .limit(1)
        )
    ).scalar_one()
    return row.payload["link"].split("token=")[1]


async def test_signup_gives_a_personal_workspace(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.get("/v1/orgs", headers=auth(token))
    assert res.status_code == 200
    orgs = res.json()
    assert len(orgs) == 1
    assert orgs[0]["kind"] == "personal"
    assert orgs[0]["my_role"] == "owner"


async def test_project_without_org_id_goes_to_personal(client, unique_email):
    """**처음 쓰는 사람에게 워크스페이스를 고르라고 하지 않는다** — 거기서 절반이 떠난다"""
    token = await signup(client, unique_email)
    personal = (await client.get("/v1/orgs", headers=auth(token))).json()[0]

    project = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    assert project["org_id"] == personal["id"]


async def test_personal_workspace_appears_first(client, unique_email):
    token = await signup(client, unique_email)
    await _team(client, token, "팀 하나")
    await _team(client, token, "팀 둘")
    orgs = (await client.get("/v1/orgs", headers=auth(token))).json()
    assert orgs[0]["kind"] == "personal"
    assert len(orgs) == 3


async def test_invite_flow_end_to_end(client, unique_email, db):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)

    guest_email = f"guest-{unique_email}"
    guest = await signup(client, guest_email)

    res = await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": guest_email, "role": "editor"},
        headers=auth(owner),
    )
    assert res.status_code == 201
    # **토큰을 응답에 담지 않는다** — 초대한 사람이 남의 링크를 쓸 수 있으면 안 된다
    assert "token" not in res.text

    accepted = await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, guest_email)},
        headers=auth(guest),
    )
    assert accepted.status_code == 200
    assert accepted.json()["my_role"] == "editor"

    members = (await client.get(f"/v1/orgs/{team['id']}/members", headers=auth(owner))).json()
    assert {m["email"] for m in members} == {unique_email, guest_email}


async def test_invite_can_only_be_accepted_by_the_invited_address(client, unique_email, db):
    """링크가 유출돼도 **다른 계정이 팀에 들어오지 못한다**"""
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    invited_email = f"invited-{unique_email}"
    await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": invited_email},
        headers=auth(owner),
    )

    attacker = await signup(client, f"attacker-{unique_email}")
    res = await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, invited_email)},
        headers=auth(attacker),
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "invite_email_mismatch"


async def test_invite_token_is_single_use(client, unique_email, db):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    guest_email = f"guest-{unique_email}"
    guest = await signup(client, guest_email)
    await client.post(
        f"/v1/orgs/{team['id']}/invites", json={"email": guest_email}, headers=auth(owner)
    )
    token = await _invite_token(db, guest_email)

    assert (
        await client.post(
            "/v1/orgs/invites/accept", json={"token": token}, headers=auth(guest)
        )
    ).status_code == 200
    second = await client.post(
        "/v1/orgs/invites/accept", json={"token": token}, headers=auth(guest)
    )
    assert second.status_code == 404


async def test_cannot_invite_into_personal_workspace(client, unique_email):
    """개인 워크스페이스에 남을 들이면 그건 이미 팀이다. 개념을 흐리지 않는다"""
    token = await signup(client, unique_email)
    personal = (await client.get("/v1/orgs", headers=auth(token))).json()[0]
    res = await client.post(
        f"/v1/orgs/{personal['id']}/invites",
        json={"email": "someone@example.com"},
        headers=auth(token),
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "cannot_invite_to_personal"


async def test_team_project_is_visible_to_teammates(client, unique_email, db):
    """**만든 사람이 아니라 조직 구성원이 연다.** 사람이 팀을 떠나도 곡은 팀에 남는다"""
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

    project = (
        await client.post(
            "/v1/projects",
            json={"name": "팀 곡", "document": DOC, "org_id": team["id"]},
            headers=auth(owner),
        )
    ).json()

    seen = await client.get(f"/v1/projects/{project['id']}", headers=auth(mate))
    assert seen.status_code == 200
    assert seen.json()["document"]["tempo"]["bpm"] == 92


async def test_outsider_cannot_see_team_project(client, unique_email):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    project = (
        await client.post(
            "/v1/projects",
            json={"name": "팀 곡", "document": DOC, "org_id": team["id"]},
            headers=auth(owner),
        )
    ).json()

    outsider = await signup(client, f"out-{unique_email}")
    assert (
        await client.get(f"/v1/projects/{project['id']}", headers=auth(outsider))
    ).status_code == 404


async def test_viewer_can_read_but_not_edit(client, unique_email, db):
    """**역할이 실제로 막아야 한다.** 안 막으면 역할은 장식이다"""
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    viewer_email = f"viewer-{unique_email}"
    viewer = await signup(client, viewer_email)
    await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": viewer_email, "role": "viewer"},
        headers=auth(owner),
    )
    await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, viewer_email)},
        headers=auth(viewer),
    )

    project = (
        await client.post(
            "/v1/projects",
            json={"name": "팀 곡", "document": DOC, "org_id": team["id"]},
            headers=auth(owner),
        )
    ).json()

    assert (
        await client.get(f"/v1/projects/{project['id']}", headers=auth(viewer))
    ).status_code == 200

    blocked = await client.put(
        f"/v1/projects/{project['id']}",
        json={"document": {**DOC, "tempo": {"bpm": 200}}},
        headers={**auth(viewer), "If-Match": project["head_version_id"]},
    )
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "insufficient_org_role"

    # 삭제도 못 한다
    assert (
        await client.delete(f"/v1/projects/{project['id']}", headers=auth(viewer))
    ).status_code == 403


async def test_editor_cannot_invite(client, unique_email, db):
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
        f"/v1/orgs/{team['id']}/invites",
        json={"email": "another@example.com"},
        headers=auth(editor),
    )
    assert res.status_code == 403


async def test_last_owner_cannot_leave(client, unique_email):
    """빠지면 **아무도 과금·삭제를 못 하는 조직**이 남는다. 그건 고객지원으로만 풀린다"""
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    me = (await client.get("/v1/orgs", headers=auth(owner))).json()
    assert any(o["id"] == team["id"] for o in me)

    members = (await client.get(f"/v1/orgs/{team['id']}/members", headers=auth(owner))).json()
    my_id = members[0]["user_id"]

    res = await client.delete(f"/v1/orgs/{team['id']}/members/{my_id}", headers=auth(owner))
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "last_owner"


async def test_cannot_leave_personal_workspace(client, unique_email):
    token = await signup(client, unique_email)
    personal = (await client.get("/v1/orgs", headers=auth(token))).json()[0]
    members = (
        await client.get(f"/v1/orgs/{personal['id']}/members", headers=auth(token))
    ).json()
    res = await client.delete(
        f"/v1/orgs/{personal['id']}/members/{members[0]['user_id']}", headers=auth(token)
    )
    assert res.status_code in (409, 422)


async def test_team_has_its_own_quota(client, unique_email):
    """**한도는 사람이 아니라 워크스페이스 것이다.** 개인에서 다 썼어도 팀에서는 쓴다"""
    token = await signup(client, unique_email)
    for i in range(5):  # 무료 개인 한도를 다 채운다
        assert (
            await client.post(
                "/v1/projects", json={"name": f"곡 {i}", "document": DOC}, headers=auth(token)
            )
        ).status_code == 201
    over = await client.post(
        "/v1/projects", json={"name": "여섯째", "document": DOC}, headers=auth(token)
    )
    assert over.status_code == 402

    team = await _team(client, token)
    in_team = await client.post(
        "/v1/projects",
        json={"name": "팀 첫 곡", "document": DOC, "org_id": team["id"]},
        headers=auth(token),
    )
    assert in_team.status_code == 201, "팀은 자기 한도를 따로 갖는다"


async def test_usage_endpoint_is_org_scoped(client, unique_email):
    token = await signup(client, unique_email)
    team = await _team(client, token)
    res = await client.get(f"/v1/orgs/{team['id']}/usage", headers=auth(token))
    assert res.status_code == 200
    body = res.json()
    assert body["plan_code"] == "free"
    assert body["usage"]["ai_job"] == 0


async def test_invite_row_is_created_and_scoped(client, unique_email, db):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": f"x-{unique_email}", "role": "viewer"},
        headers=auth(owner),
    )
    row = (
        await db.execute(select(OrgInvite).where(OrgInvite.email == f"x-{unique_email}"))
    ).scalar_one()
    assert row.role == "viewer"
    assert row.accepted_at is None
    # 원문 토큰은 DB 에 없다
    assert len(row.token_hash) == 64


async def test_storage_quota_is_per_workspace_not_per_person(client, unique_email, db):
    """**두 방향으로 틀렸던 버그의 회귀 테스트.**

    에셋 한도를 개인 기준으로 세면 (1) 팀이 Pro 를 결제해도 올리는 사람의 무료
    한도에 막히고 (2) 반대로 무료 조직에 여러 명을 초대하면 같은 워크스페이스에
    인원수만큼 올릴 수 있다 — 스토리지 비용이 사람 수에 비례해 샌다.
    """
    import hashlib

    from app.db.models import Asset

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

    body = {
        "kind": "export",
        "content_type": "audio/wav",
        "size_bytes": 1024,
        "sha256": hashlib.sha256(b"x").hexdigest(),
        "org_id": team["id"],
    }
    a = (await client.post("/v1/assets", json=body, headers=auth(owner))).json()
    b = (await client.post("/v1/assets", json=body, headers=auth(mate))).json()

    rows = (
        await db.execute(
            select(Asset).where(Asset.id.in_([uuid.UUID(a["id"]), uuid.UUID(b["id"])]))
        )
    ).scalars().all()
    assert {str(r.org_id) for r in rows} == {team["id"]}, "누가 올렸든 팀 소유여야 한다"


async def test_cannot_upload_into_a_workspace_you_are_not_in(client, unique_email):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    outsider = await signup(client, f"out-{unique_email}")

    import hashlib

    res = await client.post(
        "/v1/assets",
        json={
            "kind": "export",
            "content_type": "audio/wav",
            "size_bytes": 1024,
            "sha256": hashlib.sha256(b"x").hexdigest(),
            "org_id": team["id"],
        },
        headers=auth(outsider),
    )
    assert res.status_code == 404


async def test_viewer_cannot_upload(client, unique_email, db):
    owner = await signup(client, unique_email)
    team = await _team(client, owner)
    viewer_email = f"v-{unique_email}"
    viewer = await signup(client, viewer_email)
    await client.post(
        f"/v1/orgs/{team['id']}/invites",
        json={"email": viewer_email, "role": "viewer"},
        headers=auth(owner),
    )
    await client.post(
        "/v1/orgs/invites/accept",
        json={"token": await _invite_token(db, viewer_email)},
        headers=auth(viewer),
    )

    import hashlib

    res = await client.post(
        "/v1/assets",
        json={
            "kind": "export",
            "content_type": "audio/wav",
            "size_bytes": 1024,
            "sha256": hashlib.sha256(b"x").hexdigest(),
            "org_id": team["id"],
        },
        headers=auth(viewer),
    )
    assert res.status_code == 403
