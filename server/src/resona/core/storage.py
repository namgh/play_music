"""오브젝트 스토리지 — **서명된 URL만 발급한다** (`SERVER.md` 4절).

파일 바이트는 API 프로세스를 통과하지 않는다. 통과시키면:
  - 워커 하나가 업로드 하나에 수십 초씩 묶인다 (그 동안 다른 요청을 못 받는다)
  - 메모리가 파일 크기에 비례해 튄다 → OOM 이 요청 폭주가 아니라 **큰 파일 하나**로 난다
  - 스토리지가 이미 하는 재개·멀티파트·체크섬을 다시 만들게 된다

그래서 API 는 "여기에 올려라"만 말하고 브라우저가 스토리지와 직접 말한다.

SigV4 서명은 **순수 계산**이라 여기서 네트워크를 타지 않는다. SDK 를 안 쓰는 이유가
그거다 — 의존성 하나 없이 테스트로 재현할 수 있다.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from resona.core.config import Settings

_UNSIGNED = "UNSIGNED-PAYLOAD"
_ALGO = "AWS4-HMAC-SHA256"

# 업로드 상한. 이 값을 넘기면 스토리지가 서명을 거부하도록 조건에 박는다 —
# 서버가 "나중에 검사"하면 이미 대역폭은 다 쓴 뒤다
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "export": {"audio/wav", "audio/mpeg", "audio/flac"},
    "sample": {"audio/wav", "audio/flac"},
    "ir": {"audio/wav"},
}


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    k = _sign(f"AWS4{secret}".encode(), date_stamp)
    k = _sign(k, region)
    k = _sign(k, service)
    return _sign(k, "aws4_request")


def storage_key(*, owner_id: uuid.UUID, kind: str, asset_id: uuid.UUID, ext: str) -> str:
    """키에 **소유자를 넣는다.** 버킷 정책으로 접두어 단위 격리를 걸 수 있고,
    사고가 났을 때 "누구 것인지"를 경로만 보고 안다"""
    return f"{kind}/{owner_id}/{asset_id}.{ext.lstrip('.')}"


def presign(
    settings: Settings,
    *,
    method: str,
    key: str,
    expires_sec: int,
    access_key: str,
    secret_key: str,
    extra_query: dict[str, str] | None = None,
    now: datetime | None = None,
) -> str:
    """SigV4 쿼리 서명. `now` 를 받는 것은 **테스트에서 고정하기 위해서다**"""
    t = now or datetime.now(UTC)
    amz_date = t.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = t.strftime("%Y%m%d")
    region = settings.storage_region
    service = "s3"

    if settings.storage_endpoint:
        host = settings.storage_endpoint.split("://", 1)[-1].rstrip("/")
        # path-style — MinIO·R2 같은 호환 스토리지가 이쪽을 쓴다
        canonical_uri = f"/{settings.storage_bucket}/{quote(key, safe='/')}"
        scheme = settings.storage_endpoint.split("://", 1)[0]
    else:
        host = f"{settings.storage_bucket}.s3.{region}.amazonaws.com"
        canonical_uri = f"/{quote(key, safe='/')}"
        scheme = "https"

    credential = f"{access_key}/{date_stamp}/{region}/{service}/aws4_request"
    query = {
        "X-Amz-Algorithm": _ALGO,
        "X-Amz-Credential": credential,
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires_sec),
        "X-Amz-SignedHeaders": "host",
        **(extra_query or {}),
    }
    canonical_query = "&".join(
        f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in sorted(query.items())
    )
    canonical_request = "\n".join(
        [
            method,
            canonical_uri,
            canonical_query,
            f"host:{host}\n",
            "host",
            _UNSIGNED,
        ]
    )
    string_to_sign = "\n".join(
        [
            _ALGO,
            amz_date,
            f"{date_stamp}/{region}/{service}/aws4_request",
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret_key, date_stamp, region, service),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{scheme}://{host}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


def download_url(settings: Settings, key: str, *, filename: str, ttl_sec: int = 300) -> str:
    """**짧게 준다.** 내려받기 링크가 유출돼도 창이 5분이면 피해가 작다.
    `response-content-disposition` 으로 파일명을 스토리지가 붙이게 한다"""
    creds = _creds(settings)
    return presign(
        settings,
        method="GET",
        key=key,
        expires_sec=ttl_sec,
        access_key=creds[0],
        secret_key=creds[1],
        extra_query={
            "response-content-disposition": f'attachment; filename="{filename}"',
        },
    )


def upload_url(settings: Settings, key: str, *, ttl_sec: int = 900) -> str:
    creds = _creds(settings)
    return presign(
        settings,
        method="PUT",
        key=key,
        expires_sec=ttl_sec,
        access_key=creds[0],
        secret_key=creds[1],
    )


def _creds(settings: Settings) -> tuple[str, str]:
    """운영에서 키가 비어 있으면 **부팅 자체가 막힌다** (`config.Settings` 검증).
    그래서 여기 폴백은 로컬 개발 전용이고, 조용한 사고가 되지 않는다."""
    ak = settings.storage_access_key.get_secret_value()
    sk = settings.storage_secret_key.get_secret_value()
    if not ak or not sk:
        return ("local-dev-key", "local-dev-secret")
    return (ak, sk)


def expires_at(ttl_sec: int) -> datetime:
    return datetime.now(UTC) + timedelta(seconds=ttl_sec)
