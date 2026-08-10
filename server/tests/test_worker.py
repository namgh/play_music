"""잡 큐 — **여러 워커가 붙어도 안전한가** (`SERVER.md` 2절).

여기가 멀티프로세스 설계의 핵심이라 진짜 동시성으로 본다. 워커를 모사하지 않고
실제 `Worker._tick()` 을 여러 개 동시에 돌린다 — `SKIP LOCKED` 가 없으면 여기서
같은 잡을 두 번 집는 게 바로 드러난다.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select, text

from app.db.models import AiJob, UsageEvent
from app.worker.main import Worker
from tests.test_projects import auth, signup


@pytest.fixture(autouse=True)
async def clean_jobs(app, db):  # app 이 엔진을 먼저 띄운다
    """**이전 테스트가 남긴 잡을 비운다.**

    큐는 "가장 오래된 queued" 를 집는다. 안 비우면 워커가 남의 잡을 집고, 그러면
    테스트가 통과/실패를 엉뚱하게 판정한다 — 실제로 여기서 한 번 속았다.
    """
    # 큐에 남은 것만 지운다. 끝난 잡은 **사용량 원장이 참조하고 있어서** 지워지지
    # 않는다 — 그건 버그가 아니라 "원장은 지우지 않는다"는 설계다
    await db.execute(text("DELETE FROM ai_jobs WHERE status IN ('queued','running')"))
    await db.commit()


async def _submit(client, token, kind: str = "generate_melody", **kw):
    res = await client.post(
        "/v1/jobs", json={"kind": kind, "request": {"bars": 8}, **kw}, headers=auth(token)
    )
    assert res.status_code == 202, res.text
    return res.json()


async def test_submit_returns_immediately_as_queued(client, unique_email):
    """접수만 하고 돌려준다. API 프로세스가 잡을 처리하면 배포 때 통째로 사라진다"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)
    assert job["status"] == "queued"
    assert job["attempts"] == 0


async def test_idempotency_key_returns_same_job(client, unique_email):
    """네트워크가 끊겨 재시도해도 **잡이 두 개 생기지 않는다**"""
    token = await signup(client, unique_email)
    key = f"idem-{uuid.uuid4().hex}"
    body = {"kind": "generate_melody", "request": {"bars": 8}}

    first = await client.post(
        "/v1/jobs", json=body, headers={**auth(token), "Idempotency-Key": key}
    )
    second = await client.post(
        "/v1/jobs", json=body, headers={**auth(token), "Idempotency-Key": key}
    )
    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]


