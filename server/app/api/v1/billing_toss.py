"""토스페이먼츠 — 카드 등록(빌링키) (`SERVER_PAYMENTS.md` 3-1).

`billing.py` 와 나눠 둔다. 저기는 Stripe 모양(체크아웃 세션·포털)이고 여기는
빌링키 모양이라, 한 파일에 섞으면 "지금 어느 결제사의 흐름을 읽고 있는가"가
헷갈린다. 결제사는 언젠가 또 늘어난다.

## 흐름

    ① POST /v1/billing/toss/prepare   서버가 customer_key 를 만들어 준다
    ② 브라우저가 토스 SDK 로 카드 등록창을 띄운다  ← **카드번호는 여기까지만 간다**
    ③ POST /v1/billing/toss/issue     authKey 를 빌링키로 교환해 암호화 저장

**카드번호가 우리 서버에 오는 구간이 없다.** 그래서 PCI-DSS 범위 밖에 남는다.
"""

from __future__ import annotations

import logging
import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.api.deps import ActiveUser, Config, Db, client_ip
from app.core import audit, crypto
from app.core.errors import NotFound
from app.core.ratelimit import check as rate_check
from app.db.models import BillingCustomer, BillingKey
from app.services import orgs, toss

log = logging.getLogger(__name__)
router = APIRouter(tags=["billing"], prefix="/billing/toss")


class PrepareOut(BaseModel):
    customer_key: str
    #: 브라우저가 SDK 를 초기화할 때 쓰는 **공개** 키
    client_key: str


async def _resolve_customer(session: Db, org_id) -> BillingCustomer:
    """조직당 하나. **추측 불가능한 값으로 만든다.**

    이 값은 결제창 SDK 로 넘어가 브라우저에 노출된다. 조직 UUID 를 그대로 쓰면
    내부 식별자가 밖으로 나가고, 남이 "이 조직이 있는가"를 물어볼 수 있게 된다.
    """
    row = (
        await session.execute(
            select(BillingCustomer).where(BillingCustomer.org_id == org_id)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row

    customer = BillingCustomer(
        org_id=org_id, provider="toss", customer_key=secrets.token_urlsafe(24)
    )
    session.add(customer)
    await session.flush()
    return customer


@router.post("/prepare", response_model=PrepareOut)
async def prepare_billing(
    request: Request,
    session: Db,
    settings: Config,
    user: ActiveUser,
    org_id: uuid.UUID | None = None,
) -> PrepareOut:
    """카드 등록창을 띄우기 전에 부른다.

    **과금은 소유자만 건드린다** (`orgs.BILLING`). 편집자가 팀 카드를 바꿀 수 있으면
    그건 권한 설계가 아니라 사고다.
    """
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    if not settings.toss_client_key:
        raise toss.TossUnavailable("결제가 설정되지 않았습니다")

    customer = await _resolve_customer(session, org.id)
    await audit.record(
        session,
        action="billing.prepare",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )
    return PrepareOut(customer_key=customer.customer_key, client_key=settings.toss_client_key)


class IssueIn(BaseModel):
    # 토스 카드 등록창이 성공 URL 로 돌려주는 값
    auth_key: str = Field(min_length=1, max_length=300)
    customer_key: str = Field(min_length=1, max_length=300)
    org_id: uuid.UUID | None = None


class CardOut(BaseModel):
    brand: str | None
    last4: str | None
    registered_at: datetime


@router.post("/issue", response_model=CardOut)
async def issue_billing_key(
    body: IssueIn, request: Request, session: Db, settings: Config, user: ActiveUser
) -> CardOut:
    """`authKey` 를 **빌링키로 교환**해 암호화 저장한다.

    `customer_key` 를 그대로 믿지 않는다 — 남의 것을 보내서 그 조직에 카드를
    붙이려는 시도가 가능하다. **우리가 저장해 둔 값과 대조**한다.
    """
    await rate_check("billing_issue", str(user.id))
    org = await orgs.resolve_org(
        session, user=user, org_id=body.org_id, need=orgs.BILLING
    )

    customer = (
        await session.execute(
            select(BillingCustomer).where(BillingCustomer.org_id == org.id)
        )
    ).scalar_one_or_none()
    if customer is None or not secrets.compare_digest(
        customer.customer_key, body.customer_key
    ):
        # 남의 customer_key 로 붙이려는 시도. **무엇이 틀렸는지 알려주지 않는다**
        await audit.record(
            session,
            action="billing.issue_customer_mismatch",
            actor_id=user.id,
            target_type="organization",
            target_id=org.id,
            ip=client_ip(request),
        )
        await audit.persist_and_raise(
            session, NotFound("카드 등록 정보를 찾을 수 없습니다", code="customer_not_found")
        )

    issued = await toss.issue_billing_key(
        settings, auth_key=body.auth_key, customer_key=customer.customer_key
    )
    billing_key = str(issued.get("billingKey") or "")
    if not billing_key:
        raise toss.TossRejected("카드 등록에 실패했습니다", toss_code="no_billing_key")

    card = issued.get("card") or {}
    now = datetime.now(UTC)

    # **이전 카드를 먼저 회수한다.** 조직당 살아 있는 카드는 하나라는 규칙이
    # DB 인덱스로도 걸려 있어서, 안 끄면 여기서 유니크 위반이 난다.
    # 이력은 남는다 — "언제 어느 카드로 긁혔나"를 나중에 물어보게 된다
    await session.execute(
        update(BillingKey)
        .where(BillingKey.org_id == org.id, BillingKey.status == "active")
        .values(status="revoked", revoked_at=now)
    )

    session.add(
        BillingKey(
            org_id=org.id,
            billing_key_enc=crypto.encrypt(settings, billing_key),
            card_brand=card.get("issuerCode") or card.get("company"),
            card_last4=(card.get("number") or "")[-4:] or None,
            status="active",
        )
    )
    # **빌링키 자체는 절대 감사에 남기지 않는다.** 남기면 감사 로그가 곧 결제 수단이 된다
    await audit.record(
        session,
        action="billing.issue_key",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        detail={"card_last4": (card.get("number") or "")[-4:]},
        ip=client_ip(request),
    )
    return CardOut(
        brand=card.get("issuerCode") or card.get("company"),
        last4=(card.get("number") or "")[-4:] or None,
        registered_at=now,
    )


@router.get("/card", response_model=CardOut | None)
async def current_card(
    session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> CardOut | None:
    """등록된 카드를 보여준다. **복호화하지 않는다** — 표시용 컬럼만 읽는다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    row = (
        await session.execute(
            select(BillingKey).where(
                BillingKey.org_id == org.id, BillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return CardOut(brand=row.card_brand, last4=row.card_last4, registered_at=row.created_at)


@router.delete("/card", status_code=204)
async def remove_card(
    request: Request, session: Db, user: ActiveUser, org_id: uuid.UUID | None = None
) -> None:
    """카드를 뺀다. **구독은 여기서 해지하지 않는다** — 그건 별도 행위다
    (Day 6). 카드만 빠지면 다음 결제가 실패해 `past_due` 로 흘러간다"""
    org = await orgs.resolve_org(session, user=user, org_id=org_id, need=orgs.BILLING)
    await session.execute(
        update(BillingKey)
        .where(BillingKey.org_id == org.id, BillingKey.status == "active")
        .values(status="revoked", revoked_at=datetime.now(UTC))
    )
    await audit.record(
        session,
        action="billing.remove_card",
        actor_id=user.id,
        target_type="organization",
        target_id=org.id,
        ip=client_ip(request),
    )
