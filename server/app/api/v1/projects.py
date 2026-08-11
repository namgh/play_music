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
from sqlalchemy import select, text

from app.api.deps import ActiveUser, CurrentUser, Db, client_ip
from app.core import audit
from app.core.errors import Conflict, NotFound, Unprocessable
from app.core.idempotency import begin as idem_begin
from app.core.idempotency import complete as idem_complete
from app.core.ratelimit import check as rate_check
from app.db.models import OrgMember, Project, ProjectVersion
from app.services import entitlements, orgs
from app.services.projects import get_project, load_version, save_document

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
    stmt = (
        select(Project)
        .join(OrgMember, OrgMember.org_id == Project.org_id)
        .where(OrgMember.user_id == user.id, Project.deleted_at.is_(None))
        .order_by(Project.updated_at.desc(), Project.id.desc())
        .limit(limit + 1)
    )
    if org_id is not None:
        await orgs.require_member(session, org_id=org_id, user_id=user.id)
        stmt = stmt.where(Project.org_id == org_id)
    if cursor:
        try:
            at, last_id = cursor.split("|", 1)
            stmt = stmt.where(
                text("(projects.updated_at, projects.id) < (:at, :lid)").bindparams(
                    at=datetime.fromisoformat(at), lid=uuid.UUID(last_id)
                )
            )
        except (ValueError, AttributeError):
            raise Unprocessable("커서가 올바르지 않습니다", code="invalid_cursor") from None

    rows = list((await session.execute(stmt)).scalars())
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = (
        f"{rows[-1].updated_at.isoformat()}|{rows[-1].id}" if has_more and rows else None
    )
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
    limit = ent.limits.get("projects")
    if limit is not None:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))").bindparams(
                k=str(org.id)
            )
        )
        count = (
            await session.execute(
                select(Project).where(
                    Project.org_id == org.id, Project.deleted_at.is_(None)
                )
            )
        ).scalars()
        if len(list(count)) >= limit:
            from app.core.errors import LimitReached

            raise LimitReached(
                f"현재 플랜은 프로젝트 {limit}개까지입니다",
                code="project_limit_reached",
                details={"limit": limit, "plan": ent.plan_code},
            )

    project = Project(org_id=org.id, owner_id=user.id, name=body.name)
    session.add(project)
    await session.flush()

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
