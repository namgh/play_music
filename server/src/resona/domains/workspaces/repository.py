"""워크스페이스 쿼리.

**commit 하지 않는다.** 트랜잭션 경계는 service 에만 있다 (`서버코드레퍼런스.md` 2절).
`flush()` 는 ID 를 얻어야 할 때만 쓴다.

이 파일이 존재하는 이유는 **다른 도메인이 `org_members` 를 조인하지 못하게** 하기
위해서다. 예전에는 곡 목록이 `Project JOIN OrgMember` 를 직접 했는데, 그러면
워크스페이스를 떼어내는 순간 곡 목록이 깨진다. 지금은 "내 조직이 무엇인가"를
여기서 받아 가고, 곡은 `org_id` 로만 고른다.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.workspaces.models import Organization, OrgInvite, OrgMember


async def get(session: AsyncSession, org_id: uuid.UUID) -> Organization | None:
    return await session.get(Organization, org_id)


async def get_by_slug(session: AsyncSession, slug: str) -> Organization | None:
    return (
        await session.execute(select(Organization).where(Organization.slug == slug))
    ).scalar_one_or_none()


async def role_of(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID
) -> str | None:
    return (
        await session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == org_id, OrgMember.user_id == user_id
            )
        )
    ).scalar_one_or_none()


async def roles_for_user(session: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, str]:
    """**내가 속한 조직과 그 역할.**

    다른 도메인이 `org_members` 를 조인하는 대신 이걸 받아 간다. 한 사람이 속한
    조직은 많아야 수십 개라 한 번에 가져와도 싸고, 무엇보다 조인이 사라진다.
    """
    rows = await session.execute(
        select(OrgMember.org_id, OrgMember.role).where(OrgMember.user_id == user_id)
    )
    return {org_id: role for org_id, role in rows}


async def list_with_role(
    session: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Organization, str]]:
    rows = await session.execute(
        select(Organization, OrgMember.role)
        .join(OrgMember, OrgMember.org_id == Organization.id)
        .where(OrgMember.user_id == user_id, Organization.deleted_at.is_(None))
        .order_by(Organization.created_at)
    )
    return [(org, role) for org, role in rows]


async def members(session: AsyncSession, org_id: uuid.UUID) -> list[OrgMember]:
    return list(
        (
            await session.execute(select(OrgMember).where(OrgMember.org_id == org_id))
        ).scalars()
    )


async def count_owners(session: AsyncSession, org_id: uuid.UUID) -> int:
    return len(
        [
            m
            for m in await members(session, org_id)
            if m.role == "owner"
        ]
    )


async def add_member(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, role: str
) -> OrgMember:
    member = OrgMember(org_id=org_id, user_id=user_id, role=role)
    session.add(member)
    return member


async def pending_invite(session: AsyncSession, token_hash: str) -> OrgInvite | None:
    return (
        await session.execute(
            select(OrgInvite).where(
                OrgInvite.token_hash == token_hash,
                OrgInvite.accepted_at.is_(None),
                OrgInvite.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
