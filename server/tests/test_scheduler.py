"""스케줄러 — **각 작업이 실제로 도는지**를 본다.

이 파일이 없어서 사고가 났다. 락 함수 인자 개수가 안 맞아 6개 정리 작업이 배포
첫날부터 전부 `TypeError` 로 죽고 있었는데, `except Exception: log.exception(...)`
이 삼켜서 테스트 105개가 그대로 통과했다. 게다가 조직 마이그레이션 이후 SQL 이
드리프트돼 컬럼·테이블 이름이 셋이나 틀렸다.

그래서 여기서는 **"예외가 안 났다"로 만족하지 않는다.** 각 작업이 DB 를 실제로
바꿨는지 행으로 확인한다. 예외를 삼키는 코드 위에서는 그것만이 유효한 검증이다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from resona.core import redis as r
from resona.scheduler import main as sched


@pytest.fixture(autouse=True)
async def ready(app):
    """`app` 이 엔진·Redis 를 띄운다. 락 키도 비운다"""
    yield


async def _one(db, sql: str, **params):
    return (await db.execute(text(sql), params)).first()


async def test_every_task_actually_runs(db):
    """**전부 한 번씩 돌려 본다.**

    스케줄러 루프가 예외를 삼키므로, 여기서는 `_with_lock` 을 직접 불러
    예외가 그대로 올라오게 한다 — 죽으면 테스트가 죽어야 한다.
    """
    for name, _period, fn in sched.TASKS:
        await sched._with_lock(f"test-{name}-{uuid.uuid4().hex[:6]}", 30, fn())


async def test_lock_prevents_double_run(db):
    """스케줄러가 둘 떠도 한 번만 돈다"""
    calls = []

    async def work():
        calls.append(1)

    key = f"dup-{uuid.uuid4().hex[:8]}"
    # 락을 미리 남이 잡고 있는 상태를 만든다
    assert await r.acquire_lock(r.key("sched", key), "someone-else", 30_000)

    await sched._with_lock(key, 30, work())
    assert calls == [], "이미 잡힌 락이면 작업이 돌면 안 된다"

    await r.core().delete(r.key("sched", key))
    await sched._with_lock(key, 30, work())
    assert calls == [1], "락이 풀리면 돌아야 한다"


async def test_lock_is_released_after_run(db):
    async def work():
        pass

    key = f"rel-{uuid.uuid4().hex[:8]}"
    await sched._with_lock(key, 30, work())
    assert await r.core().get(r.key("sched", key)) is None


async def test_lock_is_released_even_if_the_task_raises(db):
    """작업이 터져도 락을 물고 죽으면 **그 작업은 TTL 동안 영영 안 돈다**"""

    async def boom():
        raise RuntimeError("작업 실패")

    key = f"boom-{uuid.uuid4().hex[:8]}"
    with pytest.raises(RuntimeError):
        await sched._with_lock(key, 30, boom())
    assert await r.core().get(r.key("sched", key)) is None


async def test_purge_soft_deleted_removes_only_expired(client, unique_email, db):
    """30일 유예가 지난 것만 지운다. **아직 유예 중인 곡을 지우면 복구가 불가능하다**"""
    from tests.test_projects import DOC, auth, signup

    token = await signup(client, unique_email)
    fresh = (
        await client.post(
            "/v1/projects", json={"name": "방금 지운 곡", "document": DOC}, headers=auth(token)
        )
    ).json()
    old = (
        await client.post(
            "/v1/projects", json={"name": "오래 전 지운 곡", "document": DOC}, headers=auth(token)
        )
    ).json()

    await client.delete(f"/v1/projects/{fresh['id']}", headers=auth(token))
    await client.delete(f"/v1/projects/{old['id']}", headers=auth(token))
    await db.execute(
        text("UPDATE projects SET deleted_at = :old WHERE id = :id"),
        {"old": datetime.now(UTC) - timedelta(days=31), "id": old["id"]},
    )
    await db.commit()

    await sched.purge_soft_deleted()

    assert await _one(db, "SELECT 1 FROM projects WHERE id = :id", id=old["id"]) is None
    assert await _one(db, "SELECT 1 FROM projects WHERE id = :id", id=fresh["id"]) is not None


async def test_sweep_pending_assets_removes_only_stale(client, unique_email, db):
    """올리다 만 행만 치운다. **업로드 중인 행을 지우면 정상 업로드가 깨진다**"""
    import hashlib

    from tests.test_projects import auth, signup

    token = await signup(client, unique_email)
    body = {
        "kind": "export",
        "content_type": "audio/wav",
        "size_bytes": 1024,
        "sha256": hashlib.sha256(b"x").hexdigest(),
    }
    stale = (await client.post("/v1/assets", json=body, headers=auth(token))).json()
    live = (await client.post("/v1/assets", json=body, headers=auth(token))).json()

    await db.execute(
        text("UPDATE assets SET created_at = :old WHERE id = :id"),
        {"old": datetime.now(UTC) - timedelta(hours=7), "id": stale["id"]},
    )
    await db.commit()

    await sched.sweep_pending_assets()

    assert await _one(db, "SELECT 1 FROM assets WHERE id = :id", id=stale["id"]) is None
    assert await _one(db, "SELECT 1 FROM assets WHERE id = :id", id=live["id"]) is not None


async def test_roll_up_usage_folds_last_month(client, unique_email, db):
    """**조직 단위로 접는다.** 여기서 컬럼 이름이 틀려 있었다 (user_id → org_id)"""
    from sqlalchemy import select

    from resona.db.models import Organization, OrgMember, User
    from tests.test_projects import signup

    await signup(client, unique_email)
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    org = (
        await db.execute(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user.id)
        )
    ).scalar_one()

    last_month = datetime.now(UTC).replace(day=1) - timedelta(days=5)
    for _ in range(3):
        await db.execute(
            text(
                "INSERT INTO usage_events (org_id, user_id, kind, quantity, occurred_at) "
                "VALUES (:o, :u, 'ai_job', 1, :t)"
            ),
            {"o": org.id, "u": user.id, "t": last_month},
        )
    await db.commit()

    await sched.roll_up_usage()

    row = await _one(
        db,
        "SELECT quantity, period_end FROM usage_rollups "
        "WHERE org_id = :o AND kind = 'ai_job' AND period_start = :p",
        o=org.id,
        p=last_month.date().replace(day=1),
    )
    assert row is not None, "롤업이 만들어지지 않았다"
    assert row[0] == 3
    assert row[1] is not None, "period_end 는 NOT NULL 이다 — 빠지면 INSERT 가 터진다"

    # **두 번 돌려도 같아야 한다** (스케줄러는 매 주기 다시 돈다)
    await sched.roll_up_usage()
    again = await _one(
        db,
        "SELECT quantity FROM usage_rollups WHERE org_id = :o AND kind = 'ai_job' "
        "AND period_start = :p",
        o=org.id,
        p=last_month.date().replace(day=1),
    )
    assert again[0] == 3


async def test_roll_up_does_not_fold_the_current_month(client, unique_email, db):
    """이번 달을 접으면 **아직 늘어날 사용량이 롤업에 굳는다**"""
    from sqlalchemy import select

    from resona.db.models import Organization, OrgMember, User
    from tests.test_projects import signup

    await signup(client, unique_email)
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    org = (
        await db.execute(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user.id)
        )
    ).scalar_one()
    await db.execute(
        text(
            "INSERT INTO usage_events (org_id, user_id, kind, quantity) "
            "VALUES (:o, :u, 'export', 1)"
        ),
        {"o": org.id, "u": user.id},
    )
    await db.commit()

    await sched.roll_up_usage()
    row = await _one(
        db,
        "SELECT 1 FROM usage_rollups WHERE org_id = :o AND kind = 'export' AND period_start = :p",
        o=org.id,
        p=datetime.now(UTC).date().replace(day=1),
    )
    assert row is None


async def test_expire_impersonations_closes_overdue_sessions(client, unique_email, db):
    """**담당자가 '종료'를 누르는 것에 의존하지 않는다** — 누르는 것을 잊는 쪽이 기본값"""
    from sqlalchemy import select

    from resona.db.models import User
    from tests.test_projects import signup

    await signup(client, unique_email)
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    await db.execute(
        text(
            "INSERT INTO impersonation_sessions "
            "  (operator_id, subject_id, reason, write_allowed, expires_at) "
            # ⚠ **시각은 DB 시계로 쓴다.** 파이썬(호스트) 시계로 쓰면 쓸어내는 쪽은
            # Postgres(컨테이너) 시계로 비교하므로, 둘이 1분 이상 어긋나면 그것만으로
            # 실패한다. Docker Desktop 은 호스트가 자다 깬 직후 VM 시계가 뒤처진다 —
            # 새벽에 돌린 예약 점검에서 실제로 이 테스트가 한 번 실패했다
            "VALUES (:op, :sub, '만료 테스트', false, now() - interval '1 minute')"
        ),
        {"op": user.id, "sub": user.id},
    )
    await db.commit()

    await sched.expire_impersonations()

    row = await _one(
        db,
        "SELECT ended_at FROM impersonation_sessions WHERE subject_id = :s "
        "ORDER BY started_at DESC LIMIT 1",
        s=user.id,
    )
    assert row[0] is not None, "만료된 대리 접속이 안 닫혔다"


async def test_sweep_expired_tokens_removes_expired_only(client, unique_email, db):
    from sqlalchemy import select

    from resona.db.models import User
    from tests.test_projects import signup

    await signup(client, unique_email)
    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()

    await db.execute(
        text(
            "INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) "
            # 위와 같은 이유로 DB 시계를 쓴다
            "VALUES (:u, 'verify', :h, now() - interval '1 hour')"
        ),
        {"u": user.id, "h": f"expired-{uuid.uuid4().hex}"},
    )
    live_hash = f"live-{uuid.uuid4().hex}"
    await db.execute(
        text(
            "INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) "
            "VALUES (:u, 'verify', :h, :exp)"
        ),
        {"u": user.id, "h": live_hash, "exp": datetime.now(UTC) + timedelta(hours=1)},
    )
    await db.commit()

    await sched.sweep_expired_tokens()

    assert (
        await _one(db, "SELECT 1 FROM email_tokens WHERE token_hash = :h", h=live_hash)
    ) is not None
    assert (
        await _one(
            db,
            "SELECT count(*) FROM email_tokens WHERE user_id = :u AND expires_at < now()",
            u=user.id,
        )
    )[0] == 0


async def test_trim_audit_log_keeps_recent(client, unique_email, db):
    """여기서 테이블 이름이 틀려 있었다 (audit_logs → audit_log)"""
    before = (await _one(db, "SELECT count(*) FROM audit_log"))[0]
    await sched.trim_audit_log()
    after = (await _one(db, "SELECT count(*) FROM audit_log"))[0]
    assert after == before, "보존 기간 안의 감사 로그를 지우면 안 된다"
