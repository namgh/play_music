"""설정 — 전부 환경변수에서 온다 (`SERVER_OPS.md` 1절).

**시작 시 검증하고 실패시킨다.** 없는 값으로 떠서 첫 요청에 죽는 것보다 아예 안 뜨는
편이 낫다 — 배포 파이프라인이 그걸 잡아 준다.

코드 안에 `if env == "prod"` 분기를 만들지 않는다. 스테이징에서 검증한 경로와 운영
경로가 달라지는 순간 검증이 의미를 잃는다. 환경 차이는 **값**으로만 표현한다.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["local", "staging", "production"]

# 예시 파일·문서에 적힌 값들. **운영에서 이게 들어오면 부팅을 막는다**
_KNOWN_DEFAULT_SECRETS = {
    "change-me-in-production",
    "local-dev-secret-not-for-production-use",
    "test-secret",
    "secret",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="forbid",  # 오타 난 환경변수를 조용히 무시하지 않는다
    )

    env: Environment = "local"
    # 키 이름에 들어간다 (`SERVER_REDIS.md` 3절). 스테이징과 운영이 같은 Redis 를
    # 보는 사고가 실제로 흔해서 접두어로 막는다
    key_prefix: str = "local:v1"

    database_url: PostgresDsn
    # **캐시와 코어를 나눈다.** 축출 정책이 달라서다 (`SERVER_REDIS.md` 2절) —
    # LRU 가 락 키를 지우면 두 워커가 같은 임계 구역에 들어간다
    redis_cache_url: RedisDsn
    redis_core_url: RedisDsn

    # workers × (pool_size + max_overflow) ≤ max_connections (`SERVER.md` 1절).
    # I/O 바운드라 큰 풀이 필요 없다
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_pool_timeout_sec: float = 5.0
    # PgBouncer transaction 모드 뒤에 두면 준비된 문장을 못 쓴다
    db_statement_cache_size: int = 100

    jwt_secret: SecretStr
    access_token_ttl_sec: int = 600  # 10분. 취소를 못 하므로 짧게
    refresh_token_ttl_sec: int = 60 * 60 * 24 * 30

    storage_bucket: str = "resona-local"
    storage_endpoint: str | None = None  # S3 호환. None 이면 AWS
    storage_region: str = "auto"
    storage_access_key: SecretStr = SecretStr("")
    storage_secret_key: SecretStr = SecretStr("")

    # --- 메일 (Gmail SMTP) ---
    # Gmail 은 **앱 비밀번호**를 쓴다. 계정 비밀번호로는 로그인되지 않는다
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_timeout_sec: float = 15.0
    mail_from_name: str = "RESONA"
    # 메일 안의 링크가 가리킬 주소
    app_base_url: str = "http://localhost:5173"

    # --- 구글 로그인 ---
    google_client_id: str = ""
    google_client_secret: SecretStr = SecretStr("")
    google_redirect_uri: str = "http://localhost:8000/v1/auth/google/callback"

    # --- 결제 ---
    billing_webhook_secret: SecretStr = SecretStr("")
    stripe_secret_key: SecretStr = SecretStr("")

    # **첫 플랫폼 운영자.** 이 주소로 가입하면 `owner` 로 승격된다.
    #
    # 없으면 어드민 API 전체가 아무도 못 쓰는 상태로 뜬다 — 권한 부여
    # 엔드포인트가 owner 를 요구하는데 owner 는 가입으로도 마이그레이션으로도
    # 생기지 않기 때문이다. 첫 남용 신고가 들어오면 운영자가 프로덕션 DB 에
    # 직접 UPDATE 를 쳐야 하고, 그 조작은 감사 로그에도 안 남는다.
    #
    # 이미 존재하는 계정은 승격하지 않는다 — 환경변수를 바꾸는 것만으로 남의
    # 계정이 운영자가 되면 그게 곧 권한 상승 경로다
    bootstrap_owner_email: str = ""

    # Redis 가 느려지면 API 전체가 같이 느려진다 — 그건 캐시가 할 일이 아니다
    redis_timeout_sec: float = 0.2

    # **`NoDecode` 가 핵심이다.** 이게 없으면 pydantic-settings 가 환경변수·.env 값을
    # **검증자보다 먼저** JSON 으로 파싱하려 들어서, `CORS_ORIGINS=https://app.example.com`
    # 이 `JSONDecodeError` 로 부팅을 깨뜨린다. 아래 `_split_csv` 는 그 뒤에 돌기 때문에
    # 손을 쓸 기회조차 없다 — 실제로 그렇게 깨졌다.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )
    # **프록시 뒤에 있을 때만 X-Forwarded-For 를 믿는다** (`app/api/deps.py`).
    # 비워 두면 헤더를 아예 안 본다 — 위조로 레이트리밋을 우회하지 못하게
    trusted_proxy_cidrs: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # 본문 크기 상한. **읽기 전에** 거절한다 — 파싱한 뒤 거절하면 이미 메모리를 썼다
    max_body_bytes: int = 2 * 1024 * 1024

    @field_validator("key_prefix")
    @classmethod
    def _prefix_has_env(cls, v: str) -> str:
        if ":" not in v:
            raise ValueError("key_prefix 는 '{env}:{version}' 형태여야 한다 (예: prod:v1)")
        return v

    @field_validator("cors_origins", "trusted_proxy_cidrs", mode="before")
    @classmethod
    def _split_csv(cls, v: Any) -> Any:
        """`a,b` 형태도 받는다.

        pydantic 은 `list[str]` 을 JSON 으로만 파싱해서, 운영자가 직관적으로
        `CORS_ORIGINS=https://app.example.com` 을 넣으면 **부팅이 실패한다.**
        그 실패가 배포 현장에서 나면 원인을 찾는 데 한참 걸린다.
        """
        if isinstance(v, str):
            text = v.strip()
            if not text:
                return []
            if text.startswith("["):
                # JSON 도 받는다. 여기서 직접 파싱해야 환경변수 경로와 직접 대입
                # 경로가 **같게** 동작한다 — 테스트와 운영이 갈리지 않게
                import json

                return json.loads(text)
            return [part.strip() for part in text.split(",") if part.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @model_validator(mode="after")
    def _production_must_be_configured(self) -> Settings:
        """**운영에서 기본값으로 뜨지 못하게 한다.**

        환경에 따라 코드가 분기하면 안 된다는 원칙과 충돌하지 않는다 — 이건 동작
        분기가 아니라 **필수값 판정**이다. 값 자체는 여전히 환경변수로만 온다.

        이게 없으면 나는 사고가 구체적이다:
          - 공개 저장소에 적힌 JWT 시크릿이면 누구나 임의 user_id 로 토큰을 위조한다
          - 웹훅 시크릿이 비면 서명 검증을 건너뛰어 아무나 자기 조직을 Pro 로 올린다
          - 스토리지 키가 없으면 더미 키로 서명해 모든 업로드가 조용히 실패한다
        전부 "떠는 있는데 안전하지 않은" 상태라, 부팅 실패로 만드는 편이 낫다.
        """
        if not self.is_production:
            return self

        problems: list[str] = []
        secret = self.jwt_secret.get_secret_value()
        if len(secret) < 32:
            problems.append("JWT_SECRET 은 32자 이상이어야 한다")
        if secret in _KNOWN_DEFAULT_SECRETS:
            problems.append("JWT_SECRET 이 예시 파일의 기본값 그대로다")
        if not self.key_prefix.startswith("production:"):
            problems.append("KEY_PREFIX 는 'production:' 으로 시작해야 한다")
        if not self.billing_webhook_secret.get_secret_value():
            problems.append("BILLING_WEBHOOK_SECRET 이 없으면 웹훅 서명을 검증할 수 없다")
        if not self.stripe_secret_key.get_secret_value():
            problems.append("STRIPE_SECRET_KEY 가 없으면 유료 전환이 불가능하다")
        if not self.storage_access_key.get_secret_value():
            problems.append("STORAGE_ACCESS_KEY 가 없다")
        if not self.storage_secret_key.get_secret_value():
            problems.append("STORAGE_SECRET_KEY 가 없다")
        if any("localhost" in o or "127.0.0.1" in o for o in self.cors_origins):
            problems.append("CORS_ORIGINS 에 localhost 가 남아 있다")
        if self.app_base_url.startswith("http://"):
            problems.append("APP_BASE_URL 이 https 가 아니다 — 메일 링크가 평문으로 나간다")

        if problems:
            raise ValueError(
                "운영 환경 설정이 완전하지 않다:\n  - " + "\n  - ".join(problems)
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
