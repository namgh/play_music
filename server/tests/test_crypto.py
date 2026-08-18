"""빌링키 암호화.

빌링키는 카드번호가 아니라서 PCI 범위 밖이지만, **그것만 있으면 그 카드에 청구가
된다.** DB 만 새는 사고(백업·덤프 유출)는 시크릿 키까지 함께 새는 사고보다 훨씬
흔해서, DB 안에서는 평문으로 두지 않는다.
"""

from __future__ import annotations

import base64

import pytest
from pydantic import SecretStr

from app.core import crypto


async def test_round_trip(settings):
    blob = crypto.encrypt(settings, "billing_key_secret_value")
    assert crypto.decrypt(settings, blob) == "billing_key_secret_value"


async def test_ciphertext_never_contains_the_plaintext(settings):
    blob = crypto.encrypt(settings, "bk_verysecret")
    assert b"bk_verysecret" not in blob


async def test_same_plaintext_encrypts_differently_every_time(settings):
    """**논스를 재사용하면 GCM 은 평문이 복구된다.** 매번 새로 만드는지 본다"""
    a = crypto.encrypt(settings, "same")
    b = crypto.encrypt(settings, "same")
    assert a != b
    assert crypto.decrypt(settings, a) == crypto.decrypt(settings, b) == "same"


async def test_tampering_is_detected(settings):
    """GCM 은 인증 암호다 — 한 바이트만 바뀌어도 복호화가 실패해야 한다.
    조용히 쓰레기를 돌려주면 그걸 빌링키로 알고 결제를 시도하게 된다"""
    blob = bytearray(crypto.encrypt(settings, "bk_1"))
    blob[-1] ^= 0x01
    with pytest.raises(crypto.DecryptionFailed):
        crypto.decrypt(settings, bytes(blob))


async def test_a_different_key_cannot_read_it(settings, monkeypatch):
    blob = crypto.encrypt(settings, "bk_1")
    monkeypatch.setattr(
        settings, "payment_enc_key", SecretStr(base64.b64encode(b"z" * 32).decode())
    )
    with pytest.raises(crypto.DecryptionFailed):
        crypto.decrypt(settings, blob)


async def test_unknown_format_is_rejected(settings):
    """버전 바이트를 두는 이유 — 나중에 형식을 바꿔도 옛 행을 구분할 수 있어야 한다"""
    with pytest.raises(crypto.DecryptionFailed):
        crypto.decrypt(settings, b"\x99nonsense")


async def test_missing_key_fails_loudly_instead_of_storing_plaintext(settings, monkeypatch):
    """**평문으로 넘어가면 안 된다.** 그건 아무도 모르는 사고가 된다"""
    monkeypatch.setattr(settings, "payment_enc_key", SecretStr(""))
    with pytest.raises(crypto.EncryptionUnavailable):
        crypto.encrypt(settings, "bk_1")


async def test_wrong_key_length_is_rejected_at_use(settings, monkeypatch):
    monkeypatch.setattr(
        settings, "payment_enc_key", SecretStr(base64.b64encode(b"tooshort").decode())
    )
    with pytest.raises(crypto.EncryptionUnavailable) as exc:
        crypto.encrypt(settings, "bk_1")
    assert "32" in str(exc.value)
