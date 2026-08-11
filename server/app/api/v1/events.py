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

from app.api.deps import CurrentUser, Db
from app.core import events
from app.db.models import AiJob

log = logging.getLogger(__name__)

router = APIRouter(tags=["events"])

# 이보다 오래 조용하면 죽은 연결로 오해받고 프록시가 끊는다.
# 하트비트는 주석 줄(`:`)이라 클라이언트가 파싱하지 않는다
HEARTBEAT_SEC = 20.0
# 연결을 영원히 두지 않는다. 배포 때 오래된 인스턴스가 안 비워지고,
# 클라이언트는 어차피 자동으로 다시 붙는다
MAX_LIFETIME_SEC = 3600.0


def _frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/events")
async def stream(request: Request, session: Db, user: CurrentUser) -> StreamingResponse:
    """`text/event-stream`. 이 사용자의 잡 상태 변화를 흘린다"""
    user_id = str(user.id)

    # 붙자마자 **현재 상태를 한 번 보낸다.** 구독 시작 전에 끝난 잡의 메시지는
    # pub/sub 에서 사라지므로, 이게 없으면 클라이언트가 영원히 기다린다
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
