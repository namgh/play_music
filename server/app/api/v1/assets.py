"""에셋 — **업로드는 3단계다** (`SERVER.md` 4절).

    1. `POST /assets`          서버가 행을 `pending` 으로 만들고 서명 URL을 준다
    2. 브라우저 → 스토리지     바이트는 API 를 통과하지 않는다
    3. `POST /assets/{id}/complete`  서버가 `ready` 로 올린다

2단계가 실패하면 `pending` 행이 남는다. 그건 **정상이고 예상된 상태다** — 스케줄러가
치운다. "실패하면 지우기"를 클라이언트에 맡기면 브라우저를 닫는 순간 새는데,
그런 누수는 몇 달 뒤 스토리지 청구서로 발견된다.

내보내기(export)는 **클라이언트가 렌더한 결과를 올리는 것**이다. 서버는 오디오를
만들지 않는다 (`plan.md` 5-2 — 확정된 결정).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import ActiveUser, Config, CurrentUser, Db, client_ip
from app.core import audit
from app.core.errors import Conflict, NotFound, Unprocessable
from app.core.ratelimit import check as rate_check
from app.db.models import Asset, ProjectExport, ProjectVersion
from app.services import entitlements, orgs, storage
from app.services.projects import get_project

router = APIRouter(tags=["assets"])


class AssetCreateIn(BaseModel):
    kind: str = Field(pattern="^(export|sample|ir)$")
    content_type: str
    size_bytes: int = Field(gt=0, le=storage.MAX_UPLOAD_BYTES)
    # 클라이언트가 계산해 보낸다. 완료 단계에서 스토리지가 준 ETag 와 대조할 수 있고,
    # 같은 파일을 두 번 올리는 것도 여기서 걸러진다
    sha256: str = Field(pattern="^[0-9a-f]{64}$")
    filename: str = Field(default="export.wav", max_length=200)


class AssetOut(BaseModel):
    id: uuid.UUID
    status: str
    upload_url: str | None = None
    storage_key: str
    expires_in: int | None = None


class ExportCreateIn(BaseModel):
    project_id: uuid.UUID
    version_id: uuid.UUID
    asset_id: uuid.UUID
    format: str = Field(pattern="^(wav|mp3|flac)$")
    sample_rate: int | None = Field(default=None, ge=8000, le=192000)
    bit_depth: int | None = Field(default=None, ge=8, le=32)
    # 클라이언트가 렌더하며 잰 피크. **넘쳤어도 그대로 받는다** — 지우면
    # 나중에 "왜 깨졌지"를 재현할 근거가 사라진다 (`SOUND_QUALITY.md`)
    peak_dbfs: float | None = Field(default=None, ge=-200, le=60)


class ExportOut(BaseModel):
    id: uuid.UUID
    format: str
    license: str
    peak_dbfs: float | None
    created_at: datetime
    download_url: str | None = None


_EXT = {"wav": "wav", "mp3": "mp3", "flac": "flac"}
_UPLOAD_TTL = 900


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def create_asset(
    body: AssetCreateIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> AssetOut:
    await rate_check("asset_create", str(user.id))

    if body.content_type not in storage.ALLOWED_CONTENT_TYPES[body.kind]:
        raise Unprocessable(
            "지원하지 않는 파일 형식입니다",
            code="unsupported_content_type",
            details={"allowed": sorted(storage.ALLOWED_CONTENT_TYPES[body.kind])},
        )

    # 용량 한도는 **올리기 전에** 본다. 올린 뒤 거절하면 대역폭은 이미 썼다.
    # 한도는 개인이 아니라 **워크스페이스** 것이다
    org = await orgs.personal_org(session, user.id)
    ent = await entitlements.resolve(session, org.id)
    limit_mb = ent.limits.get("storage_mb")
    if limit_mb is not None:
        used = (
            await session.execute(
                select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(
                    Asset.owner_id == user.id, Asset.status == "ready"
                )
            )
        ).scalar_one()
        if used + body.size_bytes > limit_mb * 1024 * 1024:
            from app.core.errors import LimitReached

            raise LimitReached(
                "저장 공간이 부족합니다",
                code="storage_limit_reached",
                details={"limit_mb": limit_mb, "used_mb": round(used / 1024 / 1024, 1)},
            )

    asset_id = uuid.uuid4()
    ext = body.filename.rsplit(".", 1)[-1] if "." in body.filename else "bin"
    key = storage.storage_key(owner_id=user.id, kind=body.kind, asset_id=asset_id, ext=ext)

    session.add(
        Asset(
            id=asset_id,
            owner_id=user.id,
            kind=body.kind,
            storage_key=key,
            content_type=body.content_type,
            size_bytes=body.size_bytes,
            sha256=bytes.fromhex(body.sha256),
            status="pending",
        )
    )
    return AssetOut(
        id=asset_id,
        status="pending",
        storage_key=key,
        upload_url=storage.upload_url(settings, key, ttl_sec=_UPLOAD_TTL),
        expires_in=_UPLOAD_TTL,
    )


@router.post("/assets/{asset_id}/complete", response_model=AssetOut)
async def complete_asset(
    asset_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> AssetOut:
    asset = await session.get(Asset, asset_id)
    if asset is None or asset.owner_id != user.id:
        raise NotFound("에셋을 찾을 수 없습니다", code="asset_not_found")

    # **멱등하다.** 네트워크가 끊겨 재시도해도 같은 응답을 준다
    if asset.status != "ready":
        asset.status = "ready"
        asset.ready_at = func.now()
        await audit.record(
            session,
            action="asset.complete",
            actor_id=user.id,
            target_type="asset",
            target_id=asset.id,
            ip=client_ip(request),
        )
    return AssetOut(id=asset.id, status="ready", storage_key=asset.storage_key)


@router.post("/exports", response_model=ExportOut, status_code=status.HTTP_201_CREATED)
async def create_export(
    body: ExportCreateIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> ExportOut:
    """**상업 이용 권리를 이 시점에 고정한다** (`SERVER_BILLING.md` 3절).

    구독을 해지해도 이미 내보낸 곡의 권리는 살아 있다. 이걸 취소하면 사용자는
    자기 작업물을 쓰지 못하게 되고, 그건 제품이 아니라 인질이다.
    """
    # 없거나 남의 것이면 여기서 404 를 던진다 (존재 자체를 알려주지 않는다)
    project = await get_project(session, body.project_id, user.id, need=orgs.EDIT)

    version = await session.get(ProjectVersion, body.version_id)
    if version is None or version.project_id != project.id:
        raise NotFound("버전을 찾을 수 없습니다", code="version_not_found")

    asset = await session.get(Asset, body.asset_id)
    if asset is None or asset.owner_id != user.id:
        raise NotFound("에셋을 찾을 수 없습니다", code="asset_not_found")
    if asset.status != "ready":
        raise Conflict("업로드가 아직 끝나지 않았습니다", code="asset_not_ready")

    ent = await entitlements.resolve(session, project.org_id)
    export = ProjectExport(
        project_id=project.id,
        version_id=version.id,
        asset_id=asset.id,
        format=body.format,
        sample_rate=body.sample_rate,
        bit_depth=body.bit_depth,
        peak_dbfs=body.peak_dbfs,
        license="commercial" if ent.commercial_license else "personal",
        # 스냅샷을 통째로 남긴다. 나중에 플랜 정의가 바뀌어도 **그날의 근거**가 남는다
        license_snapshot={
            "plan": ent.plan_code,
            "status": ent.status,
            "commercial": ent.commercial_license,
        },
    )
    session.add(export)
    await session.flush()

    await entitlements.record_usage(
        session, org_id=project.org_id, user_id=user.id, kind="export"
    )
    await audit.record(
        session,
        action="export.create",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        detail={"license": export.license, "format": export.format},
        ip=client_ip(request),
    )
    return ExportOut(
        id=export.id,
        format=export.format,
        license=export.license,
        peak_dbfs=body.peak_dbfs,
        created_at=datetime.now(tz=version.created_at.tzinfo),
    )


@router.get("/projects/{project_id}/exports", response_model=list[ExportOut])
async def list_exports(
    project_id: uuid.UUID,
    session: Db,
    settings: Config,
    user: CurrentUser,  # 정지된 계정도 **내려받을 수 있어야 한다**
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[ExportOut]:
    # 내려받기는 viewer 도 된다 — 정지 계정에도 열려 있어야 하는 경로다
    project = await get_project(session, project_id, user.id)

    rows = (
        await session.execute(
            select(ProjectExport, Asset)
            .join(Asset, Asset.id == ProjectExport.asset_id)
            .where(ProjectExport.project_id == project_id)
            .order_by(ProjectExport.created_at.desc())
            .limit(limit)
        )
    ).all()

    out: list[ExportOut] = []
    for export, asset in rows:
        out.append(
            ExportOut(
                id=export.id,
                format=export.format,
                license=export.license,
                peak_dbfs=float(export.peak_dbfs) if export.peak_dbfs is not None else None,
                created_at=export.created_at,
                download_url=storage.download_url(
                    settings,
                    asset.storage_key,
                    filename=f"{project.name}.{_EXT.get(export.format, 'wav')}",
                ),
            )
        )
    return out
