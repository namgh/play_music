"""인증 — 특히 **토큰 회전과 재사용 감지** (`SERVER_ACCOUNTS.md` 2-2)."""

from __future__ import annotations

from sqlalchemy import func, select

from resona.db.models import RefreshToken, User

PASSWORD = "correct-horse-battery"


async def test_signup_creates_personal_workspace_and_free_plan(client, unique_email, db):
    """**가입하면 개인 워크스페이스가 같이 생긴다.** 없으면 곡을 만들 곳이 없다 —
    개인 계정도 1인 조직이라는 것이 이 서비스의 전제다"""
    from resona.db.models import Organization, OrgMember, Subscription

    res = await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": PASSWORD}
    )
    assert res.status_code == 201
    # 확인 메일 전에도 **편집을 막지 않는다** — 첫 경험이 끊기면 안 된다
    assert res.json()["status"] == "pending_verification"

    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    org, role = (
        await db.execute(
            select(Organization, OrgMember.role)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user.id)
        )
    ).one()
    assert org.kind == "personal"
    assert role == "owner", "자기 워크스페이스의 owner 여야 과금·삭제를 할 수 있다"

    # 구독은 **조직**에 붙는다. 과금 단위가 조직이라서다
    sub = (
        await db.execute(select(Subscription).where(Subscription.org_id == org.id))
    ).scalar_one()
    assert sub.plan_code == "free"


async def test_signup_enqueues_verification_mail(client, unique_email, db):
    """**메일은 아웃박스를 거친다.** 요청 안에서 보내면 트랜잭션이 롤백돼도
    메일은 이미 나가 있다"""
    from resona.db.models import EmailOutbox

    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    row = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalar_one()
    assert row.template == "verify_email"
    assert row.status == "queued"
    # 링크만 담는다 — **토큰 원문이 DB 의 다른 곳에 남지 않게**
    assert row.payload["link"].startswith("http")


async def test_signup_with_existing_email_never_issues_tokens(client, unique_email, db):
    """**계정 탈취 회귀 테스트.**

    한때 이 경로가 "계정 열거 방지"라며 기존 계정의 액세스 토큰과 리프레시 쿠키를
    그대로 내줬다. 이메일 주소만 알면 아무 비밀번호로 남의 계정을 통째로 열 수 있었다.
    열거 방지가 인증 우회가 된 것이다.
    """
    from resona.db.models import EmailOutbox

    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    cookie_before = client.cookies.get("resona_refresh")

    res = await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": "attacker-guess-9999"}
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "email_taken"
    # **토큰이 응답 어디에도 없어야 한다**
    assert "access_token" not in res.text
    # 리프레시 쿠키도 새로 발급되지 않는다
    assert client.cookies.get("resona_refresh") == cookie_before

    # 주소 주인에게는 알린다 — 본인이면 재설정으로 안내되고, 아니면 경고가 된다
    mails = (
        await db.execute(
            select(EmailOutbox).where(
                EmailOutbox.to_email == unique_email,
                EmailOutbox.template == "signup_attempt",
            )
        )
    ).scalars().all()
    assert len(mails) == 1


async def test_signup_attempt_does_not_change_the_password(client, unique_email):
    """가입 시도가 기존 비밀번호를 덮어쓰지 않는다"""
    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": "attacker-guess-9999"}
    )

    assert (
        await client.post(
            "/v1/auth/login", json={"email": unique_email, "password": "attacker-guess-9999"}
        )
    ).status_code == 401
    assert (
        await client.post("/v1/auth/login", json={"email": unique_email, "password": PASSWORD})
    ).status_code == 200


async def test_login_does_not_reveal_whether_account_exists(client, unique_email):
    """존재 여부를 응답으로도 시간으로도 흘리지 않는다"""
    missing = await client.post(
        "/v1/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}
    )
    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    wrong = await client.post(
        "/v1/auth/login", json={"email": unique_email, "password": "wrong-password-here"}
    )
    assert missing.status_code == wrong.status_code == 401
    assert missing.json()["error"]["code"] == wrong.json()["error"]["code"] == "invalid_credentials"


