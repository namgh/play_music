"""계정 쿼리. **commit 하지 않는다** — 트랜잭션 경계는 service 에만 있다."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.accounts.models import AuthIdentity, User


async def get(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    return await session.get(User, user_id)


async def get_many(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
    """**반복문 안에서 한 명씩 조회하지 않기 위한 것** (N+1). 어드민 목록이 쓴다"""
    if not ids:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(ids)))).scalars()
    return {u.id: u for u in rows}


async def get_by_email(session: AsyncSession, email: str) -> User | None:
    return (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()


async def identities(session: AsyncSession, user_id: uuid.UUID) -> list[str]:
    return sorted(
        (
            await session.execute(
                select(AuthIdentity.provider).where(AuthIdentity.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )


async def count_by_status(session: AsyncSession) -> dict[str, int]:
    rows = await session.execute(select(User.status, func.count()).group_by(User.status))
    return {status: n for status, n in rows}
