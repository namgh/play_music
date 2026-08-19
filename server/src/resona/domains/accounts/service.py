"""계정 도메인의 **공개 인터페이스.**

다른 도메인은 `accounts.models` 도 `accounts.repository` 도 임포트하지 않는다
(`서버코드레퍼런스.md` 2절 5항). 여기 있는 함수만 부른다 — 그래야 계정의 테이블
모양이 바뀌어도 남의 도메인이 안 깨진다.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from resona.domains.accounts import repository


async def get(session: AsyncSession, user_id: uuid.UUID):
    return await repository.get(session, user_id)


async def get_by_email(session: AsyncSession, email: str):
    return await repository.get_by_email(session, email)


async def get_many(session: AsyncSession, ids: list[uuid.UUID]) -> dict:
    """**한 번에 모아서 가져온다** — 반복문 안에서 한 명씩 부르면 N+1 이 된다"""
    return await repository.get_many(session, ids)


async def login_methods(session: AsyncSession, user_id: uuid.UUID) -> list[str]:
    return await repository.identities(session, user_id)


async def count_by_status(session: AsyncSession) -> dict[str, int]:
    return await repository.count_by_status(session)
