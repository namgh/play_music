"""인증 — 가입·로그인·회전·로그아웃 (`SERVER_ACCOUNTS.md` 2절)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update

from app.api.deps import ActiveUser, Config, Db, client_ip
from app.core import audit
from app.core.errors import Unauthorized
from app.core.ratelimit import check as rate_check
from app.core.security import (
    create_access_token,
    hash_password,
    hash_token,
    new_opaque_token,
    verify_password,
)
from app.db.models import AuthIdentity, EmailToken, RefreshToken, Subscription, User
from app.services import mail, orgs

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
        # **가입 여부를 알려주지 않는다.** 계정 열거를 막는다 — 대신 확인 메일을
        # 보내고 같은 응답을 준다 (메일 발송은 워커가 한다)
        await _send_verify_mail(session, existing)
        return await _issue_tokens(
            session, response, settings, existing, user_agent=request.headers.get("user-agent")
        )

    user = User(email=email, display_name=body.display_name, status="pending_verification")
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
    session.add(Subscription(org_id=org.id, plan_code="free", status="active"))
    await _send_verify_mail(session, user)
    await audit.record(session, action="user.signup", actor_id=user.id, ip=ip)

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
        await audit.record(session, action="user.login_failed", detail={"email": email}, ip=ip)
        raise Unauthorized("이메일 또는 비밀번호가 올바르지 않습니다", code="invalid_credentials")

    if rehashed:
        identity.secret_hash = rehashed  # 비용을 올렸으면 로그인 성공 시점에 재해싱

    user = await session.get(User, identity.user_id)
    if user is None or user.status in ("deleted", "purged"):
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
        # **여기서 커밋해야 한다.** 아래 예외가 트랜잭션을 롤백하면 방금 건 폐기가
        # 통째로 취소된다 — 보안 통제가 조용히 아무 일도 안 하게 된다.
        # 테스트가 이걸 잡았다 (`tests/test_auth.py::test_refresh_reuse_kills_all_sessions`)
        await session.commit()
        raise Unauthorized("보안을 위해 모든 세션을 종료했습니다", code="refresh_token_reused")

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
