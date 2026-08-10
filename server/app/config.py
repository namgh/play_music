"""설정 — 전부 환경변수에서 온다 (`SERVER_OPS.md` 1절).

**시작 시 검증하고 실패시킨다.** 없는 값으로 떠서 첫 요청에 죽는 것보다 아예 안 뜨는
편이 낫다 — 배포 파이프라인이 그걸 잡아 준다.

코드 안에 `if env == "prod"` 분기를 만들지 않는다. 스테이징에서 검증한 경로와 운영
경로가 달라지는 순간 검증이 의미를 잃는다. 환경 차이는 **값**으로만 표현한다.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "staging", "production"]


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

    # Redis 가 느려지면 API 전체가 같이 느려진다 — 그건 캐시가 할 일이 아니다
    redis_timeout_sec: float = 0.2

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @field_validator("key_prefix")
    @classmethod
    def _prefix_has_env(cls, v: str) -> str:
        if ":" not in v:
            raise ValueError("key_prefix 는 '{env}:{version}' 형태여야 한다 (예: prod:v1)")
        return v

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
