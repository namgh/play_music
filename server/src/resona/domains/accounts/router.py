"""인증 — 가입·로그인·회전·로그아웃 (`SERVER_ACCOUNTS.md` 2절)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update

from resona.core.deps import Config, Db, client_ip
from resona.core.errors import Conflict, Unauthorized
from resona.core.ratelimit import check as rate_check
from resona.core.security import (
    create_access_token,
    hash_password,
    hash_token,
    new_opaque_token,
    verify_password,
)
from resona.domains.accounts import provider_google as google_oauth
from resona.domains.accounts.deps import ActiveUser
from resona.domains.accounts.models import AuthIdentity, EmailToken, RefreshToken, User
from resona.domains.billing import service as billing
from resona.domains.billing import service as entitlements
from resona.domains.ops import audit
from resona.domains.ops import mail as mail
from resona.domains.workspaces import service as orgs

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "resona_refresh"


class SignupIn(BaseModel):
    email: EmailStr
    # 복잡도 규칙은 걸지 않는다 — 실효가 없고 사용자가 더 나쁜 비밀번호를 만든다
    password: str = Field(min_length=10, max_length=200)
    display_name: str = Field(default="", max_length=100)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


class TokenOut(BaseModel):
    access_token: str
    expires_in: int
    user_id: uuid.UUID
    status: str


def _set_refresh_cookie(response: Response, token: str, ttl_sec: int, secure: bool) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=ttl_sec,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/v1/auth",
    )


async def _issue_tokens(
    session: Db,
    response: Response,
    settings: Config,
    user: User,
    *,
    user_agent: str | None,
    rotated_from: uuid.UUID | None = None,
) -> TokenOut:
    refresh = new_opaque_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(refresh),
            expires_at=datetime.now(UTC) + timedelta(seconds=settings.refresh_token_ttl_sec),
            user_agent=(user_agent or "")[:500] or None,
            rotated_from=rotated_from,
        )
    )
    _set_refresh_cookie(
        response, refresh, settings.refresh_token_ttl_sec, secure=settings.is_production
    )
    access = create_access_token(
        secret=settings.jwt_secret.get_secret_value(),
        subject=str(user.id),
        ttl_sec=settings.access_token_ttl_sec,
        extra={"role": user.platform_role},
    )
    return TokenOut(
        access_token=access,
        expires_in=settings.access_token_ttl_sec,
        user_id=user.id,
        status=user.status,
    )


VERIFY_TTL_HOURS = 24
RESET_TTL_HOURS = 2


async def _send_verify_mail(session: Db, user: User) -> None:
    """**토큰 원문은 메일로만 간다.** DB 에도 응답에도 해시만 남는다"""
    token = new_opaque_token()
    session.add(
        EmailToken(
            user_id=user.id,
            kind="verify",
            token_hash=hash_token(token),
            expires_at=datetime.now(UTC) + timedelta(hours=VERIFY_TTL_HOURS),
        )
    )
    await mail.enqueue(
        session,
        to_email=user.email,
        template="verify_email",
        payload={"link": mail.link("/verify", token), "expires_hours": VERIFY_TTL_HOURS},
    )


@router.post("/signup", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def signup(
    body: SignupIn, request: Request, response: Response, session: Db, settings: Config
) -> TokenOut:
    ip = client_ip(request) or "unknown"
    await rate_check("signup", ip)

    email = body.email.lower()
    existing = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        # **여기서 토큰을 발급하면 계정 탈취다.**
        #
        # 원래 이 자리에는 "계정 열거를 막으려고 신규 가입과 같은 응답을 준다"는
        # 코드가 있었다. 그런데 그 '같은 응답'에 액세스 토큰과 리프레시 쿠키가
        # 들어 있어서, **이메일 주소만 알면 아무 비밀번호로 가입을 시도해 그 계정을
        # 통째로 열 수 있었다.** 열거 방지가 인증 우회가 된 것이다.
        #
        # 그래서 판단을 뒤집었다: **가입 단계의 열거는 받아들이고, 토큰은 절대
        # 발급하지 않는다.** 근거는 셋이다.
        #   1. 인증하지 않은 계정의 자격증명을 내주는 것은 어떤 이득과도 안 바꾼다
        #   2. 가입에서 존재를 감춰도 실사용 제품에서는 결국 드러난다
        #      (대부분의 서비스가 "이미 가입된 주소입니다"를 그대로 말한다)
        #   3. **로그인 경로의 열거 방지는 그대로 유지한다** — 크리덴셜 스터핑이
        #      실제로 일어나는 곳은 거기다 (`login` 참고)
        #
        # 대신 주소 주인에게 "누군가 이 주소로 가입을 시도했다"를 알린다. 본인이
        # 비밀번호를 잊은 것이면 재설정으로 안내되고, 아니면 경고가 된다.
        await mail.enqueue(
            session,
            to_email=existing.email,
            template="signup_attempt",
            payload={"link": mail.link("/login", ""), "expires_hours": RESET_TTL_HOURS},
        )
        await audit.record(
            session, action="user.signup_existing_email", actor_id=existing.id, ip=ip
        )
        # 알림 메일과 감사 로그를 **커밋하고 나서** 거절한다 (`audit.persist_and_raise`)
        await audit.persist_and_raise(
            session, Conflict("이미 가입된 주소입니다. 로그인해 주세요", code="email_taken")
        )

    user = User(email=email, display_name=body.display_name, status="pending_verification")
    # **첫 운영자 부트스트랩** (`config.bootstrap_owner_email`). 없으면 어드민 API
    # 전체가 아무도 못 쓰는 상태로 뜬다. 신규 가입에만 적용되고 기존 계정은
    # 승격하지 않는다 — 환경변수만으로 남의 계정을 운영자로 만들 수 있으면
    # 그게 곧 권한 상승 경로다
    if settings.bootstrap_owner_email and email == settings.bootstrap_owner_email.lower():
        user.platform_role = "owner"
    session.add(user)
    await session.flush()

    session.add(
        AuthIdentity(
            user_id=user.id,
            provider="password",
            subject=email,
            secret_hash=hash_password(body.password),
        )
    )
    # **개인 워크스페이스를 여기서 만든다.** 없으면 곡을 만들 곳이 없다 —
    # 개인 계정도 1인 조직이라는 것이 이 서비스의 전제다 (`app/services/orgs.py`)
    org = await orgs.create_personal_org(session, user)
    # 무료 구독은 **조직**에 붙는다. 과금 단위가 조직이라서다
    await billing.start_free(session, org.id)
    # 베타 무료 이용권 — **카드 없이** 준다 (`SERVER_PAYMENTS.md` 5절)
    await entitlements.grant_beta_free(session, org.id, settings.beta_free_months)
    await _send_verify_mail(session, user)
    await audit.record(
        session,
        action="user.signup",
        actor_id=user.id,
        detail={"platform_role": user.platform_role},
        ip=ip,
    )

    return await _issue_tokens(
        session, response, settings, user, user_agent=request.headers.get("user-agent")
    )


@router.post("/login", response_model=TokenOut)
async def login(
    body: LoginIn, request: Request, response: Response, session: Db, settings: Config
) -> TokenOut:
    ip = client_ip(request) or "unknown"
    email = body.email.lower()
    # 계정과 IP 를 **둘 다** 센다. 하나만 세면 우회가 쉽다
    await rate_check("login", ip)
    await rate_check("login", f"email:{email}")

    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.provider == "password", AuthIdentity.subject == email
            )
        )
    ).scalar_one_or_none()

    # 사용자가 없어도 **같은 시간**을 쓴다 (`security.verify_password` 가 더미와 비교)
    ok, rehashed = verify_password(body.password, identity.secret_hash if identity else None)
    if not ok or identity is None:
        # **여기가 비어 있었다.** 401 이 트랜잭션을 롤백해서 로그인 실패 기록이
        # 한 건도 안 남고 있었다 — 크리덴셜 스터핑을 볼 방법이 없었다는 뜻이다
        await audit.record(session, action="user.login_failed", detail={"email": email}, ip=ip)
        await audit.persist_and_raise(
            session,
            Unauthorized("이메일 또는 비밀번호가 올바르지 않습니다", code="invalid_credentials"),
        )

    if rehashed:
        identity.secret_hash = rehashed  # 비용을 올렸으면 로그인 성공 시점에 재해싱

    user = await session.get(User, identity.user_id)
    # **`deleted` 는 로그인시킨다.** 30일 유예 안에 스스로 되돌릴 수 있어야 하고,
    # 그 경로가 `POST /v1/me/restore` 다. 완전히 파기된 `purged` 만 막는다
    if user is None or user.status == "purged":
        raise Unauthorized("이메일 또는 비밀번호가 올바르지 않습니다", code="invalid_credentials")

    user.last_seen_at = datetime.now(UTC)
    await audit.record(session, action="user.login", actor_id=user.id, ip=ip)
    return await _issue_tokens(
        session, response, settings, user, user_agent=request.headers.get("user-agent")
    )


@router.post("/refresh", response_model=TokenOut)
async def refresh(request: Request, response: Response, session: Db, settings: Config) -> TokenOut:
    """**회전 + 재사용 감지.** 이미 회전된 토큰이 다시 오면 탈취로 보고 전 세션을 끊는다"""
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise Unauthorized("리프레시 토큰이 없습니다", code="missing_refresh_token")

    token = (
        await session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw))
        )
    ).scalar_one_or_none()
    if token is None:
        raise Unauthorized("리프레시 토큰이 올바르지 않습니다", code="invalid_refresh_token")

    now = datetime.now(UTC)
    if token.revoked_at is not None:
        # **여기가 탈취 감지 지점이다.** 이미 폐기된 토큰이 다시 왔다는 것은
        # 누군가 옛 토큰을 들고 있다는 뜻이다
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == token.user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await audit.record(
            session,
            action="auth.refresh_reuse_detected",
            actor_id=token.user_id,
            ip=client_ip(request),
        )
        # 폐기를 **커밋하고 나서** 거절한다. 그냥 raise 하면 롤백돼서 보안 통제가
        # 조용히 아무 일도 안 한다 (`audit.persist_and_raise` 의 주석 참고)
        await audit.persist_and_raise(
            session,
            Unauthorized("보안을 위해 모든 세션을 종료했습니다", code="refresh_token_reused"),
        )

    if token.expires_at <= now:
        raise Unauthorized("리프레시 토큰이 만료됐습니다", code="refresh_token_expired")

    user = await session.get(User, token.user_id)
    if user is None or user.status in ("deleted", "purged"):
        raise Unauthorized("계정을 찾을 수 없습니다", code="account_not_found")

    token.revoked_at = now
    return await _issue_tokens(
        session,
        response,
        settings,
        user,
        user_agent=request.headers.get("user-agent"),
        rotated_from=token.id,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, session: Db) -> Response:
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw:
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_token(raw), RefreshToken.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC))
        )
    response.delete_cookie(REFRESH_COOKIE, path="/v1/auth")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(request: Request, session: Db, user: ActiveUser) -> Response:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await audit.record(
        session, action="auth.logout_all", actor_id=user.id, ip=client_ip(request)
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- 이메일 확인 · 비밀번호 재설정 -------------------------------------------


class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


@router.post("/verify-email", status_code=status.HTTP_204_NO_CONTENT)
async def verify_email(body: TokenIn, request: Request, session: Db) -> Response:
    """확인 링크. **확인 전에도 편집은 막지 않는다** — 첫 경험이 끊기면 안 된다.
    확인은 발신 평판과 계정 복구를 위한 것이지 기능 잠금이 아니다"""
    token = (
        await session.execute(
            select(EmailToken).where(
                EmailToken.token_hash == hash_token(body.token), EmailToken.kind == "verify"
            )
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if token is None or token.used_at is not None or token.expires_at <= now:
        raise Unauthorized("링크가 만료됐거나 올바르지 않습니다", code="token_invalid")

    user = await session.get(User, token.user_id)
    if user is None:
        raise Unauthorized("계정을 찾을 수 없습니다", code="account_not_found")

    token.used_at = now
    user.email_verified_at = now
    if user.status == "pending_verification":
        user.status = "active"
    await audit.record(session, action="user.verify_email", actor_id=user.id, ip=client_ip(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class ForgotIn(BaseModel):
    email: EmailStr


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(body: ForgotIn, request: Request, session: Db) -> dict[str, str]:
    """**계정이 없어도 같은 응답을 준다.** 여기서 갈리면 가입 여부 확인기가 된다"""
    ip = client_ip(request) or "unknown"
    await rate_check("password_reset", ip)
    await rate_check("password_reset", f"email:{body.email.lower()}")

    user = (
        await session.execute(select(User).where(User.email == body.email.lower()))
    ).scalar_one_or_none()

    if user is not None and user.status not in ("deleted", "purged"):
        token = new_opaque_token()
        session.add(
            EmailToken(
                user_id=user.id,
                kind="reset",
                token_hash=hash_token(token),
                expires_at=datetime.now(UTC) + timedelta(hours=RESET_TTL_HOURS),
            )
        )
        await mail.enqueue(
            session,
            to_email=user.email,
            template="reset_password",
            payload={"link": mail.link("/reset", token), "expires_hours": RESET_TTL_HOURS},
        )

    return {"status": "sent"}


class ResetIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=10, max_length=200)


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(body: ResetIn, request: Request, session: Db) -> Response:
    token = (
        await session.execute(
            select(EmailToken).where(
                EmailToken.token_hash == hash_token(body.token), EmailToken.kind == "reset"
            )
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if token is None or token.used_at is not None or token.expires_at <= now:
        raise Unauthorized("링크가 만료됐거나 올바르지 않습니다", code="token_invalid")

    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.user_id == token.user_id, AuthIdentity.provider == "password"
            )
        )
    ).scalar_one_or_none()
    if identity is None:
        raise Unauthorized("비밀번호 로그인을 쓰지 않는 계정입니다", code="no_password_identity")

    identity.secret_hash = hash_password(body.password)
    token.used_at = now

    # **비밀번호를 바꾸면 모든 세션을 끊는다.** 탈취당한 상태에서 되찾는 경우가
    # 재설정의 주된 용도라, 옛 세션이 살아 있으면 되찾은 게 아니다
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == token.user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    await audit.record(
        session, action="user.reset_password", actor_id=token.user_id, ip=client_ip(request)
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- 구글 로그인 -------------------------------------------------------------


@router.get("/google/start")
async def google_start(
    request: Request, next: Annotated[str, Query(max_length=200)] = "/"
) -> dict[str, str]:
    """로그인 URL 을 만들어 준다. 리다이렉트는 클라이언트가 한다 —
    XHR 로 부르면 302 를 다루기 번거롭고, 앱마다 이동 방식이 다르다"""
    await rate_check("oauth_start", client_ip(request) or "unknown")
    # **열린 리다이렉트를 막는다.** `next` 는 우리 앱 안의 경로만 받는다 —
    # "//evil.com" 이나 "https://evil.com" 이 통과하면 피싱 도구가 된다
    if not next.startswith("/") or next.startswith("//"):
        next = "/"
    url, state = await google_oauth.start(next_path=next)
    return {"authorization_url": url, "state": state}


@router.get("/google/callback")
async def google_callback(
    request: Request,
    session: Db,
    settings: Config,
    code: Annotated[str | None, Query(max_length=2000)] = None,
    state: Annotated[str | None, Query(max_length=500)] = None,
    error: Annotated[str | None, Query(max_length=200)] = None,
) -> RedirectResponse:
    """구글이 되돌려 보내는 곳. **여기는 브라우저의 최상위 이동이다.**

    그래서 JSON 을 돌려주면 안 된다 — 사용자 화면에 액세스 토큰이 적힌 날 JSON 이
    뜨고, SPA 는 그걸 받을 방법이 없다. 한때 그렇게 돼 있었다.

    **토큰을 URL 에 싣지도 않는다.** 쿼리스트링이든 프래그먼트든 브라우저 히스토리·
    리퍼러·프록시 로그에 남는다. 대신:

        구글 → 콜백에서 **리프레시 쿠키만 심고** 앱으로 리다이렉트
        → SPA 가 `POST /v1/auth/refresh` 로 액세스 토큰을 받는다

    이미 있는 회전·재사용 감지 장치를 그대로 타므로 새로 만들 것이 없다.
    """
    target = f"{settings.app_base_url.rstrip('/')}"

    if error or not code or not state:
        # 사용자가 취소한 경우도 여기로 온다. 내부 사정을 노출하지 않는다
        return RedirectResponse(f"{target}/login?error=oauth_canceled", status_code=303)

    stored = await google_oauth.consume_state(state)
    id_token = await google_oauth.exchange(code, stored["verifier"])
    profile = google_oauth.verify_id_token(id_token, expected_nonce=stored["nonce"])

    user = await _link_or_create_google_user(
        session, profile, ip=client_ip(request), beta_months=settings.beta_free_months
    )
    user.last_seen_at = datetime.now(UTC)

    next_path = stored.get("next") or "/"
    if not next_path.startswith("/") or next_path.startswith("//"):
        next_path = "/"

    response = RedirectResponse(f"{target}{next_path}?login=google", status_code=303)
    # 쿠키만 심는다. 액세스 토큰은 SPA 가 refresh 로 받아 간다
    await _issue_tokens(
        session, response, settings, user, user_agent=request.headers.get("user-agent")
    )
    return response


async def _link_or_create_google_user(
    session: Db, profile, *, ip: str | None, beta_months: int = 0
) -> User:
    """구글 계정 → 우리 사용자.

    순서가 중요하다:

      1. **`sub` 로 먼저 찾는다.** 구글에서 이메일을 바꿔도 같은 사람이다.
         이메일로 먼저 찾으면 주소를 바꾼 사용자가 새 계정이 돼 곡을 잃는다
      2. 없으면 이메일로 기존 계정을 찾아 **연결**한다 — 단 `email_verified` 일 때만.
         이 조건이 없으면 남의 주소로 구글 계정을 만들어 그 사람 계정을 가져갈 수 있다
      3. 그래도 없으면 새로 만든다 (개인 워크스페이스까지)
    """
    identity = (
        await session.execute(
            select(AuthIdentity).where(
                AuthIdentity.provider == "google", AuthIdentity.subject == profile.subject
            )
        )
    ).scalar_one_or_none()

    if identity is not None:
        user = await session.get(User, identity.user_id)
        if user is None or user.status in ("deleted", "purged"):
            raise Unauthorized("계정을 찾을 수 없습니다", code="account_not_found")
        await audit.record(session, action="user.login", actor_id=user.id, ip=ip)
        return user

    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()

    if existing is not None:
        if not profile.email_verified:
            # **여기서 막는다.** 확인되지 않은 주소로 남의 계정에 붙을 수 없다
            raise Unauthorized(
                "구글에서 이메일이 확인되지 않아 기존 계정과 연결할 수 없습니다",
                code="oauth_email_unverified",
            )
        if existing.status in ("deleted", "purged"):
            raise Unauthorized("계정을 찾을 수 없습니다", code="account_not_found")

        session.add(
            AuthIdentity(user_id=existing.id, provider="google", subject=profile.subject)
        )
        # 구글이 확인해 준 주소이므로 우리 확인도 끝난 것으로 본다
        if existing.email_verified_at is None:
            existing.email_verified_at = datetime.now(UTC)
        if existing.status == "pending_verification":
            existing.status = "active"
        await audit.record(
            session, action="user.link_google", actor_id=existing.id, ip=ip
        )
        return existing

    user = User(
        email=profile.email,
        display_name=profile.name,
        # 구글이 확인한 주소면 우리가 다시 확인 메일을 보낼 이유가 없다
        status="active" if profile.email_verified else "pending_verification",
        email_verified_at=datetime.now(UTC) if profile.email_verified else None,
    )
    session.add(user)
    await session.flush()
    # **비밀번호 없이 만든다.** 나중에 비밀번호를 걸고 싶으면 재설정 흐름을 탄다
    session.add(AuthIdentity(user_id=user.id, provider="google", subject=profile.subject))

    org = await orgs.create_personal_org(session, user)
    await billing.start_free(session, org.id)
    await entitlements.grant_beta_free(session, org.id, beta_months)
    await audit.record(
        session, action="user.signup", actor_id=user.id, detail={"via": "google"}, ip=ip
    )
    return user
