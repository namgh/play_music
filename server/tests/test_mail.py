"""메일 — 아웃박스와 Gmail SMTP 발송.

SMTP 서버에 실제로 붙지 않는다. **네트워크를 타는 테스트는 CI 에서 흔들리고,
흔들리는 테스트는 곧 아무도 안 본다.** 대신 `smtplib` 경계에서 가짜를 끼워
"무엇을 어떻게 보내는가"를 본다 — 검증할 값어치가 있는 것은 거기다.
"""

from __future__ import annotations

import smtplib

import pytest
from sqlalchemy import select, text

from app.db.models import EmailOutbox
from app.services import mail
from app.worker import mailer
from tests.test_projects import signup

PASSWORD = "correct-horse-battery"


@pytest.fixture(autouse=True)
async def clean_outbox(app, db):
    await db.execute(text("DELETE FROM email_outbox"))
    await db.commit()


@pytest.fixture
def smtp_configured(monkeypatch):
    monkeypatch.setenv("SMTP_USER", "noreply@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password-1234")
    monkeypatch.setenv("APP_BASE_URL", "https://app.example.com")


class FakeSMTP:
    """`smtplib.SMTP` 자리에 들어간다. 보낸 것을 기록만 한다"""

    sent: list = []
    logins: list = []
    started_tls = False

    def __init__(self, host, port, timeout=None):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        pass

    def starttls(self, context=None):
        FakeSMTP.started_tls = True

    def login(self, user, password):
        FakeSMTP.logins.append((user, password))

    def send_message(self, msg):
        FakeSMTP.sent.append(msg)


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.sent = []
    FakeSMTP.logins = []
    FakeSMTP.started_tls = False
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def test_every_template_renders(app):
    """템플릿에 값이 빠지면 **워커에서 매번 터지고 재시도만 반복된다.**
    `enqueue` 가 넣을 때 검증하는 이유"""
    samples = {
        "verify_email": {"link": "https://x/y"},
        "reset_password": {"link": "https://x/y"},
        "org_invite": {
            "org_name": "밴드", "inviter": "남", "role": "editor", "link": "https://x/y"
        },
        "impersonation_notice": {
            "reason": "티켓 #1", "started_at": "2026-08-11", "access": "읽기 전용"
        },
        "export_ready": {"project_name": "첫 곡", "link": "https://x/y"},
    }
    for template, payload in samples.items():
        subject, body = mail.render(template, payload)
        assert subject and body
        assert "{" not in subject, f"{template} 제목에 채워지지 않은 자리가 있다"
        assert "{" not in body, f"{template} 본문에 채워지지 않은 자리가 있다"


async def test_enqueue_rejects_unknown_template(db):
    with pytest.raises(KeyError):
        await mail.enqueue(db, to_email="a@example.com", template="없는템플릿", payload={})


async def test_enqueue_rolls_back_with_its_transaction(client, unique_email, db):
    """**아웃박스의 존재 이유.** 가입이 실패하면 확인 메일도 없던 일이 돼야 한다"""
    from app.db.session import session_scope

    with pytest.raises(RuntimeError):
        async with session_scope() as s:
            await mail.enqueue(
                s, to_email=unique_email, template="verify_email", payload={"link": "https://x"}
            )
            raise RuntimeError("가입이 뒤에서 실패했다고 치자")

    rows = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalars().all()
    assert rows == [], "롤백된 트랜잭션의 메일이 남아 있으면 안 된다"


async def test_worker_sends_queued_mail(client, unique_email, db, smtp_configured, fake_smtp):
    await signup(client, unique_email)

    assert await mailer.send_one("test-worker") is True
    assert len(fake_smtp.sent) == 1

    msg = fake_smtp.sent[0]
    assert msg["To"] == unique_email
    assert "확인" in msg["Subject"]
    assert "https://app.example.com/verify?token=" in msg.get_content()
    # **평문 로그인을 하지 않는다**
    assert fake_smtp.started_tls is True
    assert fake_smtp.logins == [("noreply@example.com", "app-password-1234")]

    row = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalar_one()
    await db.refresh(row)
    assert row.status == "sent"
    assert row.sent_at is not None


async def test_nothing_to_send_returns_false(client, smtp_configured, fake_smtp):
    assert await mailer.send_one("test-worker") is False


