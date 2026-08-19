"""곡 쿼리.

**commit 하지 않는다.** 트랜잭션 경계는 service 에만 있다.

여기서 `org_members` 를 조인하지 않는 것이 요점이다. 예전에는
`Project JOIN OrgMember` 로 "내 곡"을 골랐는데, 그러면 곡 도메인이 워크스페이스의
테이블 모양에 묶인다. 지금은 **내가 속한 조직 목록을 워크스페이스에서 받아**
`org_id IN (...)` 으로만 고른다 — 곡은 조직 id 말고는 아무것도 모른다.
"""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.projects.models import Project, ProjectVersion


async def get(session: AsyncSession, project_id: uuid.UUID) -> Project | None:
    """살아 있는 곡만. 휴지통에 있는 것은 `get_deleted` 로 따로 찾는다"""
    return (
        await session.execute(
            select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
        )
    ).scalar_one_or_none()


async def get_deleted(session: AsyncSession, project_id: uuid.UUID) -> Project | None:
    return (
        await session.execute(
            select(Project).where(
                Project.id == project_id, Project.deleted_at.is_not(None)
            )
        )
    ).scalar_one_or_none()


def _page(stmt, cursor: str | None, limit: int):
    """커서는 `updated_at|id` 다.

    `updated_at` 만 쓰면 **같은 시각에 저장된 곡이 페이지 경계에서 잘린다.**
    형식은 API 계약이라 바꾸지 않는다.
    """
    if cursor:
        try:
            at, last_id = cursor.split("|", 1)
            stmt = stmt.where(
                tuple_(Project.updated_at, Project.id)
                < (datetime.fromisoformat(at), uuid.UUID(last_id))
            )
        except (ValueError, AttributeError, TypeError) as exc:
            raise InvalidCursor from exc
    return stmt.order_by(Project.updated_at.desc(), Project.id.desc()).limit(limit + 1)


class InvalidCursor(Exception):
    """**도메인 예외다.** repository 는 HTTP 를 모른다 — 라우터가 422 로 바꾼다"""


async def list_for_orgs(
    session: AsyncSession,
    org_ids: Sequence[uuid.UUID],
    *,
    cursor: str | None = None,
    limit: int = 50,
    only_org: uuid.UUID | None = None,
) -> tuple[list[Project], str | None]:
    """살아 있는 곡 한 페이지 + 다음 커서"""
    if not org_ids:
        return [], None
    scope = [only_org] if only_org is not None else list(org_ids)
    rows = list(
        (
            await session.execute(
                _page(
                    select(Project).where(
                        Project.org_id.in_(scope), Project.deleted_at.is_(None)
                    ),
                    cursor,
                    limit,
                )
            )
        ).scalars()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    nxt = f"{rows[-1].updated_at.isoformat()}|{rows[-1].id}" if has_more and rows else None
    return rows, nxt


async def list_trashed(
    session: AsyncSession,
    org_ids: Sequence[uuid.UUID],
    *,
    limit: int = 50,
    only_org: uuid.UUID | None = None,
) -> list[Project]:
    if not org_ids:
        return []
    scope = [only_org] if only_org is not None else list(org_ids)
    return list(
        (
            await session.execute(
                select(Project)
                .where(Project.org_id.in_(scope), Project.deleted_at.is_not(None))
                .order_by(Project.deleted_at.desc())
                .limit(limit)
            )
        ).scalars()
    )


async def count_active(session: AsyncSession, org_id: uuid.UUID) -> int:
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


async def get_version(session: AsyncSession, version_id: uuid.UUID) -> ProjectVersion | None:
    return await session.get(ProjectVersion, version_id)


async def list_versions(
    session: AsyncSession, project_id: uuid.UUID, *, limit: int = 50
) -> list[ProjectVersion]:
    return list(
        (
            await session.execute(
                select(ProjectVersion)
                .where(ProjectVersion.project_id == project_id)
                .order_by(ProjectVersion.seq.desc())
                .limit(limit)
            )
        ).scalars()
    )
