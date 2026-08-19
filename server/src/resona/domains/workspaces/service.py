"""조직(워크스페이스) — **리소스 권한이 여기 한 곳에서만 결정된다.**

핵심 결정: **개인 계정은 1인 조직이다.**

개인용 경로("내 프로젝트")와 팀용 경로("팀 프로젝트")를 따로 두면 목록·권한·과금·
삭제가 전부 두 벌이 되고, 한쪽에만 있는 버그가 반드시 생긴다. 그래서 가입 시
`kind='personal'` 조직을 자동으로 만들고 **모든 프로젝트가 어떤 조직에 속한다.**
팀을 만드는 것은 조직을 하나 더 만드는 것일 뿐이다.

권한은 2축이다 (`SERVER_ACCOUNTS.md` 3절):
  - `users.platform_role` — 플랫폼 운영 권한. **리소스 접근을 주지 않는다**
  - `org_members.role`   — 리소스 권한. 여기에만 의존한다
"""

from __future__ import annotations

import re
import unicodedata
import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from resona.core.errors import Conflict, Forbidden, NotFound
from resona.domains.accounts.models import User
from resona.domains.workspaces.models import Organization, OrgMember

# 강한 것부터 약한 것 순. 숫자로 비교하면 새 역할을 끼워 넣기 쉽다
ROLE_RANK = {"owner": 40, "admin": 30, "editor": 20, "viewer": 10}

EDIT = "editor"
INVITE = "admin"
BILLING = "owner"


def slugify(value: str, *, fallback: str) -> str:
    """URL 에 쓸 이름. **한글 이름도 받아야** 해서 못 쓰는 글자는 버리고 fallback 을 쓴다"""
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    text = re.sub(r"-{2,}", "-", text)
    if len(text) < 3:
        text = fallback
    return text[:60].strip("-")


async def _unique_slug(session: AsyncSession, base: str) -> str:
    """충돌하면 뒤에 짧은 무작위를 붙인다. 순번(`-2`)은 조직 수를 노출한다"""
    candidate = base
    for _ in range(5):
        exists = (
            await session.execute(
                select(Organization.id).where(Organization.slug == candidate)
            )
        ).first()
        if exists is None:
            return candidate
        candidate = f"{base[:52]}-{uuid.uuid4().hex[:6]}"
    return f"w-{uuid.uuid4().hex[:12]}"


async def create_personal_org(session: AsyncSession, user: User) -> Organization:
    """가입 직후에 부른다. **이게 없으면 프로젝트를 만들 곳이 없다**"""
    base = slugify(
        user.display_name or user.email.split("@")[0], fallback=f"u-{uuid.uuid4().hex[:8]}"
    )
    org = Organization(
        slug=await _unique_slug(session, base),
        name=user.display_name or user.email.split("@")[0],
        kind="personal",
        created_by=user.id,
    )
    session.add(org)
    await session.flush()
    session.add(OrgMember(org_id=org.id, user_id=user.id, role="owner"))
    return org


async def create_team(session: AsyncSession, *, user: User, name: str) -> Organization:
    org = Organization(
        slug=await _unique_slug(session, slugify(name, fallback=f"t-{uuid.uuid4().hex[:8]}")),
        name=name,
        kind="team",
        created_by=user.id,
    )
    session.add(org)
    await session.flush()
    # 만든 사람이 owner 다. owner 가 없는 조직은 과금도 삭제도 못 한다
    session.add(OrgMember(org_id=org.id, user_id=user.id, role="owner"))
    return org


async def personal_org(session: AsyncSession, user_id: uuid.UUID) -> Organization:
    org = (
        await session.execute(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(
                OrgMember.user_id == user_id,
                Organization.kind == "personal",
                Organization.deleted_at.is_(None),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if org is None:
        raise NotFound("개인 워크스페이스를 찾을 수 없습니다", code="personal_org_missing")
    return org


async def list_for_user(
    session: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Organization, str]]:
    rows = (
        await session.execute(
            select(Organization, OrgMember.role)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user_id, Organization.deleted_at.is_(None))
            # 개인 워크스페이스를 항상 먼저 보여 준다
            .order_by((Organization.kind != "personal"), Organization.created_at)
        )
    ).all()
    return [(org, role) for org, role in rows]


async def member_role(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID
) -> str | None:
    return (
        await session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == org_id, OrgMember.user_id == user_id
            )
        )
    ).scalar_one_or_none()


async def require_member(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, need: str = "viewer"
) -> str:
    """권한이 없으면 **404 를 준다** — 403 은 "그 조직이 존재한다"를 알려 준다.

    반환은 실제 역할이라 호출한 쪽이 더 세밀한 판단을 할 수 있다.
    """
    role = await member_role(session, org_id=org_id, user_id=user_id)
    if role is None:
        raise NotFound("워크스페이스를 찾을 수 없습니다", code="org_not_found")
    if ROLE_RANK[role] < ROLE_RANK[need]:
        raise Forbidden(
            "권한이 없습니다",
            code="insufficient_org_role",
            details={"required": need, "actual": role},
        )
    return role


async def resolve_org(
    session: AsyncSession, *, user: User, org_id: uuid.UUID | None, need: str = "viewer"
) -> Organization:
    """`org_id` 를 안 주면 **개인 워크스페이스로 간다.**

    클라이언트가 조직을 몰라도 곡을 만들 수 있어야 한다 — 처음 쓰는 사람에게
    "먼저 워크스페이스를 고르세요"를 요구하면 거기서 절반이 떠난다.
    """
    if org_id is None:
        return await personal_org(session, user.id)
    await require_member(session, org_id=org_id, user_id=user.id, need=need)
    org = await session.get(Organization, org_id)
    if org is None or org.deleted_at is not None:
        raise NotFound("워크스페이스를 찾을 수 없습니다", code="org_not_found")
    return org


async def add_member(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, role: str
) -> None:
    session.add(OrgMember(org_id=org_id, user_id=user_id, role=role))
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise Conflict("이미 참여한 사용자입니다", code="already_member") from None


async def count_owners(session: AsyncSession, org_id: uuid.UUID) -> int:
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(OrgMember)
                .where(OrgMember.org_id == org_id, OrgMember.role == "owner")
            )
        ).scalar_one()
    )


async def ensure_not_last_owner(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """**마지막 owner 를 못 빼게 한다.** 빠지면 아무도 과금·삭제를 못 하는 조직이
    남고, 그건 고객지원으로만 풀 수 있다"""
    role = await member_role(session, org_id=org_id, user_id=user_id)
    if role == "owner" and await count_owners(session, org_id) <= 1:
        raise Conflict(
            "마지막 소유자는 나갈 수 없습니다. 다른 사람에게 소유자를 넘겨주세요",
            code="last_owner",
        )
