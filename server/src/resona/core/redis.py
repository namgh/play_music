"""Redis — 두 인스턴스를 나눠 쓴다 (`SERVER_REDIS.md` 2절).

**캐시와 락을 같은 곳에 두면 안 된다.** 메모리가 차면 LRU 가 락 키를 조용히 축출하고,
그 순간 두 워커가 같은 임계 구역에 들어간다. 부하가 걸릴 때만 나서 재현이 거의 안 된다.

원칙: **Redis 가 통째로 사라져도 서비스는 느려질 뿐 돌아야 한다.**
"""

from __future__ import annotations

import logging
from typing import Any

from redis.asyncio import Redis

from resona.config import Settings

log = logging.getLogger(__name__)

_cache: Redis | None = None
_core: Redis | None = None
_prefix: str = "local:v1"


def init_redis(settings: Settings) -> None:
    global _cache, _core, _prefix
    _prefix = settings.key_prefix
    common: dict[str, Any] = {
        # 타임아웃을 짧게. Redis 가 느려지면 API 전체가 같이 느려지는데
        # 그건 캐시가 할 일이 아니다
        "socket_timeout": settings.redis_timeout_sec,
        "socket_connect_timeout": settings.redis_timeout_sec,
        "decode_responses": True,
    }
    _cache = Redis.from_url(str(settings.redis_cache_url), **common)
    _core = Redis.from_url(str(settings.redis_core_url), **common)


async def close_redis() -> None:
    global _cache, _core
    for client in (_cache, _core):
        if client is not None:
            await client.aclose()
    _cache = _core = None


def cache() -> Redis:
    if _cache is None:
        raise RuntimeError("init_redis 를 먼저 불러야 한다")
    return _cache


def core() -> Redis:
    if _core is None:
        raise RuntimeError("init_redis 를 먼저 불러야 한다")
    return _core


def key(*parts: str) -> str:
    """`{env}:{ver}:{domain}:{id}` — 접두어가 스테이징/운영 혼선을 막는다"""
    return ":".join((_prefix, *parts))


async def cache_get(name: str) -> str | None:
    """**캐시 실패는 조용히 미스로 처리한다.** 원본이 Postgres 에 있으니 느려질 뿐이다"""
    try:
        return await cache().get(name)
    except Exception:  # noqa: BLE001 — 캐시 때문에 요청이 실패하면 안 된다
        log.warning("redis_cache_get_failed", extra={"key": name}, exc_info=True)
        return None


async def cache_set(name: str, value: str, ttl_sec: int) -> None:
    """**TTL 없는 키를 만들지 않는다.** 영구 보관이 필요하면 Postgres 로 갈 데이터다"""
    try:
        await cache().set(name, value, ex=ttl_sec)
    except Exception:  # noqa: BLE001
        log.warning("redis_cache_set_failed", extra={"key": name}, exc_info=True)


# --- 분산 락 ---------------------------------------------------------------
# 짧은 상호배제용. **정합성 보장이 아니라 최적화다** — 실제 불변식은 DB 제약이 지킨다

_RELEASE_LOCK = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end
return 0
"""


async def acquire_lock(name: str, token: str, ttl_ms: int) -> bool:
    return bool(await core().set(name, token, nx=True, px=ttl_ms))


async def release_lock(name: str, token: str) -> None:
    """**내 토큰일 때만 지운다.** 안 그러면 내 작업이 TTL 을 넘겨 만료된 뒤
    다른 워커가 새로 잡은 락을 내가 푸는 일이 생긴다"""
    await core().eval(_RELEASE_LOCK, 1, name, token)
