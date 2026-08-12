"""SSE — 잡 진행 상황을 밀어 준다.

WebSocket 이 아니라 **SSE** 인 이유:
  - 단방향이면 충분하다. 클라이언트가 보낼 것은 이미 REST 로 간다
  - 프록시·로드밸런서를 그냥 통과한다 (HTTP 그대로다)
  - 끊기면 브라우저가 **알아서 다시 붙는다** (`EventSource` 기본 동작)

**진실은 언제나 DB 에 있다.** SSE 는 빨리 알려 주는 수단일 뿐이라, 이게 통째로
죽어도 클라이언트는 `GET /v1/jobs` 폴링으로 같은 상태를 안다. 이 성질을 지키는 한
Redis 장애가 기능 장애가 되지 않는다 (`SERVER_REDIS.md` 실패 모드 표).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import CurrentUser
from app.core import events
from app.core.errors import RateLimited
from app.db.models import AiJob
from app.db.session import session_scope

log = logging.getLogger(__name__)

router = APIRouter(tags=["events"])

# 이보다 오래 조용하면 죽은 연결로 오해받고 프록시가 끊는다.
# 하트비트는 주석 줄(`:`)이라 클라이언트가 파싱하지 않는다
HEARTBEAT_SEC = 20.0
# 연결을 영원히 두지 않는다. 배포 때 오래된 인스턴스가 안 비워지고,
# 클라이언트는 어차피 자동으로 다시 붙는다
MAX_LIFETIME_SEC = 3600.0
# 사용자당 동시 연결 상한. 탭을 잔뜩 열어 두는 사용자 하나가 Redis 구독과 태스크를
# 무한히 만들지 못하게 막는다. 넘치면 **폴링으로 유도한다** — 기능은 계속 된다
MAX_STREAMS_PER_USER = 4


def _frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/events")
async def stream(request: Request, user: CurrentUser) -> StreamingResponse:
    """`text/event-stream`. 이 사용자의 잡 상태 변화를 흘린다.

    **`Db` 의존성을 받지 않는다.** FastAPI 의 yield 의존성은 `StreamingResponse` 가
    끝날 때까지 닫히지 않는다 — 즉 연결 하나가 **최대 1시간 동안 Postgres 커넥션을
    idle-in-transaction 으로 점유**한다. 프로세스당 가용 커넥션이 10개(풀 5 + 오버플로
    5), 워커 4개면 전체 40. 편집기 탭 40개만 열려 있으면 그 뒤 모든 요청이 풀 대기
    5초 뒤 500 이 된다 — 저장·로그인·헬스체크까지 전부. 게다가 그 커넥션은 VACUUM 도
    막는다. 그래서 스냅샷을 읽는 동안만 세션을 열고 **바로 반납한다.**
    """
    user_id = str(user.id)

    # 붙자마자 **현재 상태를 한 번 보낸다.** 구독 시작 전에 끝난 잡의 메시지는
    # pub/sub 에서 사라지므로, 이게 없으면 클라이언트가 영원히 기다린다
    async with session_scope() as session:
        running = (
            (
                await session.execute(
                    select(AiJob)
                    .where(AiJob.user_id == user.id, AiJob.status.in_(("queued", "running")))
                    .order_by(AiJob.created_at.desc())
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        snapshot = [{"job_id": str(j.id), "status": j.status, "kind": j.kind} for j in running]
    # 여기서 커넥션은 이미 풀로 돌아갔다. 아래 스트림 루프는 DB 를 쓰지 않는다

    slot = await _take_slot(user_id)
    if slot is None:
        raise RateLimited(
            "동시에 열 수 있는 실시간 연결 수를 넘었습니다. 잠시 후 다시 시도해 주세요",
            code="too_many_streams",
            details={"limit": MAX_STREAMS_PER_USER, "fallback": "GET /v1/jobs 폴링"},
        )

    async def gen() -> AsyncIterator[str]:
        yield _frame("snapshot", {"jobs": snapshot})

        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)

        async def pump() -> None:
            try:
                async for event in events.subscribe(user_id):
                    # **큐가 차면 버린다.** 느린 클라이언트 하나가 서버 메모리를
                    # 먹게 두지 않는다 — 놓친 것은 폴링으로 복구된다
                    if queue.full():
                        with contextlib.suppress(asyncio.QueueEmpty):
                            queue.get_nowait()
                    await queue.put(event)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.warning("sse_pump_failed", exc_info=True)

        task = asyncio.create_task(pump())
        elapsed = 0.0
        try:
            while elapsed < MAX_LIFETIME_SEC:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SEC)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    elapsed += HEARTBEAT_SEC
                    continue
                yield _frame(event.get("type", "message"), event)
            else:
                # 수명이 다했음을 알린다. 클라이언트는 다시 붙으면 된다
                yield _frame("reconnect", {"reason": "max_lifetime"})
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await _release_slot(user_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            # nginx 가 버퍼링하면 이벤트가 뭉쳐서 늦게 도착한다
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _take_slot(user_id: str) -> bool | None:
    """동시 연결 수를 Redis 로 센다. **Redis 가 죽으면 그냥 통과시킨다** —
    알림 기능 때문에 서비스가 막히면 안 된다 (`SERVER_REDIS.md` 실패 모드 표)"""
    from app.core import redis as r

    key = r.key("sse", user_id)
    try:
        count = await r.core().incr(key)
        # 카운터가 새지 않게 TTL 을 건다. 프로세스가 죽어 감소를 못 해도 풀린다
        await r.core().expire(key, int(MAX_LIFETIME_SEC) + 60)
    except Exception:  # noqa: BLE001
        log.warning("sse_slot_unavailable", exc_info=True)
        return True
    if count > MAX_STREAMS_PER_USER:
        with contextlib.suppress(Exception):
            await r.core().decr(key)
        return None
    return True


async def _release_slot(user_id: str) -> None:
    from app.core import redis as r

    with contextlib.suppress(Exception):
        await r.core().decr(r.key("sse", user_id))
