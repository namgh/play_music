"""진행 상황 전달 — Redis pub/sub (`SERVER.md` 절대 규칙: 팬아웃은 pub/sub).

문제: 워커가 처리한 잡의 진행 상황을, **그 사용자가 붙어 있는 API 인스턴스**로
보내야 한다. 워커는 그게 어느 인스턴스인지 모른다. 프로세스 안 큐로는 불가능하다.

그래서 워커는 채널에 publish 만 하고, SSE 를 들고 있는 인스턴스가 subscribe 한다.

**pub/sub 은 전달을 보장하지 않는다.** 구독자가 없는 순간의 메시지는 사라진다.
그래서 진실은 언제나 DB 에 있고 SSE 는 "빨리 알려 주는" 수단일 뿐이다 — 클라이언트는
연결이 끊기면 `GET /v1/jobs/{id}` 로 현재 상태를 다시 읽으면 된다. 이 성질을 지키는
한 Redis 가 죽어도 서비스는 폴링으로 돌아간다.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from app.core import redis as r

log = logging.getLogger(__name__)


def user_channel(user_id: str) -> str:
    """**사용자 단위 채널.** 잡 단위로 만들면 채널이 무한히 늘고, 구독을 시작하기
    전에 끝난 잡의 메시지를 영영 못 받는다"""
    return r.key("events", "user", user_id)


async def publish(user_id: str, event: dict[str, Any]) -> None:
    """**실패해도 삼킨다.** 알림이 안 갔다고 잡 처리를 실패시킬 이유가 없다 —
    클라이언트는 폴링으로 같은 상태를 알 수 있다"""
    try:
        await r.core().publish(user_channel(user_id), json.dumps(event, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        log.warning("event_publish_failed", extra={"user_id": user_id}, exc_info=True)


async def subscribe(user_id: str) -> AsyncIterator[dict[str, Any]]:
    """채널을 구독해 이벤트를 흘린다. 구독 자체가 실패하면 그냥 끝낸다 —
    호출한 쪽(SSE)은 하트비트만 보내고 클라이언트가 폴링으로 넘어간다"""
    pubsub = r.core().pubsub()
    try:
        await pubsub.subscribe(user_channel(user_id))
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                yield json.loads(message["data"])
            except (ValueError, TypeError):
                log.warning("event_payload_invalid")
    finally:
        try:
            await pubsub.aclose()
        except Exception:  # noqa: BLE001
            log.debug("pubsub_close_failed", exc_info=True)


def job_event(job_id: str, status: str, **extra: Any) -> dict[str, Any]:
    return {"type": "job", "job_id": job_id, "status": status, **extra}
