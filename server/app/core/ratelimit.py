"""레이트 리밋 — 토큰 버킷, Lua 로 원자 실행 (`SERVER_REDIS.md` 6절).

여러 명령으로 나누면 프로세스 간 경쟁이 그대로 구멍이 된다.

**장애 시 동작을 여기서 강제한다:**
  - 보통 엔드포인트는 통과 (fail-open) — 리밋 때문에 서비스가 멎는 게 더 나쁘다
  - 로그인·회원가입은 차단 (fail-closed) — 보안이 가용성보다 위
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from app.core import redis as r
from app.core.errors import RateLimited

log = logging.getLogger(__name__)

_SCRIPT = """
local b = redis.call("HMGET", KEYS[1], "t", "n")
local now, rate, burst, cost = tonumber(ARGV[1]), tonumber(ARGV[2]),
                               tonumber(ARGV[3]), tonumber(ARGV[4])
local t = tonumber(b[1]) or now
local n = tonumber(b[2]) or burst
n = math.min(burst, n + (now - t) * rate)
local ttl = math.ceil(burst / rate) * 2
if n < cost then
    redis.call("HMSET", KEYS[1], "t", now, "n", n)
    redis.call("EXPIRE", KEYS[1], ttl)
    return {0, math.ceil((cost - n) / rate)}
end
redis.call("HMSET", KEYS[1], "t", now, "n", n - cost)
redis.call("EXPIRE", KEYS[1], ttl)
return {1, 0}
"""


@dataclass(frozen=True)
class Limit:
    """`burst` 개까지 몰아 쓸 수 있고 초당 `rate` 개씩 회복된다"""

    rate_per_sec: float
    burst: int
    # 실패 시 막을 것인가. 보안 관련만 True
    fail_closed: bool = False


# 비용이 큰 것을 따로 센다 (`SERVER_REDIS.md` 6절)
LIMITS: dict[str, Limit] = {
    "login": Limit(10 / 900, 10, fail_closed=True),        # 10회 / 15분
    "signup": Limit(5 / 3600, 5, fail_closed=True),        # 5회 / 시간
    "project_save": Limit(1.0, 60),                        # 60회 / 분
    "upload_url": Limit(20 / 3600, 20),                    # 20회 / 시간
    "asset_create": Limit(30 / 3600, 30),                  # 서명 URL 발급 자체를 제한
    # 메일을 보내는 경로는 **남의 편지함을 괴롭히는 도구**가 될 수 있다. 세게 잠근다
    "password_reset": Limit(5 / 3600, 5, fail_closed=True),
    "org_invite": Limit(30 / 3600, 30, fail_closed=True),
    "org_create": Limit(10 / 3600, 10),
    # 로그인 시작은 비밀번호 검증이 없어 싸다. 공유 NAT 뒤 사용자를 막지 않게
    # login 보다 넉넉히 준다 — 대신 콜백에서 state 가 진짜 방어선이다
    "oauth_start": Limit(60 / 3600, 30),
    "ai_submit": Limit(10 / 3600, 10),                     # 플랜 한도와 별개인 남용 방어
}


async def check(bucket: str, identity: str, cost: int = 1) -> None:
    """초과면 `RateLimited` 를 던진다. `Retry-After` 를 함께 실어 준다"""
    limit = LIMITS[bucket]
    name = r.key("rl", bucket, identity)
    try:
        allowed, retry_after = await r.core().eval(
            _SCRIPT, 1, name, str(time.time()), str(limit.rate_per_sec), str(limit.burst), str(cost)
        )
    except Exception:  # noqa: BLE001
        log.warning("ratelimit_unavailable", extra={"bucket": bucket}, exc_info=True)
        if limit.fail_closed:
            raise RateLimited(
                "일시적으로 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요",
                code="rate_limit_unavailable",
                headers={"Retry-After": "30"},
            ) from None
        return  # fail-open

    if not int(allowed):
        raise RateLimited(
            "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요",
            details={"retry_after_sec": int(retry_after)},
            headers={"Retry-After": str(int(retry_after))},
        )
