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
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from resona.core import redis as r
from resona.core.errors import LimitReached
from resona.db.models import EntitlementGrant, Plan, Subscription, UsageEvent, UsageRollup

log = logging.getLogger(__name__)

ENTITLEMENT_TTL_SEC = 60  # 결제 반영이 1분 안에 되면 충분하다

# 베타 기본값 (`SERVER_PAYMENTS.md` 0절). `songs_total` 은 **누적**이다 —
# 지우고 새로 만들어도 안 돌아온다. 안 그러면 무료 체험이 무한이 된다
DEFAULT_FREE_LIMITS = {"songs_total": 5, "ai_monthly": 0, "storage_mb": 2000}

# 누적 곡 수를 세는 원장의 `kind`
SONG_CREATED = "song_created"

#: `songs_total` 로 이름을 바꾸기 전의 키. 옛 플랜 행이 남아 있으면 **무제한으로
#: 열리는 대신** 이 값을 쓴다 — 매출을 지키는 한도라 열리는 쪽으로 틀리면 안 된다
_LEGACY_SONG_KEY = "projects"


@dataclass(frozen=True)
class Entitlements:
    plan_code: str
    status: str
    commercial_license: bool
    limits: dict[str, int]
    #: 지금 적용 중인 부여의 `kind` 들. 화면이 "베타 무료 이용 중"을 보여줄 수 있게
    grants: tuple[str, ...] = ()

    @property
    def ai_allowed(self) -> bool:
        # past_due 에서 즉시 차단하지 않는다 — 카드 만료로 작업이 막히는 경험이
        # 해지보다 나쁘다 (`SERVER_BILLING.md` 2절)
        return self.status in ("active", "canceling", "past_due")


def _limit_of(limits: dict, key: str) -> int | None:
    """`None` 은 **무제한**이다. 키가 없어도 무제한 — 단 `songs_total` 만은
    옛 이름(`projects`)을 먼저 본다. 이름을 바꾸다 한도가 통째로 풀리면
    무료로 무한히 쓰게 된다"""
    if key == "songs_total" and key not in limits and _LEGACY_SONG_KEY in limits:
        log.warning("plan_uses_legacy_limit_key", extra={"key": _LEGACY_SONG_KEY})
        return limits[_LEGACY_SONG_KEY]
    return limits.get(key)


def _merge_limits(base: dict, extra: dict) -> dict:
    """**부여는 혜택이지 제약이 아니다** — 항상 후한 쪽을 남긴다.

    `None`(무제한)이 어떤 숫자보다도 후하다. 부여에 **없는 키는 손대지 않는다** —
    빈 `{}` 부여가 모든 한도를 무제한으로 열어 버리면 쿠폰 하나로 요금제가 무너진다.
    """
    merged = dict(base)
    for key, value in extra.items():
        if key not in merged:
            # 플랜에 없는 키 = 이미 무제한. 부여가 그걸 좁힐 수는 없다
            continue
        current = merged[key]
        if current is None or value is None:
            merged[key] = None
        else:
            merged[key] = max(current, value)
    return merged


async def _active_grants(
    session: AsyncSession, org_id: uuid.UUID
) -> list[EntitlementGrant]:
    now = datetime.now(UTC)
    return list(
        (
            await session.execute(
                select(EntitlementGrant).where(
                    EntitlementGrant.org_id == org_id,
                    EntitlementGrant.revoked_at.is_(None),
                    EntitlementGrant.starts_at <= now,
                    (EntitlementGrant.ends_at.is_(None)) | (EntitlementGrant.ends_at > now),
                )
            )
        ).scalars()
    )


