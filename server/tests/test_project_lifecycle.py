"""프로젝트 수명주기 — 이름변경·휴지통·복구·복제.

**휴지통이 이 파일의 이유다.** 소프트 삭제에 30일 유예를 두는 근거가 "곡을 잃는
것은 되돌릴 수 없어서"인데, 정작 되돌리는 문이 없었다. 유예만 있고 복구가 없으면
그건 그냥 지연된 삭제다.

경로 순서도 여기서 잠근다 — `/projects/trash` 를 `/projects/{project_id}` 뒤에
등록해서 422 가 나던 버그가 있었다.
"""

from __future__ import annotations

from tests.test_projects import DOC, auth, signup


async def _project(client, token, name="곡", **kw) -> dict:
    res = await client.post(
        "/v1/projects", json={"name": name, "document": DOC, **kw}, headers=auth(token)
    )
    assert res.status_code == 201, res.text
    return res.json()


async def test_rename_does_not_require_a_document_round_trip(client, unique_email):
    """이름 하나 바꾸는 데 문서 전체를 왕복하면, 그 사이 다른 탭이 저장할 때
    **이름 바꾸기가 충돌을 만드는 기능**이 된다"""
    token = await signup(client, unique_email)
    project = await _project(client, token, "옛 이름")

    res = await client.patch(
        f"/v1/projects/{project['id']}", json={"name": "새 이름"}, headers=auth(token)
    )
    assert res.status_code == 200
    assert res.json()["name"] == "새 이름"

    # 문서와 버전은 그대로다
    detail = (await client.get(f"/v1/projects/{project['id']}", headers=auth(token))).json()
    assert detail["seq"] == 1
    assert detail["document"]["tempo"]["bpm"] == 92


async def test_trash_lists_deleted_projects(client, unique_email):
    """**고정 경로가 파라미터 경로보다 먼저 등록돼야 한다** —
    순서가 뒤집히면 `/trash` 가 `{project_id}` 에 걸려 422 가 난다"""
    token = await signup(client, unique_email)
    kept = await _project(client, token, "남길 곡")
    tossed = await _project(client, token, "지울 곡")

    await client.delete(f"/v1/projects/{tossed['id']}", headers=auth(token))

    res = await client.get("/v1/projects/trash", headers=auth(token))
    assert res.status_code == 200, res.text
    ids = [p["id"] for p in res.json()]
    assert tossed["id"] in ids
    assert kept["id"] not in ids

    # 목록에서는 빠져 있다
    listed = (await client.get("/v1/projects", headers=auth(token))).json()["items"]
    assert [p["id"] for p in listed] == [kept["id"]]


async def test_restore_brings_it_back(client, unique_email):
    token = await signup(client, unique_email)
    project = await _project(client, token)
    await client.delete(f"/v1/projects/{project['id']}", headers=auth(token))

    res = await client.post(f"/v1/projects/{project['id']}/restore", headers=auth(token))
    assert res.status_code == 200

    # 문서가 그대로 살아 있다 — 되돌리기가 되돌리기여야 한다
    detail = await client.get(f"/v1/projects/{project['id']}", headers=auth(token))
    assert detail.status_code == 200
    assert detail.json()["document"]["tempo"]["bpm"] == 92


