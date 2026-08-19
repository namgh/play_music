"""음색 프리셋 — "내 음색"을 기기 밖으로 (`sound.md` 8절).

파라미터 JSON 이라 **용량이 사실상 0 이다.** 그래서 오디오와 달리 스토리지를 안
거치고 DB 에 그대로 들어가고, 링크 하나로 공유된다.

서버는 파라미터의 **의미를 해석하지 않는다.** 프로젝트 문서와 같은 원칙이다
(`services/projects.py`) — 검증을 두 벌 만들면 클라이언트와 서버가 반드시 갈라진다.
대신 `schema_version` 은 요구한다. 나중에 파라미터 구조가 바뀔 때 어느 마이그레이션을
태울지 알아야 한다.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from resona.api.deps import ActiveUser, CurrentUser, Db, client_ip
from resona.core import audit
from resona.core.errors import NotFound
from resona.core.ratelimit import check as rate_check
from resona.db.models import TonePreset

router = APIRouter(prefix="/presets", tags=["presets"])

# 파라미터 JSON 상한. 프리셋은 수십~수백 개 숫자라 이 정도면 넉넉하고,
# 넘어가면 프리셋이 아니라 다른 것을 넣고 있다는 뜻이다
MAX_PARAMS_BYTES = 64 * 1024


class PresetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    instrument_id: str = Field(min_length=1, max_length=100)
    schema_version: int = Field(ge=1)
    params: dict[str, Any]
    is_public: bool = False


class PresetOut(BaseModel):
    id: uuid.UUID
    name: str
    instrument_id: str
    schema_version: int
    params: dict[str, Any]
    is_public: bool
    is_mine: bool
    created_at: datetime


def _out(preset: TonePreset, *, user_id: uuid.UUID) -> PresetOut:
    return PresetOut(
        id=preset.id,
        name=preset.name,
        instrument_id=preset.instrument_id,
        schema_version=preset.schema_version,
        params=preset.params,
        is_public=preset.is_public,
        is_mine=preset.owner_id == user_id,
        created_at=preset.created_at,
    )


@router.get("", response_model=list[PresetOut])
async def list_presets(
    session: Db,
    user: CurrentUser,
    instrument_id: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[PresetOut]:
    """내 프리셋. 악기별로 거를 수 있다 — 편집 중인 악기의 프리셋만 보여 주려면 필요하다"""
    stmt = select(TonePreset).where(TonePreset.owner_id == user.id)
    if instrument_id:
        stmt = stmt.where(TonePreset.instrument_id == instrument_id)
    rows = (
        await session.execute(stmt.order_by(TonePreset.created_at.desc()).limit(limit))
    ).scalars()
    return [_out(p, user_id=user.id) for p in rows]


@router.post("", response_model=PresetOut, status_code=status.HTTP_201_CREATED)
async def create_preset(
    body: PresetIn, request: Request, session: Db, user: ActiveUser
) -> PresetOut:
    await rate_check("preset_write", str(user.id))

    import json

    size = len(json.dumps(body.params, separators=(",", ":")).encode())
    if size > MAX_PARAMS_BYTES:
        from resona.core.errors import Unprocessable

        raise Unprocessable(
            "프리셋이 너무 큽니다",
            code="preset_too_large",
            details={"limit_bytes": MAX_PARAMS_BYTES, "size_bytes": size},
        )

    preset = TonePreset(
        owner_id=user.id,
        name=body.name,
        instrument_id=body.instrument_id,
        schema_version=body.schema_version,
        params=body.params,
        is_public=body.is_public,
    )
    session.add(preset)
    await session.flush()
    await audit.record(
        session,
        action="preset.create",
        actor_id=user.id,
        target_type="preset",
        target_id=preset.id,
        ip=client_ip(request),
    )
    return _out(preset, user_id=user.id)


@router.get("/{preset_id}", response_model=PresetOut)
async def get_preset(preset_id: uuid.UUID, session: Db, user: CurrentUser) -> PresetOut:
    """**공개 프리셋은 누구나 열 수 있다.** 링크 하나로 공유되는 것이 요점이다"""
    preset = await session.get(TonePreset, preset_id)
    if preset is None or (not preset.is_public and preset.owner_id != user.id):
        raise NotFound("프리셋을 찾을 수 없습니다", code="preset_not_found")
    return _out(preset, user_id=user.id)


@router.post("/{preset_id}/copy", response_model=PresetOut, status_code=status.HTTP_201_CREATED)
async def copy_preset(
    preset_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> PresetOut:
    """남의 공개 프리셋을 **내 것으로 복사한다.**

    참조로 두지 않는 이유: 원본이 지워지거나 바뀌면 내 곡의 소리가 말없이 달라진다.
    프리셋은 용량이 0 이라 복사가 싸고, 복사해 두면 내 소리는 내 것으로 고정된다.
    """
    source = await session.get(TonePreset, preset_id)
    if source is None or (not source.is_public and source.owner_id != user.id):
        raise NotFound("프리셋을 찾을 수 없습니다", code="preset_not_found")

    copy = TonePreset(
        owner_id=user.id,
        name=source.name if source.owner_id == user.id else f"{source.name} (복사)",
        instrument_id=source.instrument_id,
        schema_version=source.schema_version,
        params=source.params,
        is_public=False,  # 복사본은 비공개로 시작한다
    )
    session.add(copy)
    await session.flush()
    return _out(copy, user_id=user.id)


class PresetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    is_public: bool | None = None


@router.patch("/{preset_id}", response_model=PresetOut)
async def update_preset(
    preset_id: uuid.UUID,
    body: PresetPatch,
    request: Request,
    session: Db,
    user: ActiveUser,
) -> PresetOut:
    """이름과 공개 여부만 바꾼다.

    **파라미터는 못 고친다.** 프리셋을 쓰고 있는 곡의 소리가 말없이 달라지기
    때문이다 — 소리를 바꾸려면 새 프리셋을 만든다.
    """
    preset = await session.get(TonePreset, preset_id)
    if preset is None or preset.owner_id != user.id:
        raise NotFound("프리셋을 찾을 수 없습니다", code="preset_not_found")

    if body.name is not None:
        preset.name = body.name
    if body.is_public is not None:
        preset.is_public = body.is_public
        await audit.record(
            session,
            action="preset.visibility",
            actor_id=user.id,
            target_type="preset",
            target_id=preset.id,
            detail={"is_public": body.is_public},
            ip=client_ip(request),
        )
    return _out(preset, user_id=user.id)


@router.delete("/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_preset(preset_id: uuid.UUID, session: Db, user: ActiveUser) -> None:
    preset = await session.get(TonePreset, preset_id)
    if preset is None or preset.owner_id != user.id:
        raise NotFound("프리셋을 찾을 수 없습니다", code="preset_not_found")
    await session.delete(preset)
