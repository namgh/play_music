"""베타 3개월 무료 — **카드 없이** (`SERVER_PAYMENTS.md` 5절).

베타의 목적은 매출이 아니라 학습이다. 결제 벽을 세우면 테스터가 걸러지고, 지금
미해결 위험(브라우저 실행 검증·블라인드 A/B 청취)은 전부 사람이 써봐야 풀린다.

**구독이 아니라 부여로 준다.** 구독 행에 "결제 안 했는데 active" 를 써 넣으면
결제 코드가 그걸 다시 해석해야 한다.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text

from app.services import entitlements
from tests.test_projects import DOC, auth, signup


async def _org_of(db, email) -> str:
    return (
        await db.execute(
            text(
                "SELECT o.id FROM organizations o JOIN org_members m ON m.org_id = o.id "
                "JOIN users u ON u.id = m.user_id WHERE u.email = :e"
            ),
            {"e": email},
        )
    ).scalar_one()


async def test_signup_grants_three_months_free(client, unique_email, db, settings, monkeypatch):
    monkeypatch.setattr(settings, "beta_free_months", 3)
    await signup(client, unique_email)

    org_id = await _org_of(db, unique_email)
    row = (
        await db.execute(
            text(
                "SELECT kind, ends_at, commercial_license, limits FROM entitlement_grants "
                "WHERE org_id = :o"
            ),
            {"o": org_id},
        )
    ).first()

    assert row is not None, "가입 시 베타 이용권이 있어야 한다"
    assert row.kind == "beta_free"
    assert row.commercial_license is True, "베타는 **유료 티어를 그대로 준다**"
    assert row.limits["songs_total"] is None, "무제한이어야 한다"

    months = (row.ends_at.year - datetime.now(UTC).year) * 12 + (
        row.ends_at.month - datetime.now(UTC).month
    )
    assert months == 3


async def test_beta_user_is_not_stopped_at_five_songs(
    client, unique_email, settings, monkeypatch
):
    monkeypatch.setattr(settings, "beta_free_months", 3)
    token = await signup(client, unique_email)
    for i in range(7):
        res = await client.post(
            "/v1/projects", json={"name": f"곡 {i}", "document": DOC}, headers=auth(token)
        )
        assert res.status_code == 201, f"{i}번째에서 막혔다: {res.text}"


async def test_beta_user_gets_the_commercial_license(
    client, unique_email, db, settings, monkeypatch
):
    """상업 이용권이 유료 차별화 지점이라, 베타에서 그걸 줘야 "돈 낼 만한가"를
    사용자가 실제로 판단할 수 있다"""
    monkeypatch.setattr(settings, "beta_free_months", 3)
    await signup(client, unique_email)
    ent = await entitlements.resolve(db, await _org_of(db, unique_email))
    assert ent.commercial_license is True
    assert "beta_free" in ent.grants


async def test_when_beta_is_over_new_signups_get_nothing(
    client, unique_email, db, settings, monkeypatch
):
    """**베타를 끄는 것은 설정 하나다.** 이미 받은 사람의 부여는 만료일까지 산다"""
    monkeypatch.setattr(settings, "beta_free_months", 0)
    await signup(client, unique_email)
    count = (
        await db.execute(
            text("SELECT count(*) FROM entitlement_grants WHERE org_id = :o"),
            {"o": await _org_of(db, unique_email)},
        )
    ).scalar_one()
    assert count == 0


async def test_expired_beta_falls_back_without_deleting_songs(
    client, unique_email, db, settings, monkeypatch
):
    """만료되면 **새 곡만 막힌다. 만든 곡은 그대로다.**

    만든 걸 못 열게 하면 결제가 아니라 이탈이 나온다.
    """
    monkeypatch.setattr(settings, "beta_free_months", 3)
    token = await signup(client, unique_email)
    made = []
    for i in range(7):
        res = await client.post(
            "/v1/projects", json={"name": f"곡 {i}", "document": DOC}, headers=auth(token)
        )
        made.append(res.json()["id"])

    org_id = await _org_of(db, unique_email)
    await db.execute(
        text("UPDATE entitlement_grants SET ends_at = now() - interval '1 day' WHERE org_id = :o"),
        {"o": org_id},
    )
    await db.commit()
    await entitlements.invalidate(org_id)

    blocked = await client.post(
        "/v1/projects", json={"name": "만료 후", "document": DOC}, headers=auth(token)
    )
    assert blocked.status_code == 402, "만료됐으면 새 곡은 막혀야 한다"

    for pid in made:
        assert (
            await client.get(f"/v1/projects/{pid}", headers=auth(token))
        ).status_code == 200, "만든 곡은 계속 열려야 한다"