async def test_same_key_different_body_is_rejected(client, unique_email):
    """같은 키에 다른 본문은 재시도가 아니라 **클라이언트 버그**다"""
    token = await signup(client, unique_email)
    key = f"idem-{uuid.uuid4().hex}"
    await client.post(
        "/v1/jobs",
        json={"kind": "generate_melody", "request": {"bars": 8}},
        headers={**auth(token), "Idempotency-Key": key},
    )
    res = await client.post(
        "/v1/jobs",
        json={"kind": "generate_melody", "request": {"bars": 16}},
        headers={**auth(token), "Idempotency-Key": key},
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "idempotency_key_reused"


async def test_worker_processes_job_and_records_usage(client, unique_email, db):
    """**성공한 잡과 사용량이 같은 트랜잭션이다.** 나누면 "생성은 됐는데 카운트가
    안 된" 경우가 생기고, 그건 사후에 찾을 방법이 없다"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    assert await Worker()._tick() is True

    row = (await db.execute(select(AiJob).where(AiJob.id == job["id"]))).scalar_one()
    assert row.status == "succeeded"
    assert row.attempts == 1
    assert row.finished_at is not None

    usage = (
        await db.execute(select(UsageEvent).where(UsageEvent.job_id == uuid.UUID(job["id"])))
    ).scalars().all()
    assert len(usage) == 1


async def test_two_workers_never_claim_the_same_job(client, unique_email, db):
    """**SKIP LOCKED 가 하는 일.** 잡 하나에 워커 넷이 동시에 달려들어도
    한 번만 처리돼야 한다"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    results = await asyncio.gather(*[Worker()._tick() for _ in range(4)])
    assert sum(results) == 1, "정확히 한 워커만 잡아야 한다"

    row = (await db.execute(select(AiJob).where(AiJob.id == job["id"]))).scalar_one()
    assert row.attempts == 1, "재시도 카운트가 워커 수만큼 올라가면 안 된다"


async def test_expired_lease_is_reclaimed(client, unique_email, db):
    """워커가 죽으면 임대가 만료되고 **다른 워커가 이어받는다**.
    이게 없으면 프로세스 하나가 죽을 때 그 잡이 영원히 running 으로 남는다"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    # 죽은 워커를 흉내낸다: running 인데 임대가 이미 지났다
    await db.execute(
        text(
            "UPDATE ai_jobs SET status='running', locked_by='dead-worker', "
            "locked_until = now() - interval '1 minute' WHERE id = :id"
        ),
        {"id": job["id"]},
    )
    await db.commit()

    assert await Worker()._tick() is True
    row = (await db.execute(select(AiJob).where(AiJob.id == job["id"]))).scalar_one()
    assert row.status == "succeeded"


async def test_failed_job_retries_then_gives_up(client, unique_email, db, monkeypatch):
    """실패는 **재시도하고, 결국 포기한다.** 무한 재시도는 큐를 막고
    무한 과금 위험도 만든다"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    async def boom(self, *a, **kw):
        raise RuntimeError("모델 호출 실패")

    monkeypatch.setattr(Worker, "_handle", boom)

    for expected in range(1, 4):
        await db.execute(
            text("UPDATE ai_jobs SET run_after = now() - interval '1 second' WHERE id=:id"),
            {"id": job["id"]},
        )
        await db.commit()
        assert await Worker()._tick() is True
        row = (await db.execute(select(AiJob).where(AiJob.id == job["id"]))).scalar_one()
        await db.refresh(row)
        assert row.attempts == expected

    assert row.status == "failed"
    assert "모델 호출 실패" in (row.error or "")

    # **실패한 잡은 과금하지 않는다**
    usage = (
        await db.execute(select(UsageEvent).where(UsageEvent.job_id == uuid.UUID(job["id"])))
    ).scalars().all()
    assert usage == []


async def test_shutdown_releases_lease(client, unique_email, db):
    """배포할 때 잡이 5분씩 멈추지 않게 **임대를 반납하고 죽는다**"""
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    worker = Worker()
    async with __import__("app.db.session", fromlist=["session_scope"]).session_scope() as s:
        from app.worker.main import CLAIM_SQL, WORKER_ID

        row = (await s.execute(CLAIM_SQL, {"worker": WORKER_ID, "lease": 300})).first()
    worker._current = row[0]

    await worker.release_current()
    got = (await db.execute(select(AiJob).where(AiJob.id == job["id"]))).scalar_one()
    await db.refresh(got)
    assert got.status == "queued"
    assert got.locked_by is None


async def test_cancel_only_before_start(client, unique_email):
    token = await signup(client, unique_email)
    job = await _submit(client, token)

    ok = await client.post(f"/v1/jobs/{job['id']}/cancel", headers=auth(token))
    assert ok.status_code == 200
    assert ok.json()["status"] == "canceled"

    again = await client.post(f"/v1/jobs/{job['id']}/cancel", headers=auth(token))
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "job_not_cancelable"


async def test_canceled_job_is_not_picked_up(client, unique_email):
    token = await signup(client, unique_email)
    job = await _submit(client, token)
    await client.post(f"/v1/jobs/{job['id']}/cancel", headers=auth(token))
    assert await Worker()._tick() is False


async def test_cannot_see_other_users_job(client, unique_email):
    token = await signup(client, unique_email)
    job = await _submit(client, token)
    other = await signup(client, f"other-{unique_email}")
    res = await client.get(f"/v1/jobs/{job['id']}", headers=auth(other))
    assert res.status_code == 404


@pytest.mark.parametrize("kind", ["unknown_kind", "", "drop table"])
async def test_unknown_kind_rejected(client, unique_email, kind):
    token = await signup(client, unique_email)
    res = await client.post("/v1/jobs", json={"kind": kind}, headers=auth(token))
    assert res.status_code == 422