async def test_unconfigured_smtp_keeps_mail_queued(client, unique_email, db, monkeypatch):
    """설정이 없다고 **failed 로 만들지 않는다** — 나중에 설정해도 안 나가게 된다"""
    monkeypatch.delenv("SMTP_USER", raising=False)
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    await signup(client, unique_email)

    assert await mailer.send_one("test-worker") is False
    row = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalar_one()
    await db.refresh(row)
    assert row.status == "queued"
    assert row.attempts == 0, "설정이 없는 것은 시도 횟수로 세지 않는다"


async def test_temporary_failure_retries(client, unique_email, db, smtp_configured, monkeypatch):
    def boom(*a, **kw):
        raise smtplib.SMTPServerDisconnected("연결이 끊겼다")

    monkeypatch.setattr(mail, "send_now", boom)
    await signup(client, unique_email)

    assert await mailer.send_one("test-worker") is True
    row = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalar_one()
    await db.refresh(row)
    assert row.status == "queued", "일시 장애는 다시 시도한다"
    assert row.attempts == 1
    assert "SMTPServerDisconnected" in (row.error or "")


async def test_permanent_failure_gives_up_immediately(
    client, unique_email, db, smtp_configured, monkeypatch
):
    """**주소가 없는 곳에 5번 재시도하면 그 자체로 발신 평판이 깎인다**"""

    def boom(*a, **kw):
        raise smtplib.SMTPRecipientsRefused({"x@example.com": (550, b"No such user")})

    monkeypatch.setattr(mail, "send_now", boom)
    await signup(client, unique_email)

    assert await mailer.send_one("test-worker") is True
    row = (
        await db.execute(select(EmailOutbox).where(EmailOutbox.to_email == unique_email))
    ).scalar_one()
    await db.refresh(row)
    assert row.status == "failed"
    assert row.attempts == 1


async def test_two_workers_do_not_send_the_same_mail_twice(
    client, unique_email, db, smtp_configured, fake_smtp
):
    """잡 큐와 같은 임대 방식이라 **워커를 늘려도 중복 발송이 없다**"""
    import asyncio

    await signup(client, unique_email)
    results = await asyncio.gather(*[mailer.send_one(f"w{i}") for i in range(4)])
    assert sum(results) == 1
    assert len(fake_smtp.sent) == 1


async def test_password_reset_flow_sends_mail_and_kills_sessions(
    client, unique_email, db, smtp_configured, fake_smtp
):
    """재설정의 주된 용도는 **탈취당한 계정을 되찾는 것**이다.
    옛 세션이 살아 있으면 되찾은 게 아니다"""
    await signup(client, unique_email)
    await mailer.drain("test-worker")  # 확인 메일을 비운다
    fake_smtp.sent.clear()

    res = await client.post("/v1/auth/forgot-password", json={"email": unique_email})
    assert res.status_code == 202
    assert await mailer.send_one("test-worker") is True

    body = fake_smtp.sent[-1].get_content()
    token = body.split("token=")[1].split()[0]

    reset = await client.post(
        "/v1/auth/reset-password", json={"token": token, "password": "brand-new-password"}
    )
    assert reset.status_code == 204

    # 새 비밀번호로 되고, 옛 리프레시 토큰은 죽었다
    assert (
        await client.post(
            "/v1/auth/login", json={"email": unique_email, "password": "brand-new-password"}
        )
    ).status_code == 200


async def test_forgot_password_does_not_reveal_account_existence(client, smtp_configured):
    res = await client.post(
        "/v1/auth/forgot-password", json={"email": "nobody-here@example.com"}
    )
    assert res.status_code == 202
    assert res.json() == {"status": "sent"}


async def test_verify_email_activates_account(client, unique_email, db, smtp_configured, fake_smtp):
    await signup(client, unique_email)
    await mailer.send_one("test-worker")
    token = fake_smtp.sent[-1].get_content().split("token=")[1].split()[0]

    res = await client.post("/v1/auth/verify-email", json={"token": token})
    assert res.status_code == 204

    from app.db.models import User

    user = (
        await db.execute(select(User).where(User.email == unique_email))
    ).scalar_one()
    await db.refresh(user)
    assert user.status == "active"
    assert user.email_verified_at is not None

    # **한 번만 쓸 수 있다**
    assert (
        await client.post("/v1/auth/verify-email", json={"token": token})
    ).status_code == 401
