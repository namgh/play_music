"""에셋 쿼리. **commit 하지 않는다.**"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.assets.models import Asset


async def get(session: AsyncSession, asset_id: uuid.UUID) -> Asset | None:
    return await session.get(Asset, asset_id)


async def by_storage_key(session: AsyncSession, key: str) -> Asset | None:
    return (
        await session.execute(select(Asset).where(Asset.storage_key == key))
    ).scalar_one_or_none()


async def used_bytes(session: AsyncSession, org_id: uuid.UUID) -> int:
    """**용량 한도는 조직 단위다.** 사람 단위로 세면 팀에서 한도가 인원수만큼 늘어난다"""
    return int(
        (
            await session.execute(
                select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(
                    Asset.org_id == org_id, Asset.status == "ready"
                )
            )
        ).scalar_one()
    )


async def list_for_org(
    session: AsyncSession, org_id: uuid.UUID, *, limit: int = 100
) -> list[Asset]:
    return list(
        (
            await session.execute(
                select(Asset)
                .where(Asset.org_id == org_id)
                .order_by(Asset.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )


async def get_many(session: AsyncSession, ids) -> dict:
    """**반복문 안에서 하나씩 조회하지 않기 위한 것** (N+1)"""
    ids = list(ids)
    if not ids:
        return {}
    rows = (await session.execute(select(Asset).where(Asset.id.in_(ids)))).scalars()
    return {a.id: a for a in rows}
