"""프로젝트 저장 — **이 서비스의 심장**이라 여기를 제일 촘촘히 본다.

`SERVER.md` 3절이 정한 성질을 그대로 검증한다:
  1. 버전은 불변, head 만 움직인다
  2. 저장은 낙관적 잠금 — `If-Match` 없으면 거절
  3. 같은 내용은 새 버전을 만들지 않는다
"""

from __future__ import annotations

from typing import Any

import pytest

DOC: dict[str, Any] = {
    "schemaVersion": 1,
    "name": "테스트 곡",
    "tempo": {"bpm": 92},
    "key": {"tonic": "A", "mode": "minor"},
    "lengthBars": 8,
    "tracks": [
        {"id": "trk_1", "instrumentId": "acoustic-guitar", "clips": []},
        {"id": "trk_2", "instrumentId": "electric-bass", "clips": []},
    ],
}


async def signup(client, email: str) -> str:
    res = await client.post(
        "/v1/auth/signup", json={"email": email, "password": "correct-horse-battery"}
    )
    assert res.status_code == 201, res.text
    return res.json()["access_token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_create_and_read(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/projects", json={"name": "곡 1", "document": DOC}, headers=auth(token)
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["seq"] == 1
    # 파생 컬럼이 문서에서 뽑혔는가 — 목록 조회가 JSONB 를 안 파싱하려고 두는 것
    assert body["bpm"] == 92
    assert body["key_tonic"] == "A"
    assert body["track_count"] == 2
    assert body["instrument_ids"] == ["acoustic-guitar", "electric-bass"]

    got = await client.get(f"/v1/projects/{body['id']}", headers=auth(token))
    assert got.status_code == 200
    assert got.json()["document"]["tempo"]["bpm"] == 92


async def test_save_requires_if_match(client, unique_email):
    """**헤더가 없으면 거절한다.** 없으면 덮어쓰기가 기본값이 되고 그건 데이터 손실이다"""
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()

    res = await client.put(
        f"/v1/projects/{created['id']}", json={"document": DOC}, headers=auth(token)
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "if_match_required"


async def test_optimistic_lock_conflict_carries_current_document(client, unique_email):
    """409 에 **현재 문서를 실어 보낸다** — 안 그러면 클라이언트가 한 번 더 왕복해야
    하고 그 사이 또 바뀔 수 있다"""
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    head = created["head_version_id"]

    changed = {**DOC, "tempo": {"bpm": 120}}
    ok = await client.put(
        f"/v1/projects/{created['id']}",
        json={"document": changed},
        headers={**auth(token), "If-Match": head},
    )
    assert ok.status_code == 200

    # 두 번째 탭이 낡은 head 로 저장을 시도한다
    stale = await client.put(
        f"/v1/projects/{created['id']}",
        json={"document": {**DOC, "tempo": {"bpm": 60}}},
        headers={**auth(token), "If-Match": head},
    )
    assert stale.status_code == 409
    details = stale.json()["error"]["details"]
    assert details["current_document"]["tempo"]["bpm"] == 120
    assert details["current_seq"] == 2


async def test_same_content_does_not_create_version(client, unique_email):
    """자동 저장이 버전을 쌓지 않게 하는 장치 (`SERVER_DATA.md` 4-3)"""
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()

    again = await client.put(
        f"/v1/projects/{created['id']}",
        json={"document": DOC},
        headers={**auth(token), "If-Match": created["head_version_id"]},
    )
    assert again.status_code == 200
    assert again.headers.get("X-Version-Unchanged") == "1"
    assert again.json()["seq"] == 1  # 그대로

    versions = await client.get(
        f"/v1/projects/{created['id']}/versions", headers=auth(token)
    )
    assert len(versions.json()) == 1


async def test_versions_are_immutable_history(client, unique_email):
    """옛 버전을 그대로 읽을 수 있어야 **기기 간 되돌리기**가 성립한다"""
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    v1 = created["head_version_id"]

    updated = await client.put(
        f"/v1/projects/{created['id']}",
        json={"document": {**DOC, "tempo": {"bpm": 140}}},
        headers={**auth(token), "If-Match": v1},
    )
    assert updated.status_code == 200

    old = await client.get(
        f"/v1/projects/{created['id']}/versions/{v1}", headers=auth(token)
    )
    assert old.json()["document"]["tempo"]["bpm"] == 92  # 옛 버전은 안 변했다


async def test_document_must_have_schema_version(client, unique_email):
    """서버는 문서를 해석하지 않지만 **`schemaVersion` 은 요구한다** —
    옛 버전을 읽을 때 어느 마이그레이션을 태울지 알아야 한다"""
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/projects", json={"name": "곡", "document": {"tracks": []}}, headers=auth(token)
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_document"


async def test_project_limit_is_enforced(client, unique_email):
    """무료 한도. **코드가 아니라 DB 에서 센다** (`SERVER.md` 5절)"""
    token = await signup(client, unique_email)
    for i in range(5):
        res = await client.post(
            "/v1/projects", json={"name": f"곡 {i}", "document": DOC}, headers=auth(token)
        )
        assert res.status_code == 201, res.text

    over = await client.post(
        "/v1/projects", json={"name": "여섯째", "document": DOC}, headers=auth(token)
    )
    assert over.status_code == 402
    assert over.json()["error"]["code"] == "project_limit_reached"
    assert over.json()["error"]["details"]["limit"] == 5


async def test_cannot_read_other_users_project(client, unique_email):
    """**소유자만 읽는다.** 존재 자체를 알려주지 않으려고 404 를 준다"""
    owner = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "비밀", "document": DOC}, headers=auth(owner)
        )
    ).json()

    other = await signup(client, f"other-{unique_email}")
    res = await client.get(f"/v1/projects/{created['id']}", headers=auth(other))
    assert res.status_code == 404


async def test_soft_delete_hides_but_keeps(client, unique_email, db):
    """곡을 잃는 것은 되돌릴 수 없다 → 30일 복구 창 (`SERVER_DATA.md` 4-1)"""
    from sqlalchemy import select

    from app.db.models import Project

    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "지울 곡", "document": DOC}, headers=auth(token)
        )
    ).json()

    res = await client.delete(f"/v1/projects/{created['id']}", headers=auth(token))
    assert res.status_code == 204
    gone = await client.get(f"/v1/projects/{created['id']}", headers=auth(token))
    assert gone.status_code == 404

    row = (
        await db.execute(select(Project).where(Project.id == created["id"]))
    ).scalar_one()
    assert row.deleted_at is not None  # 행은 남아 있다


@pytest.mark.parametrize("header", ["not-a-uuid", '"zzz"'])
async def test_invalid_if_match(client, unique_email, header):
    token = await signup(client, unique_email)
    created = (
        await client.post(
            "/v1/projects", json={"name": "곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    res = await client.put(
        f"/v1/projects/{created['id']}",
        json={"document": DOC},
        headers={**auth(token), "If-Match": header},
    )
    assert res.status_code == 422
