"""구글 로그인.

구글에 실제로 붙지 않는다 — 대신 **우리가 만든 키로 진짜 RS256 id_token 을 서명**해서
JWKS 자리에 그 키를 끼운다. 검증 로직 자체는 실물과 똑같이 돈다.
"검증을 건너뛰고 통과시키는" 가짜를 쓰면 정작 검증이 빠져도 테스트가 통과한다.

여기서 잠그는 위험 넷:
  1. 남의 앱에서 받은 정상 구글 토큰으로 로그인 (→ `aud` 검증)
  2. state 재사용으로 인가 코드 재생 (→ 한 번 쓰고 삭제)
  3. 확인 안 된 이메일로 남의 계정 가로채기 (→ `email_verified` 요구)
  4. `next` 파라미터를 통한 열린 리다이렉트 (→ 우리 앱 경로만)
"""

from __future__ import annotations

import time
import uuid
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app.db.models import AuthIdentity, Organization, OrgMember, User
from app.services import google_oauth
from tests.test_projects import DOC, auth, signup

CLIENT_ID = "test-client-id.apps.googleusercontent.com"
PASSWORD = "correct-horse-battery"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def google_configured(monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/v1/auth/google/callback")
    get_settings.cache_clear()

    class FakeJWKS:
        """서명 키만 돌려준다. **검증 로직은 실물 그대로 돈다**"""

        def get_signing_key_from_jwt(self, token):
            class K:
                key = _KEY.public_key()

            return K()

    monkeypatch.setattr(google_oauth, "_jwks", lambda: FakeJWKS())
    yield
    get_settings.cache_clear()


def make_id_token(
    *,
    nonce: str,
    email: str,
    # **매번 다른 값이어야 한다.** 고정하면 앞선 테스트가 만든 계정에 붙어 버린다
    # (그리고 그게 `sub` 우선 조회가 제대로 도는 증거이기도 하다)
    sub: str | None = None,
    email_verified: bool = True,
    aud: str = CLIENT_ID,
    iss: str = "https://accounts.google.com",
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": iss,
            "aud": aud,
            "sub": sub or f"sub-{uuid.uuid4().hex[:12]}",
            "email": email,
            "email_verified": email_verified,
            "name": "테스트 사용자",
            "nonce": nonce,
            "iat": now,
            "exp": now + 600,
        },
        _KEY,
        algorithm="RS256",
    )


async def start_login(client) -> tuple[str, str]:
    """(state, nonce) — nonce 는 인가 URL 에서 꺼낸다"""
    res = await client.get("/v1/auth/google/start")
    assert res.status_code == 200, res.text
    params = parse_qs(urlparse(res.json()["authorization_url"]).query)
    return res.json()["state"], params["nonce"][0]


@pytest.fixture
def fake_exchange(monkeypatch):
    """인가 코드 → id_token 교환만 대신한다. 구글 네트워크를 안 탄다"""
    box: dict[str, str] = {}

    async def exchange(code, verifier):
        assert verifier, "PKCE verifier 를 실어 보내야 한다"
        return box["id_token"]

    monkeypatch.setattr(google_oauth, "exchange", exchange)
    return box


async def test_start_returns_a_proper_authorization_url(client):
    res = await client.get("/v1/auth/google/start")
    assert res.status_code == 200
    url = res.json()["authorization_url"]
    params = parse_qs(urlparse(url).query)

    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth")
    assert params["response_type"] == ["code"]
    assert params["client_id"] == [CLIENT_ID]
    # **PKCE 를 쓴다** — 인가 코드가 새어도 verifier 없이는 못 바꾼다
    assert params["code_challenge_method"] == ["S256"]
    assert params["code_challenge"][0]
    assert params["nonce"][0]
    # 최소 범위만 요청한다
    assert params["scope"] == ["openid email profile"]


