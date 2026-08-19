"""저장용 대칭 암호화 — 지금은 **빌링키** 하나를 위해 있다.

빌링키는 카드번호가 아니라서 PCI 범위 밖이지만, **그것만 있으면 그 카드에 청구가
된다.** 우리 시크릿 키까지 있어야 하긴 하나, DB 만 새는 사고(백업 유출, 덤프 유출)는
시크릿 키가 함께 새는 사고보다 훨씬 흔하다. 그래서 DB 안에서는 평문으로 두지 않는다.

**복호화는 이 모듈에서만 한다.** 여러 곳에서 풀기 시작하면 어디가 평문을 로그에
흘리는지 추적할 수 없게 된다.

## 형식

    [버전 1바이트][논스 12바이트][암호문+태그]

버전 바이트를 두는 이유는 **나중에 알고리즘이나 키를 바꿀 수 있게** 하기 위해서다.
없으면 형식을 바꾸는 순간 기존 행을 전부 못 읽는다.
"""

from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from resona.core.config import Settings
from resona.core.errors import AppError

#: AES-256-GCM
_V1 = 1
_NONCE_BYTES = 12
_KEY_BYTES = 32


class EncryptionUnavailable(AppError):
    """키가 없거나 잘못됐다. **평문으로 넘어가지 않는다** — 그건 조용한 사고다"""

    status_code = 503
    code = "encryption_unavailable"


class DecryptionFailed(AppError):
    """복호화 실패. 키를 바꿨거나 데이터가 변조됐다"""

    status_code = 500
    code = "decryption_failed"


def _key(settings: Settings) -> bytes:
    raw = settings.payment_enc_key.get_secret_value()
    if not raw:
        raise EncryptionUnavailable(
            "PAYMENT_ENC_KEY 가 설정되지 않아 결제 수단을 저장할 수 없습니다"
        )
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise EncryptionUnavailable("PAYMENT_ENC_KEY 가 base64 가 아니다") from exc
    if len(key) != _KEY_BYTES:
        raise EncryptionUnavailable(
            f"PAYMENT_ENC_KEY 는 {_KEY_BYTES}바이트여야 한다 (지금 {len(key)}바이트)"
        )
    return key


def encrypt(settings: Settings, plaintext: str) -> bytes:
    """**논스는 매번 새로 만든다.** 같은 논스를 두 번 쓰면 GCM 은 평문이 복구된다"""
    nonce = os.urandom(_NONCE_BYTES)
    blob = AESGCM(_key(settings)).encrypt(nonce, plaintext.encode(), None)
    return bytes([_V1]) + nonce + blob


def decrypt(settings: Settings, blob: bytes) -> str:
    if not blob or blob[0] != _V1:
        raise DecryptionFailed("알 수 없는 암호문 형식이다")
    nonce = blob[1 : 1 + _NONCE_BYTES]
    body = blob[1 + _NONCE_BYTES :]
    try:
        return AESGCM(_key(settings)).decrypt(nonce, body, None).decode()
    except InvalidTag as exc:
        # 키를 바꿨거나 누가 손댔다. **둘 다 조용히 넘어가면 안 되는 상황이다**
        raise DecryptionFailed(
            "결제 수단을 복호화하지 못했습니다. 카드를 다시 등록해 주세요"
        ) from exc
