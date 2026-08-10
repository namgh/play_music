"""비밀번호·토큰 — `SERVER_ACCOUNTS.md` 2절.

핵심 판단 셋:
  1. 액세스 토큰만 JWT, 10분. 취소를 못 하니 위험 창을 짧게
  2. 리프레시는 불투명 난수 + **DB 에 해시로**. 취소가 확실해야 한다
  3. 회전 + 재사용 감지. 이미 쓴 토큰이 다시 오면 **전 세션을 끊는다**
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# 로그인 지연이 100ms 를 넘지 않는 선에서 메모리를 올린다.
# 파라미터는 해시 문자열에 담기므로, 나중에 올려도 **로그인 성공 시점에 재해싱**하면 된다
_hasher = PasswordHasher(memory_cost=64 * 1024, time_cost=3, parallelism=4)

# 사용자가 없을 때도 같은 시간을 쓰기 위한 더미. 존재 여부를 응답 시간으로 흘리지 않는다
_DUMMY_HASH = _hasher.hash("resona-timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, stored_hash: str | None) -> tuple[bool, str | None]:
    """(맞는가, 다시 해싱해 저장할 값 또는 None)

    `stored_hash` 가 None 이어도 **더미와 비교해 시간을 맞춘다** — 사용자 존재 여부가
    응답 시간으로 새어 나가지 않게.
    """
    target = stored_hash or _DUMMY_HASH
    try:
        _hasher.verify(target, password)
    except (VerifyMismatchError, InvalidHashError):
        return False, None
    if stored_hash is None:
        return False, None
    if _hasher.check_needs_rehash(stored_hash):
        return True, _hasher.hash(password)
    return True, None


def new_opaque_token(nbytes: int = 32) -> str:
    """리프레시·이메일 토큰. JWT 가 아니다 — 취소가 가능해야 한다"""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """토큰 저장용 해시.

    Argon2 가 아니라 SHA-256 인 이유: 이 값은 **고엔트로피 난수**라 사전 공격이
    성립하지 않는다. 매 요청 검증에 Argon2 를 쓰면 리프레시가 느려진다.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


def create_access_token(
    *, secret: str, subject: str, ttl_sec: int, extra: dict[str, Any] | None = None
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_sec)).timestamp()),
        "typ": "access",
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(token: str, *, secret: str) -> dict[str, Any]:
    """만료·서명 오류는 예외로 올린다. 호출자가 401 로 바꾼다"""
    return jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