async def test_callback_redirects_to_the_app_without_leaking_tokens(client, fake_exchange):
    """**브라우저의 최상위 이동이다.** JSON 을 돌려주면 사용자 화면에 액세스 토큰이
    적힌 날 JSON 이 뜨고 SPA 는 그걸 받을 방법이 없다 — 한때 그랬다.

    토큰을 URL 에 싣지도 않는다. 쿼리든 프래그먼트든 히스토리·리퍼러·프록시 로그에
    남는다. 쿠키만 심고 SPA 가 refresh 로 받아 간다.
    """
    email = f"g-{uuid.uuid4().hex[:8]}@example.com"
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=email)

    res = await client.get(
        f"/v1/auth/google/callback?code=abc&state={state}", follow_redirects=False
    )
    assert res.status_code == 303
    location = res.headers["location"]
    assert location.startswith("http")
    # **토큰이 URL 어디에도 없어야 한다**
    assert "token" not in location.lower()
    assert client.cookies.get("resona_refresh"), "리프레시 쿠키를 심어야 한다"

    # SPA 는 쿠키로 액세스 토큰을 받아 간다 — 기존 회전 장치를 그대로 탄다
    refreshed = await client.post("/v1/auth/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "active"


async def test_canceled_login_redirects_with_an_error(client):
    res = await client.get(
        "/v1/auth/google/callback?error=access_denied", follow_redirects=False
    )
    assert res.status_code == 303
    assert "error=oauth_canceled" in res.headers["location"]


async def test_new_google_user_gets_personal_workspace(client, db, fake_exchange):
    """구글로 가입해도 **개인 워크스페이스가 똑같이 생긴다** — 경로가 갈리면 안 된다"""
    email = f"g-{uuid.uuid4().hex[:8]}@example.com"
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=email)

    res = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert res.status_code in (200, 303), res.text
    # 구글이 확인해 준 주소라 확인 메일 단계를 건너뛴다
    assert (await client.post("/v1/auth/refresh")).json()["status"] == "active"

    user = (await db.execute(select(User).where(User.email == email))).scalar_one()
    org, role = (
        await db.execute(
            select(Organization, OrgMember.role)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user.id)
        )
    ).one()
    assert org.kind == "personal"
    assert role == "owner"

    # 비밀번호 identity 는 없다
    providers = (
        await db.execute(select(AuthIdentity.provider).where(AuthIdentity.user_id == user.id))
    ).scalars().all()
    assert providers == ["google"]


async def test_token_from_another_app_is_rejected(client, fake_exchange):
    """**가장 위험한 경로.** 공격자가 자기 앱에서 받은 정상 구글 토큰을 내밀면,
    `aud` 를 안 보는 서버는 그대로 로그인시킨다"""
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(
        nonce=nonce, email="victim@example.com", aud="attacker-app.apps.googleusercontent.com"
    )
    res = await client.get(
        f"/v1/auth/google/callback?code=abc&state={state}", follow_redirects=False
    )
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "oauth_token_invalid"


async def test_wrong_issuer_is_rejected(client, fake_exchange):
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(
        nonce=nonce, email="x@example.com", iss="https://evil.example.com"
    )
    res = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert res.status_code == 401


async def test_replayed_nonce_is_rejected(client, fake_exchange):
    """다른 로그인에서 받은 id_token 을 이 로그인에 끼워 넣지 못한다"""
    state, _ = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce="다른-로그인의-nonce", email="x@example.com")
    res = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "oauth_bad_nonce"


async def test_state_is_single_use(client, fake_exchange):
    """**state 를 남겨 두면 인가 코드를 재생할 수 있다**"""
    email = f"g-{uuid.uuid4().hex[:8]}@example.com"
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=email)

    first = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert first.status_code in (200, 303)

    second = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert second.status_code == 401
    assert second.json()["error"]["code"] == "oauth_state_invalid"


async def test_unknown_state_is_rejected(client, fake_exchange):
    fake_exchange["id_token"] = make_id_token(nonce="n", email="x@example.com")
    res = await client.get("/v1/auth/google/callback?code=abc&state=made-up-state")
    assert res.status_code == 401


