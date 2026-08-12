"""음색 프리셋 — 테이블과 모델만 있고 **API 가 0개**였다.

"내 음색"이 기기 밖으로 못 나가면 저장 기능이 반쪽이다. 파라미터 JSON 이라
용량이 사실상 0 이고, 그래서 오디오와 달리 스토리지를 안 거치고 링크로 공유된다.
"""

from __future__ import annotations

from tests.test_projects import auth, signup

PARAMS = {"stiffness": 0.31, "damping": 0.87, "polarizationMix": 0.25}


async def _preset(client, token, **kw) -> dict:
    body = {
        "name": "내 스트랫",
        "instrument_id": "electric-guitar",
        "schema_version": 1,
        "params": PARAMS,
        **kw,
    }
    res = await client.post("/v1/presets", json=body, headers=auth(token))
    assert res.status_code == 201, res.text
    return res.json()


async def test_create_and_list(client, unique_email):
    token = await signup(client, unique_email)
    created = await _preset(client, token)
    assert created["is_mine"] is True
    assert created["params"]["stiffness"] == 0.31

    listed = (await client.get("/v1/presets", headers=auth(token))).json()
    assert [p["id"] for p in listed] == [created["id"]]


async def test_filter_by_instrument(client, unique_email):
    """편집 중인 악기의 프리셋만 보여 주려면 필요하다"""
    token = await signup(client, unique_email)
    guitar = await _preset(client, token, instrument_id="electric-guitar")
    await _preset(client, token, instrument_id="grand-piano", name="내 피아노")

    listed = (
        await client.get("/v1/presets?instrument_id=electric-guitar", headers=auth(token))
    ).json()
    assert [p["id"] for p in listed] == [guitar["id"]]


async def test_private_preset_is_not_visible_to_others(client, unique_email):
    token = await signup(client, unique_email)
    preset = await _preset(client, token)

    other = await signup(client, f"other-{unique_email}")
    assert (
        await client.get(f"/v1/presets/{preset['id']}", headers=auth(other))
    ).status_code == 404


async def test_public_preset_is_shareable_by_link(client, unique_email):
    """**링크 하나로 공유되는 것이 요점이다**"""
    token = await signup(client, unique_email)
    preset = await _preset(client, token, is_public=True)

    other = await signup(client, f"other-{unique_email}")
    res = await client.get(f"/v1/presets/{preset['id']}", headers=auth(other))
    assert res.status_code == 200
    assert res.json()["is_mine"] is False
    assert res.json()["params"] == PARAMS


async def test_copy_makes_it_mine_and_private(client, unique_email):
    """**참조로 두지 않는다.** 원본이 바뀌면 내 곡의 소리가 말없이 달라진다"""
    owner = await signup(client, unique_email)
    preset = await _preset(client, owner, is_public=True)

    other = await signup(client, f"other-{unique_email}")
    copy = (
        await client.post(f"/v1/presets/{preset['id']}/copy", headers=auth(other))
    ).json()
    assert copy["is_mine"] is True
    assert copy["is_public"] is False
    assert copy["params"] == PARAMS
    assert copy["id"] != preset["id"]

    # 원본을 지워도 내 사본은 남는다
    await client.delete(f"/v1/presets/{preset['id']}", headers=auth(owner))
    assert (
        await client.get(f"/v1/presets/{copy['id']}", headers=auth(other))
    ).status_code == 200


async def test_params_cannot_be_edited(client, unique_email):
    """**쓰고 있는 곡의 소리가 말없이 달라지면 안 된다** — 소리를 바꾸려면 새 프리셋"""
    token = await signup(client, unique_email)
    preset = await _preset(client, token)

    res = await client.patch(
        f"/v1/presets/{preset['id']}",
        json={"name": "이름만 바꿈", "params": {"stiffness": 0.99}},
        headers=auth(token),
    )
    assert res.status_code == 200
    assert res.json()["name"] == "이름만 바꿈"
    assert res.json()["params"]["stiffness"] == 0.31, "파라미터는 그대로여야 한다"


async def test_cannot_edit_or_delete_someone_elses(client, unique_email):
    owner = await signup(client, unique_email)
    preset = await _preset(client, owner, is_public=True)
    other = await signup(client, f"other-{unique_email}")

    assert (
        await client.patch(
            f"/v1/presets/{preset['id']}", json={"name": "x"}, headers=auth(other)
        )
    ).status_code == 404
    assert (
        await client.delete(f"/v1/presets/{preset['id']}", headers=auth(other))
    ).status_code == 404


async def test_oversized_preset_is_rejected(client, unique_email):
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/presets",
        json={
            "name": "거대",
            "instrument_id": "x",
            "schema_version": 1,
            "params": {f"k{i}": "v" * 100 for i in range(1000)},
        },
        headers=auth(token),
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "preset_too_large"


async def test_schema_version_is_required(client, unique_email):
    """나중에 파라미터 구조가 바뀔 때 **어느 마이그레이션을 태울지** 알아야 한다"""
    token = await signup(client, unique_email)
    res = await client.post(
        "/v1/presets",
        json={"name": "x", "instrument_id": "y", "params": {}},
        headers=auth(token),
    )
    assert res.status_code == 422
