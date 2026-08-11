"""엔타이틀먼트 — 무엇을 할 수 있는가 (`SERVER_BILLING.md`).

한도는 **`plans` 테이블의 데이터**다. 코드에 박으면 캠페인·기업 플랜마다 배포해야 한다.

사용량은 **롤업 + 그 이후 원장**으로 센다. 매 요청마다 원장 전체를 세면 느리고,
카운터를 UPDATE 로 올리면 프로세스끼리 경쟁한다.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as r
from app.core.errors import LimitReached
from app.db.models import Plan, Subscription, UsageEvent, UsageRollup

log = logging.getLogger(__name__)

ENTITLEMENT_TTL_SEC = 60  # 결제 반영이 1분 안에 되면 충분하다

DEFAULT_FREE_LIMITS = {"projects": 5, "ai_monthly": 5, "storage_mb": 500}


@dataclass(frozen=True)
class Entitlements:
    plan_code: str
    status: str
    commercial_license: bool
    limits: dict[str, int]

    @property
    def ai_allowed(self) -> bool:
        # past_due 에서 즉시 차단하지 않는다 — 카드 만료로 작업이 막히는 경험이
        # 해지보다 나쁘다 (`SERVER_BILLING.md` 2절)
        return self.status in ("active", "canceling", "past_due")


async def resolve(session: AsyncSession, org_id: uuid.UUID) -> Entitlements:
    """**조직 단위다.** 개인도 1인 조직이라 경로가 하나뿐이다 (`app/services/orgs.py`)"""
    cached = await r.cache_get(r.key("ent", str(org_id)))
    if cached:
        data = json.loads(cached)
        return Entitlements(**data)

    row = (
        await session.execute(
            select(Subscription, Plan)
            .join(Plan, Plan.code == Subscription.plan_code, isouter=True)
            .where(Subscription.org_id == org_id)
        )
    ).first()

    if row is None:
        ent = Entitlements("free", "active", False, dict(DEFAULT_FREE_LIMITS))
    else:
        sub, plan = row
        ent = Entitlements(
            plan_code=sub.plan_code,
            status=sub.status,
            commercial_license=sub.commercial_license,
            limits=dict(plan.limits) if plan else dict(DEFAULT_FREE_LIMITS),
        )

    await r.cache_set(r.key("ent", str(org_id)), json.dumps(asdict(ent)), ENTITLEMENT_TTL_SEC)
    return ent


async def invalidate(org_id: uuid.UUID) -> None:
    """플랜이 바뀌면 즉시 무효화한다. 실패해도 60초 뒤 TTL 로 사라진다"""
    try:
        await r.cache().delete(r.key("ent", str(org_id)))
    except Exception:  # noqa: BLE001,S110
        # **삼키는 것이 맞다.** Redis 가 죽었다고 결제 반영을 실패시킬 이유가 없다 —
        # 60초 뒤 TTL 로 어차피 사라진다 (`SERVER_REDIS.md` 실패 모드 표)
        log.warning("entitlement_cache_invalidate_failed", exc_info=True)


def period_bounds(at: datetime | None = None) -> tuple[date, date]:
    """청구 주기 — 달력 월로 시작한다. 구독 시작일 기준으로 바꾸려면 여기만 고친다"""
    now = at or datetime.now(UTC)
    start = date(now.year, now.month, 1)
    end = date(now.year + (now.month == 12), (now.month % 12) + 1, 1)
    return start, end


async def usage_in_period(session: AsyncSession, org_id: uuid.UUID, kind: str) -> int:
    """롤업(정확하지만 오래된 것) + 그 이후 원장(작다)"""
    start, end = period_bounds()

    rollup = (
        await session.execute(
            select(UsageRollup).where(
                UsageRollup.org_id == org_id,
                UsageRollup.kind == kind,
                UsageRollup.period_start == start,
            )
        )
    ).scalar_one_or_none()

    base = rollup.quantity if rollup else 0
    since = rollup.rolled_at if rollup else datetime(start.year, start.month, 1, tzinfo=UTC)

    recent = (
        await session.execute(
            select(func.coalesce(func.sum(UsageEvent.quantity), 0)).where(
                UsageEvent.org_id == org_id,
                UsageEvent.kind == kind,
                UsageEvent.occurred_at >= since,
            )
        )
    ).scalar_one()
    return base + int(recent)


async def require_quota(
    session: AsyncSession, org_id: uuid.UUID, kind: str, limit_key: str
) -> None:
    """초과면 402. **경계에서 몇 건 더 나가는 것은 허용한다** — 정확히 막으려고
    매번 DB 를 치는 비용이 초과분보다 크다. 종량 과금을 도입하면 이 판단을 다시 한다."""
    ent = await resolve(session, org_id)
    limit = ent.limits.get(limit_key)
    if limit is None:
        return
    used = await usage_in_period(session, org_id, kind)
    if used >= limit:
        raise LimitReached(
            "이번 달 사용 한도를 다 썼습니다",
            code=f"{limit_key}_limit_reached",
            details={"limit": limit, "used": used, "plan": ent.plan_code},
        )


async def record_usage(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID | None,
    kind: str,
    quantity: int = 1,
    job_id: uuid.UUID | None = None,
) -> None:
    """**성공한 작업과 같은 트랜잭션에서** 부른다 (`SERVER_BILLING.md` 4-1).
    나누면 "생성은 됐는데 카운트가 안 된" 경우가 생기고 나중에 찾기 어렵다"""
    # 한도는 조직으로 세고, **누가 썼는지도 남긴다** — 팀에서 "이번 달 크레딧을
    # 누가 다 썼나"에 답할 수 있어야 한다
    session.add(
        UsageEvent(
            org_id=org_id, user_id=user_id, kind=kind, quantity=quantity, job_id=job_id
        )
    )
