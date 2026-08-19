"""설정 — **부팅을 막는 것이 일이다.**

여기서 잠그는 사고 둘:

  1. **운영에 기본 시크릿으로 뜬다.** 공개 저장소에 적힌 JWT 시크릿이면 누구나
     임의 `user_id` 로 토큰을 위조한다. "떠는 있는데 안전하지 않은" 상태보다
     아예 안 뜨는 편이 낫다.
  2. **`.env.example` 과 `Settings` 가 갈라진다.** 실제로 갈라져 있었다 —
     `extra="forbid"` 라 문서대로 `cp .env.example .env` 하면 부팅이 실패했고,
     반대로 SMTP·구글·결제 시크릿은 `os.environ` 직접 읽기라 `.env` 에 넣어도
     코드가 영영 못 봤다. 웹훅 시크릿이 그 경로였다 — 채워도 서명 검증을
     건너뛰었다.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from resona.config import Settings

ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"

BASE = {
    "database_url": "postgresql+asyncpg://u:p@h:5432/d",
    "redis_cache_url": "redis://h:6379/0",
    "redis_core_url": "redis://h:6379/1",
    "jwt_secret": "x" * 40,
}

#: base64 32바이트. 문자열을 손으로 세지 않는다 — 길이가 틀리면 테스트가
#: 엉뚱한 이유로 실패한다
_ENC = base64.b64encode(b"e" * 32).decode()

PRODUCTION = {
    **BASE,
    "env": "production",
    # **환경변수를 기대지 않고 스스로 완결돼야 한다.** conftest 가 테스트용 결제
    # 키를 넣어 두는데, 그게 새어 들어오면 "운영에 테스트 키" 게이트에 걸려
    # 엉뚱한 곳에서 실패한다
    "toss_secret_key": "live_sk_value",
    "payment_enc_key": _ENC,
    "key_prefix": "production:v1",
    "billing_webhook_secret": "whsec_live_value",
    "stripe_secret_key": "sk_live_value",
    "storage_access_key": "AKIAEXAMPLE",
    "storage_secret_key": "secret-value",
    "cors_origins": ["https://app.example.com"],
    "app_base_url": "https://app.example.com",
}


def test_env_example_has_no_unknown_keys():
    """**예시 파일의 모든 키가 `Settings` 필드여야 한다.**

    `extra="forbid"` 라 하나라도 남으면 `cp .env.example .env` 가 부팅을 깨뜨린다.
    """
    fields = set(Settings.model_fields)
    unknown = []
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].strip().lower()
        if key not in fields:
            unknown.append(key)
    assert unknown == [], f".env.example 에 Settings 가 모르는 키가 있다: {unknown}"


def test_every_secret_is_a_settings_field():
    """시크릿을 `os.environ` 으로 직접 읽으면 **`.env` 에 넣어도 코드가 못 본다**"""
    for name in (
        "smtp_user",
        "smtp_password",
        "google_client_id",
        "google_client_secret",
        "billing_webhook_secret",
        "storage_access_key",
        "storage_secret_key",
        "app_base_url",
    ):
        assert name in Settings.model_fields, f"{name} 이 Settings 에 없다"


def test_source_code_does_not_read_secrets_from_environ():
    """드리프트가 다시 생기지 않게 **코드를 직접 훑는다**"""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    offenders = []
    for path in app_dir.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"os\.environ(?:\.get)?\s*[\(\[]\s*[\"']([A-Z_]+)", text):
            key = match.group(1)
            if key.lower() in Settings.model_fields:
                offenders.append(f"{path.name}: {key}")
    assert offenders == [], f"Settings 필드를 os.environ 으로 읽는 곳이 있다: {offenders}"


def test_local_boots_with_defaults():
    settings = Settings(**BASE)
    assert settings.is_production is False


def test_production_boots_when_fully_configured():
    assert Settings(**PRODUCTION).is_production is True


@pytest.mark.parametrize(
    ("override", "expected"),
    [
        ({"jwt_secret": "change-me-in-production"}, "기본값"),
        ({"jwt_secret": "short"}, "32자"),
        ({"key_prefix": "local:v1"}, "KEY_PREFIX"),
        ({"billing_webhook_secret": ""}, "BILLING_WEBHOOK_SECRET"),
        ({"stripe_secret_key": "", "toss_secret_key": ""}, "STRIPE_SECRET_KEY"),
        ({"storage_access_key": ""}, "STORAGE_ACCESS_KEY"),
        ({"storage_secret_key": ""}, "STORAGE_SECRET_KEY"),
        ({"cors_origins": ["http://localhost:5173"]}, "localhost"),
        ({"app_base_url": "http://app.example.com"}, "https"),
    ],
)
def test_production_refuses_to_boot_when_misconfigured(override, expected):
    """**하나라도 비면 안 뜬다.** 각각이 실제 사고 경로다"""
    with pytest.raises(ValidationError) as exc:
        Settings(**{**PRODUCTION, **override})
    assert expected in str(exc.value)


def test_local_is_not_gated():
    """로컬 개발이 시크릿 없이 돌아가야 한다 — 안 그러면 아무도 안 쓴다"""
    assert Settings(**BASE, env="local").billing_webhook_secret.get_secret_value() == ""


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://a.com,https://b.com", ["https://a.com", "https://b.com"]),
        ('["https://a.com"]', ["https://a.com"]),
        ("https://a.com", ["https://a.com"]),
        ("", []),
    ],
)
def test_cors_origins_accepts_plain_comma_separated(raw, expected, monkeypatch):
    """`CORS_ORIGINS=https://app.example.com` 이 **부팅을 깨뜨리지 않아야 한다**.

    **환경변수로 넣어서 확인한다.** 값을 생성자에 직접 넘기면 pydantic-settings 의
    소스 계층을 건너뛰어서, 정작 깨지는 경로를 안 지난다 — 실제로 이 테스트가
    통과하는데 `cp .env.example .env` 는 `JSONDecodeError` 로 죽고 있었다.
    검증자보다 **먼저** 도는 JSON 디코딩이 원인이었고, `NoDecode` 로 껐다.
    """
    monkeypatch.setenv("CORS_ORIGINS", raw)
    assert Settings(**BASE).cors_origins == expected


def test_env_example_file_actually_boots(tmp_path, monkeypatch):
    """**예시 파일을 그대로 복사해서 진짜로 떠 보는 테스트.**

    키 이름만 대조하는 것으로는 부족했다 — 이름이 다 맞아도 값 형식 때문에
    부팅이 깨질 수 있고, 실제로 그랬다.
    """
    import shutil

    from pydantic_settings import SettingsConfigDict

    shutil.copy(ENV_EXAMPLE, tmp_path / ".env")
    for key in list(Settings.model_fields):
        monkeypatch.delenv(key.upper(), raising=False)

    class Local(Settings):
        model_config = SettingsConfigDict(
            env_file=str(tmp_path / ".env"), env_file_encoding="utf-8", extra="forbid"
        )

    settings = Local()
    assert settings.env == "local"
    assert settings.cors_origins == ["http://localhost:5173"]


def test_key_prefix_must_have_a_version():
    with pytest.raises(ValidationError):
        Settings(**BASE, key_prefix="noversion")


# --- 결제 키 ----------------------------------------------------------------

@pytest.mark.parametrize(
    ("override", "expected"),
    [
        # **테스트 키로 운영을 띄우면 결제가 조용히 가짜가 된다.** 화면은 전부
        # 성공으로 보이는데 돈은 한 푼도 안 들어오고, 한참 뒤에야 알게 된다
        (
            {"stripe_secret_key": "", "toss_secret_key": "test_sk_abc", "payment_enc_key": _ENC},
            "테스트 키",
        ),
        # 빌링키를 평문으로 저장하게 두면 DB 유출이 곧 카드 도용이 된다
        ({"toss_secret_key": "live_sk_abc", "payment_enc_key": ""}, "PAYMENT_ENC_KEY"),
    ],
)
def test_production_refuses_bad_payment_keys(override, expected):
    with pytest.raises(ValidationError) as exc:
        Settings(**{**PRODUCTION, **override})
    assert expected in str(exc.value)


def test_production_boots_with_only_toss():
    """국내만 여는 단계라 **Stripe 없이도 떠야 한다** (`SERVER_PAYMENTS.md` 0절)"""
    s = Settings(
        **{
            **PRODUCTION,
            "stripe_secret_key": "",
            "toss_secret_key": "live_sk_abc",
            "payment_enc_key": _ENC,
        }
    )
    assert s.toss_secret_key.get_secret_value() == "live_sk_abc"


def test_live_payment_keys_are_refused_outside_production():
    """**반대 방향의 게이트.** 테스트를 돌리다 진짜 카드에 청구하는 사고는
    되돌리기가 비싸고 무엇보다 남의 돈이다. 운영 `.env` 를 로컬로 복사해 오는
    일은 실제로 흔하다"""
    with pytest.raises(ValidationError) as exc:
        Settings(**BASE, env="local", toss_secret_key="live_sk_abc")
    assert "운영 키" in str(exc.value)


def test_test_keys_are_fine_outside_production():
    s = Settings(**BASE, env="local", toss_secret_key="test_sk_abc")
    assert s.toss_secret_key.get_secret_value() == "test_sk_abc"
