"""프로젝트 API — 목록·생성·조회·저장·버전.

**저장은 `If-Match` 를 요구한다** (`SERVER_OPS.md` 7절). 없으면 덮어쓰기가 기본값이
되고 그건 데이터 손실이다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from resona.core.deps import Db, client_ip
from resona.core.errors import Conflict, Forbidden, NotFound, Unprocessable
from resona.core.ratelimit import check as rate_check
from resona.domains.accounts.deps import ActiveUser, CurrentUser
from resona.domains.billing import service as entitlements
from resona.domains.ops import audit
from resona.domains.ops.idempotency import begin as idem_begin
from resona.domains.ops.idempotency import complete as idem_complete
from resona.domains.projects import repository
from resona.domains.projects.models import Project, ProjectVersion
from resona.domains.projects.service import get_project, load_version, save_document
from resona.domains.workspaces import service as orgs
from resona.domains.workspaces import service as workspaces_repo

router = APIRouter(prefix="/projects", tags=["projects"])

# **읽기는 정지 계정에도 열어 둔다** (`SERVER_ACCOUNTS.md` 1절). 정지는 서비스 이용
# 제한이지 창작물을 인질로 잡는 것이 아니다 — 편집(`ActiveUser`)만 막는다
ReadUser = CurrentUser


class ProjectSummary(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    updated_at: datetime
    head_version_id: uuid.UUID | None
    bpm: float | None
    key_tonic: str | None
    key_mode: str | None
    length_bars: int | None
    track_count: int | None
    instrument_ids: list[str] = Field(default_factory=list)


class ProjectDetail(ProjectSummary):
    document: dict[str, Any] | None
    seq: int


class CreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    document: dict[str, Any]
    # 없으면 개인 워크스페이스. 팀에서 만들려면 그 조직 id 를 준다
    org_id: uuid.UUID | None = None


class SaveIn(BaseModel):
    document: dict[str, Any]
    name: str | None = Field(default=None, max_length=200)


class ListOut(BaseModel):
    items: list[ProjectSummary]
    next_cursor: str | None


def _summary(p: Project) -> ProjectSummary:
    return ProjectSummary(
        id=p.id,
        org_id=p.org_id,
        name=p.name,
        updated_at=p.updated_at,
        head_version_id=p.head_version_id,
        bpm=float(p.bpm) if p.bpm is not None else None,
        key_tonic=p.key_tonic,
        key_mode=p.key_mode,
        length_bars=p.length_bars,
        track_count=p.track_count,
        instrument_ids=list(p.instrument_ids or []),
    )


@router.get("", response_model=ListOut)
async def list_projects(
    session: Db,
    user: ReadUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
    org_id: uuid.UUID | None = None,
) -> ListOut:
    """**커서 페이지네이션.** 오프셋은 편집이 잦으면 항목이 중복되거나 빠진다.

    `org_id` 를 주면 그 워크스페이스만, 안 주면 **내가 속한 전부**를 본다 —
    개인 곡과 팀 곡을 한 화면에서 찾을 수 있어야 한다.
    """
    if org_id is not None:
        await orgs.require_member(session, org_id=org_id, user_id=user.id)
    # **내가 속한 조직을 워크스페이스에 물어보고, 곡은 `org_id` 로만 고른다.**
    # 조인하면 곡 도메인이 `org_members` 의 모양에 묶인다
    roles = await workspaces_repo.roles_for_user(session, user.id)
    try:
        rows, next_cursor = await repository.list_for_orgs(
            session, list(roles), cursor=cursor, limit=limit, only_org=org_id
        )
    except repository.InvalidCursor:
        raise Unprocessable("커서가 올바르지 않습니다", code="invalid_cursor") from None
    return ListOut(items=[_summary(p) for p in rows], next_cursor=next_cursor)


@router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: CreateIn,
    request: Request,
    session: Db,
    user: ActiveUser,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> Any:
    replay = await idem_begin(
        session,
        key=idempotency_key,
        user_id=user.id,
        endpoint="POST /v1/projects",
        payload=body.model_dump(mode="json"),
    )
    if replay is not None:
        return Response(
            content=None, status_code=replay.status_code
        ) if not replay.body else replay.body

    # **무료 한도는 DB 에서 센다** (`SERVER.md` 5절). 코드로만 세면 프로세스 둘이
    # 동시에 통과한다. 자문 락으로 같은 사용자의 동시 생성만 직렬화한다
    # `org_id` 가 없으면 **개인 워크스페이스로 간다** — 처음 쓰는 사람에게
    # "먼저 워크스페이스를 고르세요"를 요구하면 거기서 절반이 떠난다
    org = await orgs.resolve_org(session, user=user, org_id=body.org_id, need=orgs.EDIT)

    ent = await entitlements.resolve(session, org.id)
    await entitlements.require_song_quota(session, ent, org.id)

    project = Project(org_id=org.id, owner_id=user.id, name=body.name)
    session.add(project)
    await session.flush()
    # **누적으로 센다.** 살아 있는 곡을 세면 지웠다 새로 만드는 것으로 무한히 우회된다
    await entitlements.record_usage(
        session, org_id=org.id, user_id=user.id, kind=entitlements.SONG_CREATED
    )

    version, _ = await save_document(
        session, project=project, doc=body.document, author_id=user.id, expected_head=None
    )
    await audit.record(
        session,
        action="project.create",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        ip=client_ip(request),
    )

    detail = ProjectDetail(
        **_summary(project).model_dump(), document=version.doc, seq=version.seq
    )
    await idem_complete(
        session, key=idempotency_key, status_code=201, body=detail.model_dump(mode="json")
    )
    return detail


# **고정 경로는 파라미터 경로보다 먼저 등록해야 한다.**
# FastAPI 는 등록 순서대로 매칭하므로, `/{project_id}` 가 먼저 있으면
# `GET /projects/trash` 가 그쪽에 걸려 UUID 파싱 실패로 422 가 난다 — 실제로 그랬다.
@router.get("/trash", response_model=list[ProjectSummary])
async def list_trash(
    session: Db,
    user: ReadUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    org_id: uuid.UUID | None = None,
) -> list[ProjectSummary]:
    """**30일 유예를 두는 이유가 되돌리기인데 되돌리는 문이 없었다.**"""
    if org_id is not None:
        await orgs.require_member(session, org_id=org_id, user_id=user.id)
    roles = await workspaces_repo.roles_for_user(session, user.id)
    rows = await repository.list_trashed(session, list(roles), limit=limit, only_org=org_id)
    return [_summary(p) for p in rows]


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_detail(project_id: uuid.UUID, session: Db, user: ReadUser) -> ProjectDetail:
    project = await get_project(session, project_id, user.id)
    if project.head_version_id is None:
        raise NotFound("아직 저장된 내용이 없습니다", code="no_version")
    version = await load_version(session, project.head_version_id)
    return ProjectDetail(**_summary(project).model_dump(), document=version.doc, seq=version.seq)


@router.put("/{project_id}", response_model=ProjectDetail)
async def save_project(
    project_id: uuid.UUID,
    body: SaveIn,
    request: Request,
    response: Response,
    session: Db,
    user: ActiveUser,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> ProjectDetail:
    await rate_check("project_save", str(user.id))
    project = await get_project(session, project_id, user.id, need=orgs.EDIT)

    if if_match is None:
        # **헤더가 없으면 거절한다.** 없으면 덮어쓰기가 기본값이 되고 그건 데이터 손실이다
        raise Conflict(
            "If-Match 헤더가 필요합니다",
            code="if_match_required",
            details={"current_version_id": str(project.head_version_id or "")},
        )

    try:
        expected = uuid.UUID(if_match.strip('"'))
    except ValueError:
        raise Unprocessable("If-Match 가 올바르지 않습니다", code="invalid_if_match") from None

    if body.name is not None:
        project.name = body.name

    version, created = await save_document(
        session,
        project=project,
        doc=body.document,
        author_id=user.id,
        expected_head=expected,
    )
    response.headers["ETag"] = f'"{version.id}"'
    if not created:
        # 같은 내용이었다. 새 버전을 만들지 않았음을 알린다
        response.headers["X-Version-Unchanged"] = "1"
    return ProjectDetail(**_summary(project).model_dump(), document=version.doc, seq=version.seq)


class VersionSummary(BaseModel):
    id: uuid.UUID
    seq: int
    origin: str
    size_bytes: int
    created_at: datetime


@router.get("/{project_id}/versions", response_model=list[VersionSummary])
async def list_versions(
    project_id: uuid.UUID,
    session: Db,
    user: ReadUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[VersionSummary]:
    """**기기 간 되돌리기.** 지금 언두는 브라우저 메모리에만 있다"""
    await get_project(session, project_id, user.id)
    rows = (
        await session.execute(
            select(ProjectVersion)
            .where(ProjectVersion.project_id == project_id)
            .order_by(ProjectVersion.seq.desc())
            .limit(limit)
        )
    ).scalars()
    return [
        VersionSummary(
            id=v.id, seq=v.seq, origin=v.origin, size_bytes=v.size_bytes, created_at=v.created_at
        )
        for v in rows
    ]


@router.get("/{project_id}/versions/{version_id}", response_model=ProjectDetail)
async def get_version(
    project_id: uuid.UUID, version_id: uuid.UUID, session: Db, user: ReadUser
) -> ProjectDetail:
    project = await get_project(session, project_id, user.id)
    version = await load_version(session, version_id)
    if version.project_id != project.id:
        raise NotFound("버전을 찾을 수 없습니다", code="version_not_found")
    return ProjectDetail(**_summary(project).model_dump(), document=version.doc, seq=version.seq)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> Response:
    """**소프트 삭제.** 30일 뒤 정리 잡이 실제로 지운다 — 곡을 잃는 것은 되돌릴 수 없다"""
    # 삭제는 편집보다 무겁다. editor 까지 허용하되 viewer 는 못 한다
    project = await get_project(session, project_id, user.id, need=orgs.EDIT)
    project.deleted_at = datetime.now(UTC)
    await audit.record(
        session,
        action="project.delete",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        ip=client_ip(request),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- 휴지통 · 이름변경 · 복제 -------------------------------------------------


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch("/{project_id}", response_model=ProjectSummary)
async def rename_project(
    project_id: uuid.UUID,
    body: RenameIn,
    request: Request,
    session: Db,
    user: ActiveUser,
) -> ProjectSummary:
    """**이름만 바꾼다.**

    이게 없으면 이름 하나 고치는 데 문서 전체를 내려받아 다시 올려야 하고,
    그 왕복 동안 다른 탭이 저장하면 낙관적 잠금에 걸린다 — 이름 바꾸기가
    충돌을 만드는 기능이 된다.
    """
    project = await get_project(session, project_id, user.id, need=orgs.EDIT)
    project.name = body.name
    project.updated_at = datetime.now(UTC)
    await audit.record(
        session,
        action="project.rename",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        ip=client_ip(request),
    )
    return _summary(project)


@router.post("/{project_id}/restore", response_model=ProjectSummary)
async def restore_project(
    project_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> ProjectSummary:
    """휴지통에서 되살린다. `get_project` 는 삭제된 것을 안 보므로 직접 찾는다"""
    project = await repository.get_deleted(session, project_id)
    if project is None:
        raise NotFound("프로젝트를 찾을 수 없습니다", code="project_not_found")
    role = await workspaces_repo.role_of(session, org_id=project.org_id, user_id=user.id)
    if role is None:
        raise NotFound("프로젝트를 찾을 수 없습니다", code="project_not_found")
    if orgs.ROLE_RANK[role] < orgs.ROLE_RANK[orgs.EDIT]:
        raise Forbidden("권한이 없습니다", code="insufficient_org_role")

    # **복구는 한도를 안 본다.** 한도가 누적(`song_created` 원장)으로 바뀌었으므로
    # 이 곡은 만들 때 이미 한 칸을 썼다. 복구할 때 또 세면 같은 곡을 두 번 물리는
    # 셈이고, 휴지통에서 되돌리는 것조차 막히면 "자리를 비우라"는 말을 들은 사용자가
    # 결국 곡을 영구 삭제하게 된다
    project.deleted_at = None
    project.updated_at = datetime.now(UTC)
    await audit.record(
        session,
        action="project.restore",
        actor_id=user.id,
        target_type="project",
        target_id=project.id,
        ip=client_ip(request),
    )
    return _summary(project)


@router.post("/{project_id}/duplicate", response_model=ProjectDetail, status_code=201)
async def duplicate_project(
    project_id: uuid.UUID, request: Request, session: Db, user: ActiveUser
) -> ProjectDetail:
    """**복제는 새 곡의 시작점이다.**

    이력은 가져오지 않는다 — 사본의 1번 버전이 원본의 현재 상태다. 이력까지
    복사하면 "누가 언제 만든 버전인가"가 두 곡에 갈라져 되돌리기가 헷갈린다.
    """
    source = await get_project(session, project_id, user.id, need=orgs.EDIT)
    if source.head_version_id is None:
        raise Conflict("아직 저장된 내용이 없습니다", code="no_version")
    head = await load_version(session, source.head_version_id)

    # **복제는 새 곡이다** — 한 칸을 쓴다. 안 세면 "복제"가 한도를 우회하는 길이 된다
    ent = await entitlements.resolve(session, source.org_id)
    await entitlements.require_song_quota(session, ent, source.org_id)

    copy = Project(org_id=source.org_id, owner_id=user.id, name=f"{source.name} 사본")
    session.add(copy)
    await session.flush()
    await entitlements.record_usage(
        session, org_id=source.org_id, user_id=user.id, kind=entitlements.SONG_CREATED
    )
    version, _ = await save_document(
        session, project=copy, doc=head.doc or {}, author_id=user.id, expected_head=None
    )
    await audit.record(
        session,
        action="project.duplicate",
        actor_id=user.id,
        target_type="project",
        target_id=copy.id,
        detail={"source": str(source.id)},
        ip=client_ip(request),
    )
    return ProjectDetail(
        **_summary(copy).model_dump(), document=version.doc, seq=version.seq
    )
