"""무료 체험 한도와 **부여(grant)** — 결제할 이유를 지키는 코드.

여기가 새면 제품이 공짜가 된다. 두 가지를 지킨다:

1. **누적으로 센다.** 옛 코드는 살아 있는 곡을 셌는데, 그러면 지웠다 새로 만드는
   것으로 무료 체험이 무한이 된다. 실제로 그렇게 동작하고 있었다.
2. **부여는 혜택이지 제약이 아니다.** 베타 3개월 무료·쿠폰·AI 리워드가 전부 부여로
   들어오는데, 합성이 잘못되면 빈 쿠폰 하나가 모든 한도를 열어 버린다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.services import entitlements
from tests.test_projects import DOC, auth, signup

FREE_SONGS = entitlements.DEFAULT_FREE_LIMITS["songs_total"]


async def _make_song(client, token, name="곡"):
    return await client.post(
        "/v1/projects", json={"name": name, "document": DOC}, headers=auth(token)
    )


async def _fill_free_quota(client, token) -> list[dict]:
    songs = []
    for i in range(FREE_SONGS):
        res = await _make_song(client, token, f"곡 {i}")
        assert res.status_code == 201, res.text
        songs.append(res.json())
    return songs


async def _org_of(db, project_id) -> str:
    return (
        await db.execute(
            text("SELECT org_id FROM projects WHERE id = :p"), {"p": project_id}
        )
    ).scalar_one()


async def _grant(db, org_id, *, limits, kind="beta_free", ends_at=None) -> None:
    """부여를 직접 넣는다. **캐시를 반드시 무효화한다** — 안 하면 60초 동안
    옛 판정을 보고 테스트가 거짓으로 통과한다"""
    import json

    await db.execute(
        text(
            "INSERT INTO entitlement_grants (org_id, kind, limits, ends_at) "
            "VALUES (:o, :k, CAST(:l AS jsonb), :e)"
        ),
        {"o": org_id, "k": kind, "l": json.dumps(limits), "e": ends_at},
    )
    await db.commit()
    await entitlements.invalidate(org_id)


async def test_free_trial_counts_cumulatively_not_live_songs(client, unique_email, db):
    """**지웠다 새로 만드는 것으로 우회되면 안 된다.**

    옛 구현은 `deleted_at IS NULL` 인 곡을 셌다. 그래서 5곡을 채운 뒤 하나 지우면
    자리가 나서 무한히 만들 수 있었다 — 무료 체험이 사실상 무제한이었다.
    """
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)

    blocked = await _make_song(client, token, "여섯 번째")
    assert blocked.status_code == 402, blocked.text
    assert blocked.json()["error"]["code"] == "song_limit_reached"

    # 하나 지워서 "자리"를 만든다
    assert (
        await client.delete(f"/v1/projects/{songs[0]['id']}", headers=auth(token))
    ).status_code == 204

    still_blocked = await _make_song(client, token, "자리 났나?")
    assert still_blocked.status_code == 402, "지운다고 체험 횟수가 돌아오면 안 된다"


async def test_restoring_from_trash_does_not_cost_a_slot(client, unique_email, db):
    """복구는 **새 곡이 아니다.** 만들 때 이미 한 칸을 썼다.

    여기서 막으면 "자리를 비우라"는 말을 들은 사용자가 결국 곡을 영구 삭제한다 —
    한도를 지키려다 사용자 작업물을 잃게 만드는 셈이다.
    """
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)

    assert (
        await client.delete(f"/v1/projects/{songs[0]['id']}", headers=auth(token))
    ).status_code == 204

    restored = await client.post(
        f"/v1/projects/{songs[0]['id']}/restore", headers=auth(token)
    )
    assert restored.status_code == 200, restored.text


async def test_duplicate_costs_a_slot(client, unique_email, db):
    """**복제도 새 곡이다.** 안 세면 복제가 한도를 우회하는 길이 된다"""
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)

    res = await client.post(
        f"/v1/projects/{songs[0]['id']}/duplicate", headers=auth(token)
    )
    assert res.status_code == 402, "한도를 다 쓴 뒤에는 복제도 막혀야 한다"


async def test_existing_songs_stay_editable_after_the_limit(client, unique_email, db):
    """한도를 넘어도 **만든 곡은 계속 쓸 수 있다.**

    이건 제품 결정이다 (`SERVER_PAYMENTS.md` 7절) — 만든 걸 못 열게 하면 결제가
    아니라 이탈이 나온다. 새 곡만 막는다.
    """
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)
    assert (await _make_song(client, token, "막힘")).status_code == 402

    opened = await client.get(f"/v1/projects/{songs[0]['id']}", headers=auth(token))
    assert opened.status_code == 200, "기존 곡은 열려야 한다"

    saved = await client.put(
        f"/v1/projects/{songs[0]['id']}",
        json={"document": {**DOC, "bpm": 128}},
        headers={**auth(token), "If-Match": songs[0]["head_version_id"]},
    )
    assert saved.status_code == 200, f"저장이 한도로 막히면 안 된다: {saved.text}"


async def test_a_grant_lifts_the_limit(client, unique_email, db):
    """**베타 3개월 무료가 여기로 들어온다.** 구독이 아니라 부여다"""
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)
    assert (await _make_song(client, token, "막힘")).status_code == 402

    org_id = await _org_of(db, songs[0]["id"])
    await _grant(db, org_id, limits={"songs_total": None})

    freed = await _make_song(client, token, "베타로 열림")
    assert freed.status_code == 201, freed.text


async def test_an_expired_grant_stops_applying(client, unique_email, db):
    """기간이 지난 부여는 **자동으로 꺼진다.** 끄는 잡에 의존하면 잊는 쪽이 기본값이다"""
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)
    org_id = await _org_of(db, songs[0]["id"])

    await _grant(
        db,
        org_id,
        limits={"songs_total": None},
        ends_at=datetime.now(UTC) - timedelta(days=1),
    )

    blocked = await _make_song(client, token, "만료된 혜택")
    assert blocked.status_code == 402, "만료된 부여가 계속 먹으면 공짜가 영구가 된다"


async def test_a_revoked_grant_stops_applying(client, unique_email, db):
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)
    org_id = await _org_of(db, songs[0]["id"])

    await _grant(db, org_id, limits={"songs_total": None})
    assert (await _make_song(client, token, "열림")).status_code == 201

    await db.execute(
        text("UPDATE entitlement_grants SET revoked_at = now() WHERE org_id = :o"),
        {"o": org_id},
    )
    await db.commit()
    await entitlements.invalidate(org_id)

    assert (await _make_song(client, token, "회수됨")).status_code == 402


async def test_an_empty_grant_does_not_unlock_everything(client, unique_email, db):
    """**빈 부여가 모든 한도를 여는 것이 가장 무서운 실수다.**

    "부여에 없는 키 = 무제한"으로 합성하면 `{}` 짜리 쿠폰 하나로 요금제 전체가
    무너진다. 없는 키는 손대지 않는 것이 맞다.
    """
    token = await signup(client, unique_email)
    songs = await _fill_free_quota(client, token)
    org_id = await _org_of(db, songs[0]["id"])

    await _grant(db, org_id, limits={}, kind="coupon")

    assert (await _make_song(client, token, "빈 쿠폰")).status_code == 402


async def test_a_grant_never_narrows_the_plan(client, unique_email, db):
    """부여는 **혜택이지 제약이 아니다.** 플랜보다 낮은 값을 줘도 깎이지 않는다"""
    token = await signup(client, unique_email)
    first = await _make_song(client, token, "첫 곡")
    org_id = await _org_of(db, first.json()["id"])

    # 플랜은 5곡인데 부여가 1곡이라고 말한다
    await _grant(db, org_id, limits={"songs_total": 1}, kind="coupon")

    ent = await entitlements.resolve(db, org_id)
    assert ent.limits["songs_total"] == FREE_SONGS, "부여가 한도를 깎으면 안 된다"


async def test_resolve_reports_which_grants_are_active(client, unique_email, db):
    """화면이 "베타 무료 이용 중"을 보여줄 수 있어야 한다 — 안 보이면 만료일에
    갑자기 막히고, 사용자는 고장으로 받아들인다"""
    token = await signup(client, unique_email)
    first = await _make_song(client, token, "첫 곡")
    org_id = await _org_of(db, first.json()["id"])

    await _grant(db, org_id, limits={"songs_total": None}, kind="beta_free")

    ent = await entitlements.resolve(db, org_id)
    assert "beta_free" in ent.grants


async def test_legacy_plan_key_fails_closed(client, unique_email, db):
    """옛 이름(`projects`)이 남은 플랜 행을 **무제한으로 읽으면 안 된다.**

    한도 키를 개명하는 흔한 사고다 — 새 코드가 새 키를 못 찾고 `None`(무제한)으로
    읽어서, 매출을 지키는 한도가 조용히 사라진다. 열리는 쪽으로 틀리면 안 된다.
    """
    assert entitlements._limit_of({"projects": 3}, "songs_total") == 3
    assert entitlements._limit_of({"songs_total": 7, "projects": 3}, "songs_total") == 7
    assert entitlements._limit_of({}, "songs_total") is None
