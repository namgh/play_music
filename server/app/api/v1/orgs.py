"""워크스페이스(조직) — 목록·생성·구성원·초대.

**개인 계정도 1인 조직이다.** 가입하면 `kind='personal'` 조직이 자동으로 생기고,
`org_id` 를 안 주는 요청은 전부 그리로 간다. 그래서 처음 쓰는 사람은 워크스페이스라는
개념을 몰라도 곡을 만들 수 있고, 팀이 필요해지면 조직을 하나 더 만들면 된다.

권한은 `org_members.role` 에만 의존한다. 플랫폼 역할(admin 등)로는 남의 워크스페이스에
들어갈 수 없다 (`SERVER_ACCOUNTS.md` 3절 — 2축 권한).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from app.api.deps import ActiveUser, CurrentUser, Db, client_ip
from app.core import audit
from app.core.errors import Conflict, Forbidden, NotFound, Unprocessable
from app.core.ratelimit import check as rate_check
from app.core.security import hash_token, new_opaque_token
from app.db.models import Organization, OrgInvite, OrgMember, Subscription, User
from app.services import entitlements, mail, orgs

router = APIRouter(prefix="/orgs", tags=["orgs"])

INVITE_TTL_HOURS = 72


class OrgOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    kind: str
    my_role: str
    member_count: int = 0


class CreateOrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str
    joined_at: datetime


class InviteIn(BaseModel):
    email: EmailStr
    role: str = Field(default="editor", pattern="^(admin|editor|viewer)$")


class RoleIn(BaseModel):
    role: str = Field(pattern="^(owner|admin|editor|viewer)$")


@router.get("", response_model=list[OrgOut])
async def list_orgs(session: Db, user: CurrentUser) -> list[OrgOut]:
    """내가 속한 워크스페이스. **개인이 항상 맨 앞에 온다**"""
    rows = await orgs.list_for_user(session, user.id)
    return [
        OrgOut(id=o.id, slug=o.slug, name=o.name, kind=o.kind, my_role=role)
        for o, role in rows
    ]


@router.post("", response_model=OrgOut, status_code=status.HTTP_201_CREATED)
async def create_org(
    body: CreateOrgIn, request: Request, session: Db, user: ActiveUser
) -> OrgOut:
    await rate_check("org_create", str(user.id))
    org = await orgs.create_team(session, user=user, name=body.name)
    # 새 팀은 무료로 시작한다. 과금 단위가 조직이라 구독도 조직에 붙는다
    session.add(Subscription(org_id=org.id, plan_code="free", status="active"))
    await audit.record(
        session,
        action="org.create",
        actor_id=user.id,
        target_type="org",
        target_id=org.id,
        ip=client_ip(request),
    )
    return OrgOut(id=org.id, slug=org.slug, name=org.name, kind=org.kind, my_role="owner")


@router.get("/{org_id}/members", response_model=list[MemberOut])
async def list_members(org_id: uuid.UUID, session: Db, user: CurrentUser) -> list[MemberOut]:
    await orgs.require_member(session, org_id=org_id, user_id=user.id)
    rows = (
        await session.execute(
            select(OrgMember, User)
            .join(User, User.id == OrgMember.user_id)
            .where(OrgMember.org_id == org_id)
            .order_by(OrgMember.joined_at)
        )
    ).all()
    return [
        MemberOut(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            role=m.role,
            joined_at=m.joined_at,
        )
        for m, u in rows
    ]


@router.post("/{org_id}/invites", status_code=status.HTTP_201_CREATED)
async def invite(
    org_id: uuid.UUID, body: InviteIn, request: Request, session: Db, user: ActiveUser
) -> dict:
    """초대 메일을 **아웃박스에 넣는다.** 여기서 직접 보내지 않는다 —
    트랜잭션이 뒤에서 실패하면 없는 초대의 링크가 나간다"""
    await rate_check("org_invite", str(user.id))
    org = await session.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise NotFound("워크스페이스를 찾을 수 없습니다", code="org_not_found")
    await orgs.require_member(session, org_id=org_id, user_id=user.id, need=orgs.INVITE)

    if org.kind == "personal":
        # 개인 워크스페이스에 남을 들이면 그건 이미 팀이다. 개념을 흐리지 않는다
        raise Unprocessable(
            "개인 워크스페이스에는 초대할 수 없습니다. 팀을 만들어 주세요",
            code="cannot_invite_to_personal",
        )

    email = body.email.lower()
    already = (
        await session.execute(
            select(OrgMember)
            .join(User, User.id == OrgMember.user_id)
            .where(OrgMember.org_id == org_id, User.email == email)
        )
    ).first()
    if already is not None:
        raise Conflict("이미 참여 중인 사용자입니다", code="already_member")

    token = new_opaque_token()
    session.add(
        OrgInvite(
            org_id=org_id,
            email=email,
            role=body.role,
            token_hash=hash_token(token),
            invited_by=user.id,
            expires_at=datetime.now(UTC) + timedelta(hours=INVITE_TTL_HOURS),
        )
    )
    await mail.enqueue(
        session,
        to_email=email,
        template="org_invite",
        payload={
            "org_name": org.name,
            "inviter": user.display_name or user.email.split("@")[0],
            "role": body.role,
            "link": mail.link("/invite", token),
            "expires_hours": INVITE_TTL_HOURS,
        },
    )
    await audit.record(
        session,
        action="org.invite",
        actor_id=user.id,
        target_type="org",
        target_id=org_id,
        detail={"role": body.role},
        ip=client_ip(request),
    )
    # **토큰을 응답에 담지 않는다.** 메일로만 간다 — 안 그러면 초대한 사람이
    # 남의 링크를 그대로 쓸 수 있다
    return {"status": "sent", "email": email, "expires_hours": INVITE_TTL_HOURS}


class AcceptIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


@router.post("/invites/accept", response_model=OrgOut)
async def accept_invite(
    body: AcceptIn, request: Request, session: Db, user: ActiveUser
) -> OrgOut:
    invite_row = (
        await session.execute(
            select(OrgInvite).where(OrgInvite.token_hash == hash_token(body.token))
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if (
        invite_row is None
        or invite_row.accepted_at is not None
        or invite_row.revoked_at is not None
        or invite_row.expires_at <= now
    ):
        raise NotFound("초대를 찾을 수 없거나 만료됐습니다", code="invite_invalid")

    # **초대받은 주소로 로그인한 사람만** 수락할 수 있다. 링크가 유출돼도
    # 다른 계정이 팀에 들어오지 못한다
    if user.email.lower() != invite_row.email.lower():
        raise Forbidden("초대받은 계정으로 로그인해 주세요", code="invite_email_mismatch")

    await orgs.add_member(
        session, org_id=invite_row.org_id, user_id=user.id, role=invite_row.role
    )
    invite_row.accepted_at = now

    org = await session.get(Organization, invite_row.org_id)
    await audit.record(
        session,
        action="org.invite_accept",
        actor_id=user.id,
        target_type="org",
        target_id=invite_row.org_id,
        ip=client_ip(request),
    )
    assert org is not None
    return OrgOut(
        id=org.id, slug=org.slug, name=org.name, kind=org.kind, my_role=invite_row.role
    )


@router.post("/{org_id}/members/{member_id}/role", response_model=MemberOut)
async def set_member_role(
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    body: RoleIn,
    request: Request,
    session: Db,
    user: ActiveUser,
) -> MemberOut:
    await orgs.require_member(session, org_id=org_id, user_id=user.id, need=orgs.BILLING)

    member = (
        await session.execute(
            select(OrgMember).where(
                OrgMember.org_id == org_id, OrgMember.user_id == member_id
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise NotFound("구성원을 찾을 수 없습니다", code="member_not_found")

    # 마지막 owner 를 강등하면 **아무도 과금·삭제를 못 하는 조직**이 남는다
    if member.role == "owner" and body.role != "owner":
        await orgs.ensure_not_last_owner(session, org_id=org_id, user_id=member_id)

    member.role = body.role
    target = await session.get(User, member_id)
    assert target is not None
    await audit.record(
        session,
        action="org.member_role",
        actor_id=user.id,
        target_type="org",
        target_id=org_id,
        detail={"member": str(member_id), "role": body.role},
        ip=client_ip(request),
    )
    return MemberOut(
        user_id=target.id,
        email=target.email,
        display_name=target.display_name,
        role=member.role,
        joined_at=member.joined_at,
    )


@router.delete("/{org_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    request: Request,
    session: Db,
    user: ActiveUser,
) -> None:
    """자기 자신은 나갈 수 있고(마지막 owner 만 아니면), 남을 빼려면 owner 여야 한다"""
    if member_id != user.id:
        await orgs.require_member(session, org_id=org_id, user_id=user.id, need=orgs.BILLING)
    else:
        await orgs.require_member(session, org_id=org_id, user_id=user.id)

    org = await session.get(Organization, org_id)
    if org is not None and org.kind == "personal":
        raise Unprocessable(
            "개인 워크스페이스는 나갈 수 없습니다", code="cannot_leave_personal"
        )

    await orgs.ensure_not_last_owner(session, org_id=org_id, user_id=member_id)
    member = (
        await session.execute(
            select(OrgMember).where(
                OrgMember.org_id == org_id, OrgMember.user_id == member_id
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise NotFound("구성원을 찾을 수 없습니다", code="member_not_found")

    await session.delete(member)
    await audit.record(
        session,
        action="org.member_remove",
        actor_id=user.id,
        target_type="org",
        target_id=org_id,
        detail={"member": str(member_id)},
        ip=client_ip(request),
    )


class OrgUsageOut(BaseModel):
    plan_code: str
    status: str
    commercial_license: bool
    limits: dict[str, int]
    usage: dict[str, int]


@router.get("/{org_id}/usage", response_model=OrgUsageOut)
async def org_usage(
    org_id: uuid.UUID, session: Db, user: CurrentUser
) -> OrgUsageOut:
    await orgs.require_member(session, org_id=org_id, user_id=user.id)
    ent = await entitlements.resolve(session, org_id)
    return OrgUsageOut(
        plan_code=ent.plan_code,
        status=ent.status,
        commercial_license=ent.commercial_license,
        limits=ent.limits,
        usage={
            "ai_job": await entitlements.usage_in_period(session, org_id, "ai_job"),
            "export": await entitlements.usage_in_period(session, org_id, "export"),
        },
    )


OrgId = Annotated[uuid.UUID, None]