async def test_links_to_existing_password_account(client, db, unique_email, fake_exchange):
    """같은 주소로 이미 가입했으면 **계정을 하나로 합친다** —
    안 그러면 곡이 두 계정에 갈린다"""
    await signup(client, unique_email)
    project_owner_token = (
        await client.post(
            "/v1/auth/login", json={"email": unique_email, "password": PASSWORD}
        )
    ).json()["access_token"]
    project = (
        await client.post(
            "/v1/projects",
            json={"name": "비밀번호로 만든 곡", "document": DOC},
            headers=auth(project_owner_token),
        )
    ).json()

    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(
        nonce=nonce, email=unique_email, sub=f"sub-{uuid.uuid4().hex[:8]}"
    )
    res = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert res.status_code in (200, 303)

    google_token = (await client.post("/v1/auth/refresh")).json()["access_token"]
    # **같은 계정이다** — 구글로 들어와도 이전 곡이 그대로 보인다
    seen = await client.get(f"/v1/projects/{project['id']}", headers=auth(google_token))
    assert seen.status_code == 200

    user = (await db.execute(select(User).where(User.email == unique_email))).scalar_one()
    providers = sorted(
        (
            await db.execute(
                select(AuthIdentity.provider).where(AuthIdentity.user_id == user.id)
            )
        ).scalars()
    )
    assert providers == ["google", "password"]


async def test_unverified_google_email_cannot_take_over_an_account(
    client, db, unique_email, fake_exchange
):
    """**계정 탈취 경로.** 확인되지 않은 주소로 남의 계정에 붙을 수 없다"""
    await signup(client, unique_email)

    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(
        nonce=nonce, email=unique_email, email_verified=False, sub="attacker-sub"
    )
    res = await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "oauth_email_unverified"

    linked = (
        await db.execute(select(AuthIdentity).where(AuthIdentity.subject == "attacker-sub"))
    ).scalar_one_or_none()
    assert linked is None


async def test_email_change_at_google_keeps_the_same_account(client, db, fake_exchange):
    """구글에서 주소를 바꿔도 같은 사람이다. **`sub` 로 먼저 찾는 이유** —
    이메일로 찾으면 주소를 바꾼 사용자가 새 계정이 되고 곡을 잃는다"""
    sub = f"stable-{uuid.uuid4().hex[:8]}"
    old_email = f"old-{uuid.uuid4().hex[:8]}@example.com"
    new_email = f"new-{uuid.uuid4().hex[:8]}@example.com"

    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=old_email, sub=sub)
    await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    first_user_id = (await client.post("/v1/auth/refresh")).json()["user_id"]

    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=new_email, sub=sub)
    await client.get(f"/v1/auth/google/callback?code=abc&state={state}")
    assert (await client.post("/v1/auth/refresh")).json()["user_id"] == first_user_id


async def test_google_login_issues_a_refresh_cookie(client, fake_exchange):
    email = f"g-{uuid.uuid4().hex[:8]}@example.com"
    state, nonce = await start_login(client)
    fake_exchange["id_token"] = make_id_token(nonce=nonce, email=email)
    await client.get(f"/v1/auth/google/callback?code=abc&state={state}")

    assert client.cookies.get("resona_refresh")
    # 비밀번호 로그인과 **같은 세션 구조**를 쓴다 — 회전·재사용 감지가 그대로 붙는다
    assert (await client.post("/v1/auth/refresh")).status_code == 200


@pytest.mark.parametrize(
    "target", ["//evil.example.com", "https://evil.example.com/steal", "http://x"]
)
async def test_next_parameter_cannot_redirect_offsite(client, target):
    """**열린 리다이렉트는 피싱 도구가 된다.** 우리 앱 안의 경로만 받는다"""
    res = await client.get("/v1/auth/google/start", params={"next": target})
    assert res.status_code == 200
    # 서버가 조용히 "/" 로 바꿔 놓는다
    import json

    from app.core import redis as r

    stored = json.loads(await r.core().get(r.key("oauth", "state", res.json()["state"])))
    assert stored["next"] == "/"


async def test_start_is_rejected_when_not_configured(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    get_settings.cache_clear()
    res = await client.get("/v1/auth/google/start")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "google_not_configured"
