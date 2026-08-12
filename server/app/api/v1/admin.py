"""어드민 — `SERVER_ACCOUNTS.md` 5절.

**모든 엔드포인트가 감사 로그를 남긴다.** 잊어버리는 것을 사람이 조심하는 것으로
막지 않고, 라우터 등록 시점에 코드가 확인한다 (`assert_all_audited`).

그리고 **여기에 "남의 프로젝트 열기" API 는 없다.** 필요하면 대리 접속을 통해서만
간다 — 동의·시간제한·배너·기록이 붙은 경로다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import Db, client_ip, require_platform_role
from app.core import audit
from app.core.errors import NotFound, Unprocessable
from app.db.models import (
    AuditLog,
    ImpersonationSession,
    Organization,
    OrgMember,
    Project,
    Subscription,
    UsageEvent,
    User,
)
from app.services import entitlements, orgs

router = APIRouter(prefix="/admin", tags=["admin"])

Support = Annotated[User, Depends(require_platform_role("support", "admin", "owner"))]
Admin = Annotated[User, Depends(require_platform_role("admin", "owner"))]
Owner = Annotated[User, Depends(require_platform_role("owner"))]


class UserRow(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    status: str
    platform_role: str
    created_at: datetime
    last_seen_at: datetime | None
    plan_code: str | None
    project_count: int


@router.get("/users", response_model=list[UserRow])
async def search_users(
    request: Request,
    session: Db,
    operator: Support,
    q: Annotated[str | None, Query(max_length=320)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> list[UserRow]:
    # **조직 마이그레이션 이후 구독은 조직에 붙는다.** 사용자의 플랜은 그 사람의
    # 개인 워크스페이스 구독이다 — 예전 조인(`Subscription.user_id`)이 그대로 남아
    # 있어서 이 엔드포인트는 500 이었고, 테스트가 없어서 아무도 몰랐다
    personal = (
        select(OrgMember.user_id.label("uid"), Subscription.plan_code.label("plan"))
        .join(Organization, Organization.id == OrgMember.org_id)
        .join(Subscription, Subscription.org_id == Organization.id, isouter=True)
        .where(Organization.kind == "personal")
        .subquery()
    )
    stmt = (
        select(
            User,
            personal.c.plan,
            func.count(Project.id).filter(Project.deleted_at.is_(None)).label("projects"),
        )
        .join(personal, personal.c.uid == User.id, isouter=True)
        .join(Project, Project.owner_id == User.id, isouter=True)
        .group_by(User.id, personal.c.plan)
        .order_by(User.created_at.desc())
        .limit(limit)
    )
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q.lower()}%"))

    rows = (await session.execute(stmt)).all()
    await audit.record(
        session,
        action="admin.users.search",
        actor_id=operator.id,
        detail={"query": q, "count": len(rows)},
        ip=client_ip(request),
    )
    return [
        UserRow(
            id=u.id,
            email=u.email,
            display_name=u.display_name,
            status=u.status,
            platform_role=u.platform_role,
            created_at=u.created_at,
            last_seen_at=u.last_seen_at,
            plan_code=plan,
            project_count=projects,
        )
        for u, plan, projects in rows
    ]


class UsageOut(BaseModel):
    user_id: uuid.UUID
    plan_code: str
    status: str
    limits: dict[str, int]
    used: dict[str, int]


@router.get("/users/{user_id}/usage", response_model=UsageOut)
async def user_usage(
    user_id: uuid.UUID, request: Request, session: Db, operator: Support
) -> UsageOut:
    """**사용량은 보되 곡 내용은 보지 않는다**"""
    target = await session.get(User, user_id)
    if target is None:
        raise NotFound("사용자를 찾을 수 없습니다", code="user_not_found")

    # 사용량도 **조직 단위**다. 사용자의 것은 그 사람의 개인 워크스페이스 것을 본다 —
    # 팀 사용량은 그 팀의 owner 가 볼 일이지 플랫폼 운영자가 들여다볼 것이 아니다
    org = await orgs.personal_org(session, user_id)
    ent = await entitlements.resolve(session, org.id)
    kinds = (
        await session.execute(
            select(UsageEvent.kind).where(UsageEvent.org_id == org.id).group_by(UsageEvent.kind)
        )
    ).scalars()
    used = {k: await entitlements.usage_in_period(session, org.id, k) for k in kinds}

    await audit.record(
        session,
        action="admin.users.usage",
        actor_id=operator.id,
        target_type="user",
        target_id=user_id,
        ip=client_ip(request),
    )
    return UsageOut(
        user_id=user_id,
        plan_code=ent.plan_code,
        status=ent.status,
        limits=ent.limits,
        used=used,
    )


class StatusIn(BaseModel):
    status: str = Field(pattern="^(active|suspended)$")
    reason: str = Field(min_length=1, max_length=500)


@router.post("/users/{user_id}/status", response_model=UserRow)
async def set_status(
    user_id: uuid.UUID, body: StatusIn, request: Request, session: Db, operator: Admin
) -> Any:
    target = await session.get(User, user_id)
    if target is None:
        raise NotFound("사용자를 찾을 수 없습니다", code="user_not_found")
    if target.platform_role in ("admin", "owner") and operator.platform_role != "owner":
        raise Unprocessable("이 계정은 owner 만 변경할 수 있습니다", code="insufficient_role")

    target.status = body.status
    await audit.record(
        session,
        action="admin.users.status",
        actor_id=operator.id,
        target_type="user",
        target_id=user_id,
        detail={"status": body.status, "reason": body.reason},
        ip=client_ip(request),
    )
    return UserRow(
        id=target.id,
        email=target.email,
        display_name=target.display_name,
        status=target.status,
        platform_role=target.platform_role,
        created_at=target.created_at,
        last_seen_at=target.last_seen_at,
        plan_code=None,
        project_count=0,
    )


class ImpersonateIn(BaseModel):
    reason: str = Field(min_length=5, max_length=500)  # 빈 사유를 못 쓰게
    ticket_ref: str | None = Field(default=None, max_length=100)
    minutes: int = Field(default=30, ge=1, le=120)
    write_allowed: bool = False


@router.post("/users/{user_id}/impersonate")
async def impersonate(
    user_id: uuid.UUID, body: ImpersonateIn, request: Request, session: Db, operator: Support
) -> dict[str, Any]:
    """대리 접속 세션을 연다 (`SERVER_ACCOUNTS.md` 4절).

    여기서는 **세션 기록만** 만든다. 실제 토큰 발급은 동의 확인을 거친 뒤이며,
    화면에는 항상 배너가 뜬다. 사유는 필수이고 감사 로그에 남는다.
    """
    target = await session.get(User, user_id)
    if target is None:
        raise NotFound("사용자를 찾을 수 없습니다", code="user_not_found")

    session_row = ImpersonationSession(
        operator_id=operator.id,
        subject_id=user_id,
        reason=body.reason,
        ticket_ref=body.ticket_ref,
        write_allowed=body.write_allowed,
        expires_at=datetime.now(UTC) + timedelta(minutes=body.minutes),
    )
    session.add(session_row)
    await session.flush()

    await audit.record(
        session,
        action="admin.impersonate.start",
        actor_id=operator.id,
        on_behalf_of=user_id,
        target_type="user",
        target_id=user_id,
        detail={"reason": body.reason, "write": body.write_allowed},
        ip=client_ip(request),
    )
    return {
        "session_id": str(session_row.id),
        "expires_at": session_row.expires_at.isoformat(),
        "write_allowed": body.write_allowed,
        # 사용자에게도 알린다 — 워커가 메일을 보낸다
        "notice": "대리 접속이 시작됐습니다. 사용자에게 통지됩니다",
    }


class AuditRow(BaseModel):
    id: int
    actor_id: uuid.UUID | None
    on_behalf_of: uuid.UUID | None
    action: str
    target_type: str | None
    target_id: uuid.UUID | None
    occurred_at: datetime


@router.get("/audit", response_model=list[AuditRow])
async def read_audit(
    session: Db,
    operator: Admin,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    action: str | None = None,
) -> list[AuditRow]:
    """**어드민 자신의 행위도 여기 나온다**"""
    stmt = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    rows = (await session.execute(stmt)).scalars()
    return [
        AuditRow(
            id=a.id,
            actor_id=a.actor_id,
            on_behalf_of=a.on_behalf_of,
            action=a.action,
            target_type=a.target_type,
            target_id=a.target_id,
            occurred_at=a.occurred_at,
        )
        for a in rows
    ]


class RoleIn(BaseModel):
    platform_role: str = Field(pattern="^(user|support|admin|owner)$")


@router.post("/users/{user_id}/role", response_model=UserRow)
async def set_role(
    user_id: uuid.UUID, body: RoleIn, request: Request, session: Db, operator: Owner
) -> Any:
    """**owner 만.** 권한 상승은 가장 위험한 조작이다"""
    target = await session.get(User, user_id)
    if target is None:
        raise NotFound("사용자를 찾을 수 없습니다", code="user_not_found")
    before = target.platform_role
    target.platform_role = body.platform_role
    await audit.record(
        session,
        action="admin.users.role",
        actor_id=operator.id,
        target_type="user",
        target_id=user_id,
        detail={"from": before, "to": body.platform_role},
        ip=client_ip(request),
    )
    return UserRow(
        id=target.id,
        email=target.email,
        display_name=target.display_name,
        status=target.status,
        platform_role=target.platform_role,
        created_at=target.created_at,
        last_seen_at=target.last_seen_at,
        plan_code=None,
        project_count=0,
    )
