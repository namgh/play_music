"""구글 로그인 — Authorization Code + PKCE.

**암묵적(implicit) 플로우나 "클라이언트가 준 id_token 을 그냥 믿는" 방식을 쓰지
않는다.** 후자가 특히 위험한데, 공격자가 *자기* 앱에서 받은 정상 구글 토큰을 우리
서버에 내밀면 그대로 로그인이 된다. 그래서 `aud` 가 우리 클라이언트 ID 인지 반드시
확인한다.

지키는 것 넷:

  1. **state** — CSRF. 우리가 시작시킨 로그인인지 확인한다. Redis 에 담고 **한 번
     쓰면 지운다**
  2. **PKCE** — 인가 코드가 중간에서 새어도 `code_verifier` 없이는 못 바꾼다.
     기밀 클라이언트라 필수는 아니지만 비용이 0 이다
  3. **nonce** — id_token 재생 공격 방지. 우리가 만든 값이 그 토큰 안에 있어야 한다
  4. **서명·발급자·수신자 검증** — 구글 JWKS 로 RS256 서명을 확인하고, `iss` 와
     `aud` 를 본다

계정 연결은 **`email_verified` 가 참일 때만** 한다. 안 그러면 남의 주소로 구글
계정을 만들어 그 사람의 기존 계정을 가져갈 수 있다.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from jwt import PyJWKClient

from app.core import redis as r
from app.core.errors import Unauthorized

log = logging.getLogger(__name__)

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"  # noqa: S105 — URL 이지 비밀이 아니다
JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")

# 로그인을 시작하고 끝내기까지. 길게 두면 남의 브라우저에서 이어받을 창이 커진다
STATE_TTL_SEC = 600
HTTP_TIMEOUT_SEC = 10.0

# 최소한만 요청한다. **연락처·드라이브 같은 것을 달라고 하면 사용자가 멈춘다**
SCOPES = "openid email profile"

_jwk_client: PyJWKClient | None = None


@dataclass(frozen=True)
class GoogleProfile:
    subject: str  # 구글의 `sub`. **이메일이 아니라 이것이 계정의 열쇠다**
    email: str
    email_verified: bool
    name: str


def credentials() -> tuple[str, str, str]:
    return (
        os.environ.get("GOOGLE_CLIENT_ID", ""),
        os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        os.environ.get("GOOGLE_REDIRECT_URI", "http://localhost:8000/v1/auth/google/callback"),
    )


def is_configured() -> bool:
    client_id, secret, _ = credentials()
    return bool(client_id and secret)


def _jwks() -> PyJWKClient:
    """JWKS 는 **프로세스 안에서 캐시된다** (PyJWKClient 가 한다).

    매 로그인마다 구글에 키를 물으면 구글이 느려질 때 우리 로그인도 같이 멈춘다.
    """
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(JWKS_URI, cache_keys=True, lifespan=3600)
    return _jwk_client


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


async def start(*, next_path: str = "/") -> tuple[str, str]:
    """(로그인 URL, state). state 는 클라이언트가 다시 들고 오지 않아도 된다 —
    구글이 콜백에 실어 준다"""
    client_id, _, redirect_uri = credentials()
    if not client_id:
        raise Unauthorized("구글 로그인이 설정되지 않았습니다", code="google_not_configured")

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())

    # **한 번 쓰고 버린다.** Redis 가 죽으면 로그인이 안 되는데, 그게 맞다 —
    # state 검증을 건너뛰고 로그인시키는 것보다 안 되는 편이 낫다
    await r.core().set(
        r.key("oauth", "state", state),
        json.dumps({"nonce": nonce, "verifier": verifier, "next": next_path}),
        ex=STATE_TTL_SEC,
    )

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # 사용자가 계정을 고를 수 있게. 안 주면 자동으로 이전 계정에 붙는다
        "prompt": "select_account",
    }
    return f"{AUTH_ENDPOINT}?{urlencode(params)}", state


async def consume_state(state: str) -> dict[str, Any]:
    """**한 번만 쓴다.** 남겨 두면 인가 코드를 재생할 수 있다"""
    key = r.key("oauth", "state", state)
    raw = await r.core().get(key)
    if raw is None:
        raise Unauthorized("로그인 요청이 만료됐거나 올바르지 않습니다", code="oauth_state_invalid")
    await r.core().delete(key)
    return json.loads(raw)


async def exchange(code: str, verifier: str) -> str:
    """인가 코드 → id_token. **액세스 토큰은 안 쓴다** — 우리는 신원만 필요하고,
    보관하지 않는 토큰은 새지도 않는다"""
    client_id, secret, redirect_uri = credentials()
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SEC) as client:
        res = await client.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
        )
    if res.status_code != 200:
        # **구글의 오류 본문을 그대로 내보내지 않는다.** 로그에만 남긴다
        log.warning("google_token_exchange_failed", extra={"status": res.status_code})
        raise Unauthorized("구글 로그인에 실패했습니다", code="oauth_exchange_failed")

    id_token = res.json().get("id_token")
    if not id_token:
        raise Unauthorized("구글 응답에 id_token 이 없습니다", code="oauth_no_id_token")
    return id_token


def verify_id_token(id_token: str, *, expected_nonce: str) -> GoogleProfile:
    """서명·발급자·수신자·nonce 를 전부 본다.

    **`aud` 검증이 핵심이다.** 없으면 공격자가 자기 앱에서 받은 정상 구글 토큰으로
    우리 서비스에 로그인할 수 있다.
    """
    client_id, _, _ = credentials()
    try:
        key = _jwks().get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(
            id_token,
            key,
            algorithms=["RS256"],
            audience=client_id,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except jwt.PyJWTError as exc:
        log.warning("google_id_token_invalid", exc_info=exc)
        raise Unauthorized("구글 토큰이 올바르지 않습니다", code="oauth_token_invalid") from None

    if claims.get("iss") not in ISSUERS:
        raise Unauthorized("발급자가 올바르지 않습니다", code="oauth_bad_issuer")
    # nonce 는 재생 공격을 막는다 — 우리가 만든 값이 토큰 안에 있어야 한다
    if claims.get("nonce") != expected_nonce:
        raise Unauthorized("nonce 가 일치하지 않습니다", code="oauth_bad_nonce")

    email = (claims.get("email") or "").lower()
    if not email:
        raise Unauthorized("구글 계정에 이메일이 없습니다", code="oauth_no_email")

    return GoogleProfile(
        subject=str(claims["sub"]),
        email=email,
        email_verified=bool(claims.get("email_verified")),
        name=claims.get("name") or email.split("@")[0],
    )
