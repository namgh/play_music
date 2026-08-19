"""헬스체크 — **두 개로 나눈다** (`SERVER_OPS.md` 3절).

안 나누면 준비 안 된 워커로 트래픽이 가거나(배포 중 5xx), DB 가 잠깐 느릴 때
컨테이너가 재시작을 반복한다(장애 증폭).
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from resona.core import redis as r
from resona.core.deps import Db

router = APIRouter(tags=["health"])

# **드레인 플래그.** SIGTERM 을 받으면 `/readyz` 가 먼저 실패로 바뀌어 LB 가 이
# 인스턴스를 뺀다. 그 다음에야 종료로 넘어간다 (`SERVER_OPS.md` 4절).
#
# 이게 없으면 롤링 배포마다 LB 는 죽는 중인 인스턴스로 계속 트래픽을 보내고,
# 사용자는 **저장 실패(5xx)** 를 본다. 저장 p95 SLO 이전의 문제다.
_draining = False


def begin_drain() -> None:
    global _draining
    _draining = True


def is_draining() -> bool:
    return _draining


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    """프로세스가 살아 있는가. **의존성을 보지 않는다** — 여기서 DB 를 보면
    DB 가 느릴 때 컨테이너가 죽고 재시작하며 장애가 커진다"""
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(session: Db, response: Response) -> dict[str, object]:
    """트래픽을 받을 준비가 됐는가. DB·Redis·**마이그레이션 리비전**까지 본다.

    종료 중이면 **가장 먼저** 실패로 답한다 — 나머지 검사가 성공해도 의미가 없다.
    """
    if is_draining():
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "draining", "checks": {}}

    checks: dict[str, object] = {}
    ok = True

    try:
        await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["database"] = f"error: {type(exc).__name__}"
        ok = False

    try:
        await r.core().ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        # Redis 는 캐시·리밋용이라 없어도 서비스는 돈다 (`SERVER_REDIS.md` 7절).
        # 준비 실패로 보지 않고 상태만 알린다
        checks["redis"] = f"degraded: {type(exc).__name__}"

    try:
        version = (
            await session.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one_or_none()
        checks["migration"] = version or "none"
        if version is None:
            # 마이그레이션이 안 돌았다 — 배포 순서가 꼬였다는 뜻이다.
            # 조용히 도는 것보다 트래픽에서 빠지는 게 낫다
            ok = False
    except Exception as exc:  # noqa: BLE001
        checks["migration"] = f"error: {type(exc).__name__}"
        ok = False

    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if ok else "not_ready", "checks": checks}
