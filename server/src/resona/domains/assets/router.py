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

from resona.core import storage as storage
from resona.core.deps import Config, Db, client_ip
from resona.core.errors import Conflict, NotFound, Unprocessable
from resona.core.ratelimit import check as rate_check
from resona.domains.accounts.deps import ActiveUser, CurrentUser
from resona.domains.assets import repository
from resona.domains.assets.models import Asset
from resona.domains.billing import service as entitlements
from resona.domains.ops import audit
from resona.domains.projects import service as projects
from resona.domains.projects.service import get_project
from resona.domains.workspaces import service as orgs

router = APIRouter(tags=["assets"])


class AssetCreateIn(BaseModel):
    kind: str = Field(pattern="^(export|sample|ir)$")
    # 없으면 개인 워크스페이스. 팀에 올리려면 그 조직 id 를 준다
    org_id: uuid.UUID | None = None
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

    # 한도는 **워크스페이스** 것이다. 개인 기준으로 세면 두 방향으로 틀린다 —
    # 팀이 Pro 를 결제해도 올리는 사람의 무료 한도에 막히고, 반대로 무료 조직에
    # 여러 명을 초대하면 인원수만큼 올릴 수 있다
    org = await orgs.resolve_org(session, user=user, org_id=body.org_id, need=orgs.EDIT)

    # 용량 한도는 **올리기 전에** 본다. 올린 뒤 거절하면 대역폭은 이미 썼다
    ent = await entitlements.resolve(session, org.id)
    limit_mb = ent.limits.get("storage_mb")
    if limit_mb is not None:
        used = (
            await session.execute(
                select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(
                    Asset.org_id == org.id, Asset.status == "ready"
                )
            )
        ).scalar_one()
        if used + body.size_bytes > limit_mb * 1024 * 1024:
            from resona.core.errors import LimitReached

            raise LimitReached(
                "저장 공간이 부족합니다",
                code="storage_limit_reached",
                details={
                "limit_mb": limit_mb,
                "used_mb": round(used / 1024 / 1024, 1),
                "org_id": str(org.id),
            },
            )

    asset_id = uuid.uuid4()
    ext = body.filename.rsplit(".", 1)[-1] if "." in body.filename else "bin"
    # 키에 **조직**을 넣는다. 버킷 정책으로 워크스페이스 단위 격리를 걸 수 있다
    key = storage.storage_key(owner_id=org.id, kind=body.kind, asset_id=asset_id, ext=ext)

    session.add(
        Asset(
            id=asset_id,
            org_id=org.id,
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
    if asset is None:
        raise NotFound("에셋을 찾을 수 없습니다", code="asset_not_found")
    # **조직 구성원이면 된다.** 올린 사람만 완료할 수 있게 하면 팀 작업이 막힌다
    await orgs.require_member(session, org_id=asset.org_id, user_id=user.id, need=orgs.EDIT)

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

    version = await projects.get_version_of(session, project.id, body.version_id)
    if version is None:
        raise NotFound("버전을 찾을 수 없습니다", code="version_not_found")

    asset = await session.get(Asset, body.asset_id)
    if asset is None or asset.org_id != project.org_id:
        # 다른 워크스페이스의 파일을 내 곡에 붙일 수 없다
        raise NotFound("에셋을 찾을 수 없습니다", code="asset_not_found")
    if asset.status != "ready":
        raise Conflict("업로드가 아직 끝나지 않았습니다", code="asset_not_ready")

    ent = await entitlements.resolve(session, project.org_id)
    export = await projects.record_export(
        session,
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

    # **조인하지 않는다.** 내보내기 이력은 곡 도메인, 파일은 에셋 도메인이다
    exports = await projects.exports_of(session, project_id, limit=limit)
    assets = await repository.get_many(session, [e.asset_id for e in exports])

    out: list[ExportOut] = []
    for export in exports:
        asset = assets.get(export.asset_id)
        if asset is None:
            continue
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


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> None:
    """에셋을 지운다 — **한도를 되돌릴 유일한 문**이다.

    삭제 API 가 없으면 용량 한도가 영구히 잠긴다. 그런데 지우는 방식에 조심할 것이
    둘 있다:

    1. **내보내기에 붙어 있으면 못 지운다.** 지우면 목록에 남은 내보내기가
       "재생도 다운로드도 안 되는 항목"이 된다. 내보내기를 먼저 지워야 한다.
    2. **스토리지 객체는 우리가 안 지운다.** 행만 지우고 버킷 수명주기 규칙에
       맡긴다 — 서버가 지우려 들면 스토리지가 잠깐 안 될 때 행만 사라지고 객체가
       남는다. 그게 진짜 누수다. 행이 없으면 어떤 객체가 고아인지도 모른다.
       그래서 `deleted` 상태로 표시해 두고 정리 잡이 그것만 지운다.
    """
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise NotFound("에셋을 찾을 수 없습니다", code="asset_not_found")
    await orgs.require_member(session, org_id=asset.org_id, user_id=user.id, need=orgs.EDIT)

    if await projects.export_exists_for_asset(session, asset_id):
        raise Conflict(
            "내보내기에 사용 중인 파일입니다. 내보내기를 먼저 삭제해 주세요",
            code="asset_in_use",
        )

    await session.delete(asset)
    await audit.record(
        session,
        action="asset.delete",
        actor_id=user.id,
        target_type="asset",
        target_id=asset_id,
        detail={"storage_key": asset.storage_key},
        ip=client_ip(request),
    )


@router.delete("/exports/{export_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_export(
    export_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> None:
    """내보내기 기록을 지운다.

    **라이선스 스냅샷도 함께 사라진다.** 그래서 지우는 것은 사용자의 명시적
    선택이어야 하고, 우리가 알아서 정리하지 않는다 (`SERVER_BILLING.md` 3절).
    """
    export = await projects.get_export(session, export_id)
    if export is None:
        raise NotFound("내보내기를 찾을 수 없습니다", code="export_not_found")

    project = await projects.get_project_row(session, export.project_id)
    if project is None:
        raise NotFound("내보내기를 찾을 수 없습니다", code="export_not_found")
    await orgs.require_member(session, org_id=project.org_id, user_id=user.id, need=orgs.EDIT)

    await session.delete(export)
    await audit.record(
        session,
        action="export.delete",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        ip=client_ip(request),
    )


class StorageOut(BaseModel):
    org_id: uuid.UUID
    used_bytes: int
    limit_bytes: int | None
    asset_count: int


@router.get("/storage", response_model=StorageOut)
async def storage_usage(
    session: Db, user: CurrentUser, org_id: uuid.UUID | None = None
) -> StorageOut:
    """**"왜 못 올리는지"를 화면에 보여 줄 수 있어야 한다.**

    한도에 걸렸을 때 사용자가 할 수 있는 일이 "뭘 지울지 고르는 것"인데,
    무엇이 얼마를 쓰고 있는지 볼 방법이 없으면 고를 수가 없다.
    """
    org = await orgs.resolve_org(session, user=user, org_id=org_id)
    row = (
        await session.execute(
            select(
                func.coalesce(func.sum(Asset.size_bytes), 0),
                func.count(Asset.id),
            ).where(Asset.org_id == org.id, Asset.status == "ready")
        )
    ).one()
    ent = await entitlements.resolve(session, org.id)
    limit_mb = ent.limits.get("storage_mb")
    return StorageOut(
        org_id=org.id,
        used_bytes=int(row[0]),
        limit_bytes=limit_mb * 1024 * 1024 if limit_mb is not None else None,
        asset_count=int(row[1]),
    )