async def test_restore_is_free_once_the_quota_is_spent(client, unique_email):
    """**복구는 한도를 쓰지 않는다.** 규칙이 뒤집힌 자리라 이유를 남긴다.

    옛 한도는 "동시에 보관 가능한 곡 수"였고, 그래서 복구도 한 칸을 먹었다.
    지금은 **누적 생성 수**라 이 곡은 만들 때 이미 한 칸을 썼다 — 복구할 때 또 세면
    같은 곡을 두 번 물리는 셈이다.

    그리고 여기서 막으면 "자리를 비우고 복구하라"는 말을 들은 사용자가 결국 다른
    곡을 영구 삭제한다. 한도를 지키려다 사용자 작업물을 잃게 만드는 셈이다.
    """
    token = await signup(client, unique_email)
    first = await _project(client, token, "첫 곡")
    await client.delete(f"/v1/projects/{first['id']}", headers=auth(token))

    # 남은 체험을 전부 쓴다 (첫 곡이 이미 한 칸을 썼으므로 네 곡)
    for i in range(4):
        await _project(client, token, f"곡 {i}")

    exhausted = await client.post(
        "/v1/projects", json={"name": "막힘", "document": DOC}, headers=auth(token)
    )
    assert exhausted.status_code == 402, "여기서 막혀 있어야 시험이 성립한다"

    res = await client.post(f"/v1/projects/{first['id']}/restore", headers=auth(token))
    assert res.status_code == 200, f"휴지통 복구가 한도로 막히면 안 된다: {res.text}"


async def test_cannot_restore_someone_elses_project(client, unique_email):
    token = await signup(client, unique_email)
    project = await _project(client, token)
    await client.delete(f"/v1/projects/{project['id']}", headers=auth(token))

    other = await signup(client, f"other-{unique_email}")
    res = await client.post(f"/v1/projects/{project['id']}/restore", headers=auth(other))
    assert res.status_code == 404


async def test_duplicate_starts_a_fresh_history(client, unique_email):
    """**사본의 1번 버전이 원본의 현재 상태다.**

    이력까지 복사하면 "누가 언제 만든 버전인가"가 두 곡에 갈라져 되돌리기가 헷갈린다.
    """
    token = await signup(client, unique_email)
    project = await _project(client, token, "원본")
    # 원본에 이력을 쌓는다
    await client.put(
        f"/v1/projects/{project['id']}",
        json={"document": {**DOC, "tempo": {"bpm": 140}}},
        headers={**auth(token), "If-Match": project["head_version_id"]},
    )

    res = await client.post(f"/v1/projects/{project['id']}/duplicate", headers=auth(token))
    assert res.status_code == 201, res.text
    copy = res.json()
    assert copy["name"] == "원본 사본"
    assert copy["id"] != project["id"]
    assert copy["seq"] == 1, "사본은 1번 버전부터 시작한다"
    assert copy["document"]["tempo"]["bpm"] == 140, "원본의 현재 상태를 가져온다"

    versions = (
        await client.get(f"/v1/projects/{copy['id']}/versions", headers=auth(token))
    ).json()
    assert len(versions) == 1

    # 원본은 그대로다
    original = (
        await client.get(f"/v1/projects/{project['id']}/versions", headers=auth(token))
    ).json()
    assert len(original) == 2


async def test_duplicate_respects_the_plan_limit(client, unique_email):
    token = await signup(client, unique_email)
    projects = [await _project(client, token, f"곡 {i}") for i in range(5)]
    res = await client.post(
        f"/v1/projects/{projects[0]['id']}/duplicate", headers=auth(token)
    )
    assert res.status_code == 402


async def test_duplicate_lands_in_the_same_workspace(client, unique_email):
    """사본이 개인 워크스페이스로 새면 팀에서 만든 곡이 조용히 빠져나간다"""
    from tests.test_orgs import _team

    token = await signup(client, unique_email)
    team = await _team(client, token)
    project = await _project(client, token, "팀 곡", org_id=team["id"])

    copy = (
        await client.post(f"/v1/projects/{project['id']}/duplicate", headers=auth(token))
    ).json()
    assert copy["org_id"] == team["id"]


async def test_viewer_cannot_rename_or_duplicate(client, unique_email, db):
    from tests.test_orgs import _invite_token, _team

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
    project = await _project(client, owner, "팀 곡", org_id=team["id"])

    assert (
        await client.patch(
            f"/v1/projects/{project['id']}", json={"name": "x"}, headers=auth(viewer)
        )
    ).status_code == 403
    assert (
        await client.post(f"/v1/projects/{project['id']}/duplicate", headers=auth(viewer))
    ).status_code == 403
