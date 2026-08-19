"""프로젝트 저장 — 불변 버전 + head 포인터 (`SERVER.md` 3-2·3-3).

여기가 이 서비스의 심장이다. 규칙 셋:
  1. 버전은 **절대 UPDATE 하지 않는다**
  2. 저장은 **낙관적 잠금** — `expected_head` 가 어긋나면 409 에 현재 문서를 실어 보낸다
  3. 같은 내용을 다시 저장하면 **새 버전을 만들지 않는다** (`doc_sha256`)
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from resona.core.errors import Conflict, Forbidden, NotFound, Unprocessable
from resona.domains.projects import repository
from resona.domains.projects.models import Project, ProjectExport, ProjectVersion
from resona.domains.workspaces import service as workspaces
from resona.domains.workspaces.service import ROLE_RANK

# 이보다 크면 객체 스토리지로 보낸다. JSONB 에 수 MB 를 넣으면 목록 조회까지 느려진다
INLINE_DOC_LIMIT_BYTES = 1 * 1024 * 1024


def canonical_bytes(doc: dict[str, Any]) -> bytes:
    """해시는 **정규화한 뒤** 낸다. 키 순서가 달라도 같은 문서면 같은 해시여야 한다"""
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass(frozen=True)
class DerivedFields:
    """목록·검색·AI 힌트용. **진실은 문서이고 이건 사본이다**"""

    bpm: float | None
    key_tonic: str | None
    key_mode: str | None
    length_bars: int | None
    track_count: int | None
    instrument_ids: list[str]

    @classmethod
    def extract(cls, doc: dict[str, Any]) -> DerivedFields:
        tempo = doc.get("tempo") or {}
        key = doc.get("key") or {}
        tracks = doc.get("tracks") or []
        instruments = sorted(
            {t.get("instrumentId") for t in tracks if isinstance(t, dict) and t.get("instrumentId")}
        )
        return cls(
            bpm=_as_float(tempo.get("bpm")),
            key_tonic=key.get("tonic") if isinstance(key, dict) else None,
            key_mode=key.get("mode") if isinstance(key, dict) else None,
            length_bars=_as_int(doc.get("lengthBars")),
            track_count=len(tracks),
            instrument_ids=list(instruments),
        )


def _as_float(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) else None


def _as_int(v: Any) -> int | None:
    return int(v) if isinstance(v, int) else None


def validate_document(doc: Any) -> dict[str, Any]:
    """**서버는 문서의 내용을 해석하지 않는다** — 오디오는 클라이언트가 만든다.

    그래서 검사는 최소한이다: 객체인가, `schemaVersion` 이 있는가, 크기가 상식적인가.
    음표 하나하나를 검증하려 들면 클라이언트와 서버에 같은 규칙이 두 벌 생기고,
    그 둘은 반드시 갈라진다.
    """
    if not isinstance(doc, dict):
        raise Unprocessable("문서는 객체여야 합니다", code="invalid_document")
    if not isinstance(doc.get("schemaVersion"), int):
        raise Unprocessable("schemaVersion 이 없습니다", code="invalid_document")
    return doc


async def get_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    need: str = "viewer",
) -> Project:
    """**소속 조직의 구성원인지로 판단한다** — 만든 사람인지가 아니라.

    `owner_id` 로 보면 팀에서 남이 만든 곡을 아무도 못 연다. 반대로 조직만 보고
    역할을 안 보면 viewer 가 편집한다. 그래서 둘 다 본다.

    없거나 권한이 없으면 **404** 다. 403 은 "그 곡이 존재한다"를 알려 준다.
    """
    # **조인하지 않는다.** 곡을 먼저 찾고, 역할은 워크스페이스에 물어본다 —
    # 여기서 `org_members` 를 조인하면 곡 도메인이 그 테이블 모양에 묶인다.
    # 비회원에게는 여전히 404 다: 403 은 "그 곡이 존재한다"를 알려 준다
    project = await repository.get(session, project_id)
    if project is None:
        raise NotFound("프로젝트를 찾을 수 없습니다", code="project_not_found")
    role = await workspaces.role_of(session, org_id=project.org_id, user_id=user_id)
    if role is None:
        raise NotFound("프로젝트를 찾을 수 없습니다", code="project_not_found")
    if ROLE_RANK[role] < ROLE_RANK[need]:
        raise Forbidden(
            "권한이 없습니다",
            code="insufficient_org_role",
            details={"required": need, "actual": role},
        )
    return project


async def load_version(session: AsyncSession, version_id: uuid.UUID) -> ProjectVersion:
    version = await session.get(ProjectVersion, version_id)
    if version is None:
        raise NotFound("버전을 찾을 수 없습니다", code="version_not_found")
    return version


async def save_document(
    session: AsyncSession,
    *,
    project: Project,
    doc: dict[str, Any],
    author_id: uuid.UUID,
    expected_head: uuid.UUID | None,
    origin: str = "user",
    ai_job_id: uuid.UUID | None = None,
) -> tuple[ProjectVersion, bool]:
    """(버전, 새로 만들었는가)

    `expected_head` 는 **필수로 받는다** — 없으면 덮어쓰기가 기본값이 되고 그건
    데이터 손실이다 (`SERVER_OPS.md` 7절). 첫 저장만 None 을 허용한다.
    """
    if project.head_version_id != expected_head:
        current = (
            await load_version(session, project.head_version_id)
            if project.head_version_id
            else None
        )
        raise Conflict(
            "다른 곳에서 먼저 저장됐습니다",
            code="version_conflict",
            details={
                "current_version_id": str(project.head_version_id or ""),
                # **현재 문서를 함께 준다.** 안 그러면 클라이언트가 한 번 더 왕복해야
                # 하고 그 사이 또 바뀔 수 있다
                "current_document": current.doc if current else None,
                "current_seq": current.seq if current else 0,
            },
        )

    validate_document(doc)
    payload = canonical_bytes(doc)
    digest = hashlib.sha256(payload).digest()

    # 같은 내용이면 새 버전을 만들지 않는다. 자동 저장이 버전을 쌓지 않게 하는 장치다
    if project.head_version_id is not None:
        head = await load_version(session, project.head_version_id)
        if head.doc_sha256 == digest:
            return head, False

    next_seq = (
        await session.execute(
            select(func.coalesce(func.max(ProjectVersion.seq), 0)).where(
                ProjectVersion.project_id == project.id
            )
        )
    ).scalar_one() + 1

    inline = len(payload) <= INLINE_DOC_LIMIT_BYTES
    version = ProjectVersion(
        project_id=project.id,
        seq=next_seq,
        parent_id=project.head_version_id,
        schema_version=doc["schemaVersion"],
        doc=doc if inline else None,
        # 크면 객체 스토리지. 키만 남기고 본문은 밖에 둔다
        doc_key=None if inline else f"projects/{project.id}/{digest.hex()}.json",
        doc_sha256=digest,
        size_bytes=len(payload),
        created_by=author_id,
        origin=origin,
        ai_job_id=ai_job_id,
    )
    session.add(version)
    await session.flush()

    project.head_version_id = version.id
    project.updated_at = datetime.now(UTC)

    derived = DerivedFields.extract(doc)
    project.bpm = derived.bpm
    project.key_tonic = derived.key_tonic
    project.key_mode = derived.key_mode
    project.length_bars = derived.length_bars
    project.track_count = derived.track_count
    project.instrument_ids = derived.instrument_ids

    if not inline:
        # 객체 스토리지 업로드는 호출자가 한다. 여기서 하면 트랜잭션이 네트워크를 기다린다
        raise Unprocessable(
            "문서가 너무 큽니다. 분할 업로드를 사용하세요",
            code="document_too_large",
            details={"limit_bytes": INLINE_DOC_LIMIT_BYTES, "size_bytes": len(payload)},
        )

    return version, True


async def count_active(session: AsyncSession, org_id: uuid.UUID) -> int:
    """**곡 수는 곡 도메인이 센다.** 남이 `projects` 를 직접 세면 "휴지통 제외" 같은
    규칙이 두 곳에 생기고, 언젠가 한쪽만 고쳐진다"""
    return await repository.count_active(session, org_id)


async def get_version_of(session: AsyncSession, project_id, version_id):
    """그 곡의 버전인지까지 확인한다 — 남의 곡 버전을 붙이지 못하게"""
    version = await repository.get_version(session, version_id)
    if version is None or version.project_id != project_id:
        return None
    return version


async def record_export(session: AsyncSession, **fields):
    """**내보내기 이력은 곡의 것이다.** 에셋 도메인이 `ProjectExport` 를 직접
    만들면 곡의 이력 규칙(라이선스 스냅샷 등)이 두 곳으로 갈라진다"""
    export = ProjectExport(**fields)
    session.add(export)
    return export


async def exports_of(session: AsyncSession, project_id, *, limit: int = 50) -> list:
    from sqlalchemy import select as _select

    return list(
        (
            await session.execute(
                _select(ProjectExport)
                .where(ProjectExport.project_id == project_id)
                .order_by(ProjectExport.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )


async def export_exists_for_asset(session: AsyncSession, asset_id) -> bool:
    from sqlalchemy import select as _select

    return (
        await session.execute(
            _select(ProjectExport.id).where(ProjectExport.asset_id == asset_id).limit(1)
        )
    ).first() is not None


async def get_export(session: AsyncSession, export_id):
    return await session.get(ProjectExport, export_id)


async def get_project_row(session: AsyncSession, project_id):
    """권한 검사 없이 곡 행만. **권한이 필요한 경로에서는 `get_project` 를 쓴다**"""
    return await session.get(Project, project_id)


async def counts_by_owner(session: AsyncSession, owner_ids) -> dict:
    return await repository.counts_by_owner(session, owner_ids)
