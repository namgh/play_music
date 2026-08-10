"""AI 잡 — **접수만 하고 즉시 돌려준다** (`SERVER.md` 2절).

API 프로세스는 절대 잡을 처리하지 않는다. `BackgroundTasks` 로 처리하면 배포할 때
진행 중이던 작업이 사라지고, 실패해도 재시도가 없고, 무엇이 얼마나 밀렸는지 볼
방법이 없다. 그래서 큐는 **테이블**이다 — 잡의 상태가 곧 DB 의 행이라 관측된다.

접수 시점에 한도를 보지만 **사용량은 여기서 안 센다.** 실패한 잡을 과금하면
사용자가 항의하고 우리가 손으로 환불하게 된다. 원장은 워커가 성공했을 때 같은
트랜잭션에서 쓴다 (`SERVER_BILLING.md` 4-1).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import ActiveUser, CurrentUser, Db, client_ip
from app.core import audit
from app.core.errors import Conflict, Forbidden, NotFound
from app.core.idempotency import begin as idem_begin
from app.core.idempotency import complete as idem_complete
from app.core.ratelimit import check as rate_check
from app.db.models import AiJob
from app.services import entitlements
from app.services.projects import get_project

router = APIRouter(prefix="/jobs", tags=["jobs"])

KINDS = ("generate_melody", "generate_accompaniment", "suggest_chords", "arrange")


class JobIn(BaseModel):
    kind: str = Field(pattern="^(generate_melody|generate_accompaniment|suggest_chords|arrange)$")
    project_id: uuid.UUID | None = None
    base_version_id: uuid.UUID | None = None
    request: dict[str, Any] = Field(default_factory=dict)


class JobOut(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    attempts: int
    created_at: datetime
    finished_at: datetime | None = None
    result_version_id: uuid.UUID | None = None
    error: str | None = None


def _out(job: AiJob) -> JobOut:
    return JobOut(
        id=job.id,
        kind=job.kind,
        status=job.status,
        attempts=job.attempts,
        created_at=job.created_at,
        finished_at=job.finished_at,
        result_version_id=job.result_version_id,
        # 내부 오류 문구를 그대로 내보내지 않는다 — 워커가 사용자용으로 정리해 둔 것만
        error=job.error,
    )


@router.post("", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
async def submit(
    body: JobIn,
    request: Request,
    session: Db,
    user: ActiveUser,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobOut:
    await rate_check("ai_submit", str(user.id))

    ent = await entitlements.resolve(session, user.id)
    if not ent.ai_allowed:
        raise Forbidden("구독 상태에서 AI 기능을 쓸 수 없습니다", code="ai_not_allowed")
    await entitlements.require_quota(session, user.id, kind="ai_job", limit_key="ai_monthly")

    if body.project_id is not None:
        await get_project(session, project_id=body.project_id, owner_id=user.id)

    # **재시도가 잡을 두 개 만들지 않게 한다.** 네트워크가 끊기면 클라이언트는
    # 반드시 다시 보낸다 — 그때 같은 잡을 돌려주는 게 유일하게 맞는 동작이다
    replay = None
    if idempotency_key:
        replay = await idem_begin(
            session,
            key=idempotency_key,
            user_id=user.id,
            endpoint="POST /v1/jobs",
            payload=body.model_dump(mode="json"),
        )
        if replay is not None:
            return JobOut(**replay.body)

    job = AiJob(
        user_id=user.id,
        project_id=body.project_id,
        base_version_id=body.base_version_id,
        kind=body.kind,
        request=body.request,
        status="queued",
        idempotency_key=idempotency_key,
    )
    session.add(job)
    await session.flush()

    await audit.record(
        session,
        action="job.submit",
        actor_id=user.id,
        target_type="job",
        target_id=job.id,
        detail={"kind": job.kind},
        ip=client_ip(request),
    )

    out = _out(job)
    if idempotency_key:
        await idem_complete(
            session,
            key=idempotency_key,
            status_code=status.HTTP_202_ACCEPTED,
            body=out.model_dump(mode="json"),
        )
    return out


@router.get("", response_model=list[JobOut])
async def list_jobs(
    session: Db,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[JobOut]:
    stmt = select(AiJob).where(AiJob.user_id == user.id)
    if status_filter:
        stmt = stmt.where(AiJob.status == status_filter)
    rows = (
        await session.execute(stmt.order_by(AiJob.created_at.desc()).limit(limit))
    ).scalars()
    return [_out(j) for j in rows]


@router.get("/{job_id}", response_model=JobOut)
async def get_job(job_id: uuid.UUID, session: Db, user: CurrentUser) -> JobOut:
    job = await session.get(AiJob, job_id)
    if job is None or job.user_id != user.id:
        raise NotFound("작업을 찾을 수 없습니다", code="job_not_found")
    return _out(job)


@router.post("/{job_id}/cancel", response_model=JobOut)
async def cancel(job_id: uuid.UUID, request: Request, session: Db, user: ActiveUser) -> JobOut:
    """대기 중인 것만 취소한다. 실행 중인 잡을 밖에서 죽이면 반쯤 쓴 상태가 남는다 —
    워커가 자기 경계에서 스스로 멈추게 두는 편이 안전하다"""
    job = await session.get(AiJob, job_id)
    if job is None or job.user_id != user.id:
        raise NotFound("작업을 찾을 수 없습니다", code="job_not_found")
    if job.status != "queued":
        raise Conflict(
            "이미 시작된 작업은 취소할 수 없습니다",
            code="job_not_cancelable",
            details={"status": job.status},
        )
    job.status = "canceled"
    await audit.record(
        session,
        action="job.cancel",
        actor_id=user.id,
        target_type="job",
        target_id=job.id,
        ip=client_ip(request),
    )
    return _out(job)