async def test_failed_login_is_actually_recorded(client, unique_email, db):
    """**크리덴셜 스터핑을 볼 수 있어야 한다.**

    한때 이 기록이 한 건도 안 남고 있었다 — 401 이 트랜잭션을 롤백해서
    `audit.record` 가 통째로 사라졌다. "기록하고 있다고 믿는" 상태가 제일 나쁘다.
    """
    from resona.db.models import AuditLog

    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    for _ in range(3):
        await client.post(
            "/v1/auth/login", json={"email": unique_email, "password": "wrong-password-xx"}
        )

    rows = (
        await db.execute(
            select(AuditLog).where(AuditLog.action == "user.login_failed")
        )
    ).scalars().all()
    mine = [r for r in rows if (r.detail or {}).get("email") == unique_email]
    assert len(mine) == 3, "실패한 로그인이 감사 로그에 남지 않았다"


async def test_refresh_rotates_token(client, unique_email, db):
    await client.post("/v1/auth/signup", json={"email": unique_email, "password": PASSWORD})
    first = client.cookies.get("resona_refresh")
    assert first

    res = await client.post("/v1/auth/refresh")
    assert res.status_code == 200
    second = client.cookies.get("resona_refresh")
    assert second != first, "리프레시할 때마다 새 토큰이어야 한다"


async def test_refresh_reuse_kills_all_sessions(client, unique_email, db):
    """**탈취 감지.** 이미 회전된 토큰이 다시 오면 그 계정의 모든 세션을 끊는다"""
    signup = await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": PASSWORD}
    )
    user_id = signup.json()["user_id"]
    stolen = client.cookies.get("resona_refresh")

    # 정상 사용자가 회전시킨다
    assert (await client.post("/v1/auth/refresh")).status_code == 200

    # 공격자가 옛 토큰으로 시도한다
    client.cookies.set("resona_refresh", stolen)
    res = await client.post("/v1/auth/refresh")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "refresh_token_reused"

    live = (
        await db.execute(
            select(func.count())
            .select_from(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        )
    ).scalar_one()
    assert live == 0, "재사용이 감지되면 살아 있는 세션이 하나도 없어야 한다"


async def test_logout_all(client, unique_email, db):
    signup = await client.post(
        "/v1/auth/signup", json={"email": unique_email, "password": PASSWORD}
    )
    token = signup.json()["access_token"]
    res = await client.post(
        "/v1/auth/logout-all", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 204

    live = (
        await db.execute(
            select(func.count())
            .select_from(RefreshToken)
            .where(
                RefreshToken.user_id == signup.json()["user_id"],
                RefreshToken.revoked_at.is_(None),
            )
        )
    ).scalar_one()
    assert live == 0


async def test_expired_or_bogus_token_is_rejected(client):
    res = await client.get("/v1/projects", headers={"Authorization": "Bearer not.a.jwt"})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "invalid_token"


async def test_missing_token(client):
    res = await client.get("/v1/projects")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "missing_token"


async def test_password_rehash_on_cost_change():
    """비용을 올리면 **로그인 성공 시점에 재해싱**한다 (`security.verify_password`)"""
    from argon2 import PasswordHasher

    from resona.core.security import verify_password

    weak = PasswordHasher(memory_cost=8, time_cost=1, parallelism=1).hash(PASSWORD)
    ok, rehashed = verify_password(PASSWORD, weak)
    assert ok
    assert rehashed is not None and rehashed != weak


async def test_wrong_password_takes_similar_time_as_missing_user():
    """사용자가 없어도 더미와 비교해 시간을 맞춘다 — 존재 여부가 새지 않게"""
    import time

    from resona.core.security import hash_password, verify_password

    stored = hash_password(PASSWORD)

    t0 = time.perf_counter()
    verify_password("wrong-password-xx", stored)
    with_user = time.perf_counter() - t0

    t0 = time.perf_counter()
    verify_password("wrong-password-xx", None)
    without_user = time.perf_counter() - t0

    # 정확히 같을 수는 없지만 **자릿수가 같아야** 타이밍으로 못 알아낸다
    assert 0.2 < (without_user / with_user) < 5.0