async def resolve(session: AsyncSession, org_id: uuid.UUID) -> Entitlements:
    """**조직 단위다.** 개인도 1인 조직이라 경로가 하나뿐이다 (`app/services/orgs.py`)

    판정은 **구독 + 유효한 부여들의 합성**이다 (`SERVER_PAYMENTS.md` 4절).
    베타 3개월 무료·쿠폰·AI 리워드가 전부 부여로 들어오므로, 구독 하나만 보면
    "결제 안 했는데 써야 하는" 사람을 설명할 수 없다.
    """
    cached = await r.cache_get(r.key("ent", str(org_id)))
    if cached:
        data = json.loads(cached)
        # JSON 왕복에서 튜플이 리스트가 된다 — 프로즌 데이터클래스라 되돌려 준다
        data["grants"] = tuple(data.get("grants", ()))
        return Entitlements(**data)

    row = (
        await session.execute(
            select(Subscription, Plan)
            .join(Plan, Plan.code == Subscription.plan_code, isouter=True)
            .where(Subscription.org_id == org_id)
        )
    ).first()

    if row is None:
        plan_code, status, commercial = "free", "active", False
        limits = dict(DEFAULT_FREE_LIMITS)
    else:
        sub, plan = row
        plan_code, status, commercial = sub.plan_code, sub.status, sub.commercial_license
        limits = dict(plan.limits) if plan else dict(DEFAULT_FREE_LIMITS)

    applied: list[str] = []
    for grant in await _active_grants(session, org_id):
        limits = _merge_limits(limits, grant.limits or {})
        commercial = commercial or grant.commercial_license
        applied.append(grant.kind)

    ent = Entitlements(
        plan_code=plan_code,
        status=status,
        commercial_license=commercial,
        limits=limits,
        grants=tuple(applied),
    )
    await r.cache_set(r.key("ent", str(org_id)), json.dumps(asdict(ent)), ENTITLEMENT_TTL_SEC)
    return ent


async def usage_total(session: AsyncSession, org_id: uuid.UUID, kind: str) -> int:
    """**전 기간 누적.** 무료 체험(누적 5곡)처럼 달마다 리셋되면 안 되는 한도용이다.

    롤업을 더하지 않고 원장만 센다 — `roll_up_usage` 는 **접기만 하고 지우지 않으므로**
    (`app/scheduler/main.py`) 원장만 세는 것이 정확하다. 둘을 더하면 이중 계산이다.
    """
    return int(
        (
            await session.execute(
                select(func.coalesce(func.sum(UsageEvent.quantity), 0)).where(
                    UsageEvent.org_id == org_id, UsageEvent.kind == kind
                )
            )
        ).scalar_one()
    )


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


async def require_song_quota(
    session: AsyncSession, ent: Entitlements, org_id: uuid.UUID
) -> None:
    """무료 체험의 **누적 곡 한도**. 초과면 402.

    `require_quota` 와 달리 **경계를 정확히 막는다.** 저기서는 몇 건 새도 원가가
    작지만, 여기는 "무료로 몇 곡까지 만드나"가 곧 결제할 이유라 새면 안 된다.
    자문 락으로 같은 조직의 동시 생성만 직렬화한다 — 코드로만 세면 프로세스 둘이
    같이 통과한다.
    """
    limit = _limit_of(ent.limits, "songs_total")
    if limit is None:
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))").bindparams(
            k=str(org_id)
        )
    )
    used = await usage_total(session, org_id, SONG_CREATED)
    if used >= limit:
        raise LimitReached(
            f"무료로 만들 수 있는 {limit}곡을 모두 사용했습니다",
            code="song_limit_reached",
            # **기존 곡은 계속 쓸 수 있다**는 걸 화면이 말해 줘야 한다.
            # 만든 걸 못 여는 줄 알면 결제가 아니라 이탈이 나온다
            details={"limit": limit, "used": used, "plan": ent.plan_code,
                     "existing_songs_still_editable": True},
        )


async def grant_beta_free(
    session: AsyncSession, org_id: uuid.UUID, months: int, *, reason: str = "베타 테스트"
) -> None:
    """가입 시 **베타 무료 이용권**을 준다 (`SERVER_PAYMENTS.md` 5절).

    구독이 아니라 **부여**다. 구독 행에 "결제 안 했는데 active" 를 써 넣으면
    결제 코드가 그걸 다시 해석해야 하고, 그러면 "왜 이 사람은 청구가 안 되지"를
    매번 되짚게 된다.

    만료되면 자동으로 무료 티어로 내려온다 — 끄는 잡이 필요 없다. `resolve()` 가
    `ends_at` 을 보고 판정하기 때문이다. **곡은 안 지운다. 새 곡만 막힌다.**
    """
    if months <= 0:
        return
    now = datetime.now(UTC)
    ends = now
    for _ in range(months):
        year = ends.year + (ends.month == 12)
        month = ends.month % 12 + 1
        last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
        ends = ends.replace(year=year, month=month, day=min(ends.day, last))

    session.add(
        EntitlementGrant(
            org_id=org_id,
            kind="beta_free",
            # 베타는 **유료 티어를 그대로 준다** — 무료 티어를 조금 늘리는 게 아니다.
            # 그래야 "돈 낼 만한가"를 사용자가 실제로 판단할 수 있다
            limits={"songs_total": None, "storage_mb": 50000},
            commercial_license=True,
            ends_at=ends,
            reason=reason,
        )
    )
    await invalidate(org_id)
