"""내 계정 — 로그인한 뒤 화면을 그리는 데 필요한 전부.

`GET /v1/me` 하나로 **프로필 + 워크스페이스 목록 + 플랜 + 사용량**을 준다.
나눠 놓으면 첫 화면에서 요청을 네 번 하게 되고, 그 네 번이 서로 다른 시점의
상태를 보여 준다. 첫 렌더가 어긋나 보이는 원인이 대개 그것이다.

**회원 탈퇴가 여기 있다.** `SERVER_ACCOUNTS.md` 1절이 정의한 상태기계
(본인 삭제 → `deleted` → 30일 → `purged`)를 실제로 구현한다. 이게 없으면
개인정보 삭제 요청을 처리할 수단이 없어서 서비스 오픈 자체가 성립하지 않는다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from resona.api.deps import ActiveUser, CurrentUser, Db, client_ip
from resona.core import audit
from resona.core.errors import Conflict, Unauthorized
from resona.core.ratelimit import check as rate_check
from resona.core.security import hash_password, verify_password
from resona.db.models import AuthIdentity, Organization, OrgMember, Project, RefreshToken
from resona.services import entitlements, orgs

router = APIRouter(tags=["me"])


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    kind: str
    my_role: str
    plan_code: str
    commercial_license: bool
    limits: dict[str, int | None]
    usage: dict[str, int]


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    status: str
    platform_role: str
    email_verified: bool
    # 로그인 수단. 화면에서 "구글로 연결됨" 같은 것을 보여 주고, 비밀번호가
    # 없는 계정에 "비밀번호 변경"을 띄우지 않으려면 필요하다
    auth_providers: list[str]
    created_at: datetime
    workspaces: list[WorkspaceOut]


@router.get("/me", response_model=MeOut)
async def me(session: Db, user: CurrentUser) -> MeOut:
    """**첫 화면이 필요한 것을 한 번에 준다.**

    정지된 계정도 자기 정보는 볼 수 있어야 한다 — 왜 막혔는지 알아야 하니까
    (`CurrentUser`, `ActiveUser` 아님).
    """
    rows = await orgs.list_for_user(session, user.id)
    providers = sorted(
        (
            await session.execute(
                select(AuthIdentity.provider).where(AuthIdentity.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )

    workspaces: list[WorkspaceOut] = []
    for org, role in rows:
        ent = await entitlements.resolve(session, org.id)
        workspaces.append(
            WorkspaceOut(
                id=org.id,
                slug=org.slug,
                name=org.name,
                kind=org.kind,
                my_role=role,
                plan_code=ent.plan_code,
                commercial_license=ent.commercial_license,
                limits=ent.limits,
                usage={
                    "ai_job": await entitlements.usage_in_period(session, org.id, "ai_job"),
                    "export": await entitlements.usage_in_period(session, org.id, "export"),
                    # 지금 갖고 있는 곡 수 (휴지통 제외) — 목록 화면이 쓴다
                    "projects": await _project_count(session, org.id),
                    # **체험을 몇 칸 썼나.** `limits.songs_total` 과 짝이다.
                    # 이걸 안 보여주면 6번째 곡에서 갑자기 막히고 고장으로 읽힌다
                    "songs_total": await entitlements.usage_total(
                        session, org.id, entitlements.SONG_CREATED
                    ),
                },
            )
        )

    return MeOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        status=user.status,
        platform_role=user.platform_role,
        email_verified=user.email_verified_at is not None,
        auth_providers=providers,
        created_at=user.created_at,
        workspaces=workspaces,
    )


async def _project_count(session: Db, org_id: uuid.UUID) -> int:
    from sqlalchemy import func

    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(Project)
                .where(Project.org_id == org_id, Project.deleted_at.is_(None))
            )
        ).scalar_one()
    )


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=100)


@router.patch("/me", response_model=MeOut)
async def update_profile(
    body: ProfileIn, request: Request, session: Db, user: ActiveUser
) -> MeOut:
    user.display_name = body.display_name
    await audit.record(
        session, action="user.update_profile", actor_id=user.id, ip=client_ip(request)
    )
    return await me(session, user)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(min_length=10, max_length=200)


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordIn, request: Request, session: Db, user: ActiveUser
) -> None:
    """**현재 비밀번호를 반드시 확인한다.**

    액세스 토큰만으로 바꿀 수 있게 하면, 토큰이 한 번 새는 순간 계정이 영구히
    넘어간다 — 원래 주인은 비밀번호가 바뀌어 되찾을 수 없다.
    """
    await rate_check("password_change", str(user.id))

    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.user_id == user.id, AuthIdentity.provider == "password"
            )
        )
    ).scalar_one_or_none()
    if identity is None:
        raise Conflict(
            "비밀번호 로그인을 쓰지 않는 계정입니다. '비밀번호 찾기'로 새로 설정해 주세요",
            code="no_password_identity",
        )

    ok, _ = verify_password(body.current_password, identity.secret_hash)
    if not ok:
        await audit.record(
            session,
            action="user.password_change_failed",
            actor_id=user.id,
            ip=client_ip(request),
        )
        await audit.persist_and_raise(
            session,
            Unauthorized("현재 비밀번호가 올바르지 않습니다", code="invalid_credentials"),
        )

    identity.secret_hash = hash_password(body.new_password)
    # **다른 세션을 전부 끊는다.** 비밀번호를 바꾸는 이유의 절반은 "누가 들어온 것
    # 같다"이고, 그때 옛 세션이 살아 있으면 바꾼 의미가 없다
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await audit.record(
        session, action="user.change_password", actor_id=user.id, ip=client_ip(request)
    )


class DeleteAccountIn(BaseModel):
    # 실수로 누르는 것을 막는다. 비밀번호가 없는 계정(구글 전용)은 생략 가능
    password: str | None = Field(default=None, max_length=200)
    confirm: str = Field(pattern="^삭제합니다$")


@router.post("/me/delete", status_code=status.HTTP_202_ACCEPTED)
async def delete_account(
    body: DeleteAccountIn, request: Request, session: Db, user: ActiveUser
) -> dict[str, Any]:
    """회원 탈퇴 — **바로 지우지 않는다** (`SERVER_ACCOUNTS.md` 1절).

        본인 삭제 → `deleted` → 30일 → `purged`

    30일을 두는 이유는 (1) 실수와 (2) 탈취당한 계정으로 공격자가 삭제를 누르는
    경우다. 그 사이에는 로그인하면 되돌릴 수 있다.

    **혼자 있는 팀은 함께 정리 대상이 되지만, 남이 있는 팀은 건드리지 않는다** —
    한 사람이 나간다고 팀의 곡을 지우면 그건 남의 작업물을 지우는 것이다.
    그래서 마지막 owner 인 팀이 있으면 먼저 정리하라고 막는다.
    """
    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.user_id == user.id, AuthIdentity.provider == "password"
            )
        )
    ).scalar_one_or_none()
    if identity is not None:
        ok, _ = verify_password(body.password or "", identity.secret_hash)
        if not ok:
            raise Unauthorized("비밀번호가 올바르지 않습니다", code="invalid_credentials")

    blocking = await _teams_that_would_be_orphaned(session, user.id)
    if blocking:
        raise Conflict(
            "다른 사람이 있는 워크스페이스의 마지막 소유자입니다. "
            "소유자를 넘기거나 워크스페이스를 정리한 뒤 다시 시도해 주세요",
            code="owns_shared_workspace",
            details={"workspaces": [{"id": str(o.id), "name": o.name} for o in blocking]},
        )

    now = datetime.now(UTC)
    user.status = "deleted"
    user.deleted_at = now
    # **모든 세션을 끊는다.** 삭제를 눌러 놓고 계속 쓰이면 상태가 뒤엉킨다
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    await audit.record(
        session, action="user.request_delete", actor_id=user.id, ip=client_ip(request)
    )
    return {
        "status": "deleted",
        "purge_after_days": 30,
        "note": "30일 안에 로그인하면 되돌릴 수 있습니다",
    }


async def _teams_that_would_be_orphaned(session: Db, user_id: uuid.UUID) -> list[Organization]:
    """내가 마지막 owner 인데 **다른 구성원이 있는** 팀들"""
    from sqlalchemy import func

    rows = (
        await session.execute(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(
                OrgMember.user_id == user_id,
                OrgMember.role == "owner",
                Organization.kind == "team",
                Organization.deleted_at.is_(None),
            )
        )
    ).scalars()

    blocking = []
    for org in rows:
        members = int(
            (
                await session.execute(
                    select(func.count()).select_from(OrgMember).where(OrgMember.org_id == org.id)
                )
            ).scalar_one()
        )
        owners = await orgs.count_owners(session, org.id)
        if members > 1 and owners <= 1:
            blocking.append(org)
    return blocking


@router.post("/me/restore", response_model=MeOut)
async def restore_account(request: Request, session: Db, user: CurrentUser) -> MeOut:
    """유예 기간 안이면 되돌린다. `ActiveUser` 가 아니라 `CurrentUser` 인 이유 —
    삭제 상태에서는 편집이 막히지만 **복구는 되어야 한다**"""
    if user.status != "deleted":
        raise Conflict("삭제 요청 상태가 아닙니다", code="not_deleted")

    user.status = "active"
    user.deleted_at = None
    await audit.record(
        session, action="user.restore", actor_id=user.id, ip=client_ip(request)
    )
    return await me(session, user)
