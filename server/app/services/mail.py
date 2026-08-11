"""메일 — 아웃박스에 넣고, 워커가 Gmail SMTP 로 보낸다.

**요청 안에서 직접 보내지 않는다.** 이유가 둘이다:

  1. **롤백.** 가입 트랜잭션이 뒤에서 실패했는데 확인 메일은 이미 나가면, 사용자는
     존재하지 않는 계정의 링크를 받는다. 아웃박스 행은 같은 트랜잭션에 들어가므로
     롤백되면 메일도 없던 일이 된다.
  2. **지연.** SMTP 는 몇 초씩 걸리고 가끔 안 된다. 그 동안 API 워커 하나가 묶이면
     그게 그대로 장애다.

Gmail 은 **앱 비밀번호**를 쓴다 (2단계 인증이 켜져 있어야 발급된다). 계정 비밀번호는
동작하지 않는다. 발송량이 늘면(하루 수백 통 이상) SendGrid·SES 같은 전송 전용
서비스로 옮긴다 — `send_now()` 만 갈아 끼우면 되도록 경계를 여기 두었다.
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
import uuid
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import EmailOutbox

log = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_TIMEOUT_SEC = float(os.environ.get("SMTP_TIMEOUT_SEC", "15"))


def _sender() -> tuple[str, str, str]:
    """(주소, 비밀번호, 표시이름). **비밀번호는 코드에 없다** — 환경변수뿐"""
    return (
        os.environ.get("SMTP_USER", ""),
        os.environ.get("SMTP_PASSWORD", ""),
        os.environ.get("MAIL_FROM_NAME", "RESONA"),
    )


def is_configured() -> bool:
    user, password, _ = _sender()
    return bool(user and password)


# --- 템플릿 -----------------------------------------------------------------
#
# HTML 을 안 쓰고 평문으로 보낸다. 확인 메일에서 중요한 것은 **링크가 보이는 것**이고,
# HTML 은 스팸 판정을 나쁘게 만들고 클라이언트마다 깨진다.

_TEMPLATES: dict[str, tuple[str, str]] = {
    "verify_email": (
        "[RESONA] 이메일을 확인해 주세요",
        "가입해 주셔서 고맙습니다.\n\n"
        "아래 링크를 열면 이메일 확인이 끝납니다. {expires_hours}시간 안에 열어 주세요.\n\n"
        "{link}\n\n"
        "본인이 가입한 것이 아니라면 이 메일을 무시하시면 됩니다. "
        "링크를 열지 않는 한 아무 일도 일어나지 않습니다.\n",
    ),
    "reset_password": (
        "[RESONA] 비밀번호 재설정",
        "비밀번호 재설정을 요청하셨습니다.\n\n"
        "아래 링크에서 새 비밀번호를 정할 수 있습니다. {expires_hours}시간 뒤에 만료됩니다.\n\n"
        "{link}\n\n"
        "요청하지 않으셨다면 무시하셔도 됩니다. 지금 비밀번호는 그대로입니다.\n"
        "다만 모르는 사이에 요청이 반복된다면 비밀번호를 바꾸시길 권합니다.\n",
    ),
    "org_invite": (
        "[RESONA] {org_name} 워크스페이스에 초대되었습니다",
        "{inviter} 님이 '{org_name}' 워크스페이스에 초대했습니다. (권한: {role})\n\n"
        "{link}\n\n"
        "{expires_hours}시간 뒤에 만료됩니다. 모르는 초대라면 무시하시면 됩니다.\n",
    ),
    "impersonation_notice": (
        "[RESONA] 고객지원이 계정에 접속했습니다",
        "문의 처리를 위해 고객지원 담당자가 회원님 계정에 접속했습니다.\n\n"
        "  사유: {reason}\n"
        "  시각: {started_at}\n"
        "  권한: {access}\n\n"
        "**이 접속은 회원님께 통지하도록 되어 있습니다.** 요청하신 적이 없다면 "
        "즉시 알려 주세요.\n",
    ),
    "export_ready": (
        "[RESONA] '{project_name}' 내보내기가 준비됐습니다",
        "'{project_name}' 내보내기가 끝났습니다.\n\n{link}\n\n"
        "링크는 보안을 위해 잠시 뒤 만료됩니다. 만료되면 앱에서 다시 받으실 수 있습니다.\n",
    ),
}


def render(template: str, payload: dict[str, Any]) -> tuple[str, str]:
    """알 수 없는 템플릿은 **여기서 터뜨린다.** 조용히 빈 메일을 보내는 것보다 낫다"""
    if template not in _TEMPLATES:
        raise KeyError(f"알 수 없는 메일 템플릿: {template}")
    subject_tpl, body_tpl = _TEMPLATES[template]
    values = {"expires_hours": 24, **payload}
    return subject_tpl.format(**values), body_tpl.format(**values)


# --- 아웃박스 ---------------------------------------------------------------


async def enqueue(
    session: AsyncSession,
    *,
    to_email: str,
    template: str,
    payload: dict[str, Any],
    delay_sec: int = 0,
) -> EmailOutbox:
    """**부르는 쪽의 트랜잭션에 들어간다.** 커밋하지 않는다 — 그게 요점이다"""
    render(template, payload)  # 지금 검증한다. 워커에서 터지면 재시도만 반복된다
    row = EmailOutbox(
        to_email=to_email,
        template=template,
        payload=payload,
        run_after=datetime.now(UTC) + timedelta(seconds=delay_sec),
    )
    session.add(row)
    return row


def build_message(*, to_email: str, template: str, payload: dict[str, Any]) -> EmailMessage:
    subject, body = render(template, payload)
    addr, _, display = _sender()

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((display, addr))
    msg["To"] = to_email
    msg["Message-ID"] = make_msgid(domain=addr.split("@")[-1] or "resona.local")
    # 목록 해제 헤더가 없으면 스팸 신고가 그대로 도메인 평판을 깎는다.
    # 거래 메일이라 구독 해제는 없지만, 문의 경로는 밝혀 둔다
    msg["Auto-Submitted"] = "auto-generated"
    msg.set_content(body)
    return msg


def send_now(*, to_email: str, template: str, payload: dict[str, Any]) -> None:
    """**동기 함수다.** 워커가 스레드에서 부른다 (`asyncio.to_thread`).

    `smtplib` 는 블로킹이라 이벤트 루프에서 직접 부르면 그 프로세스의 다른 잡이
    전부 멈춘다. aiosmtplib 를 쓰지 않는 이유는 의존성 하나 값어치가 없어서다 —
    메일은 초당 몇 통 수준이고, 스레드 하나면 충분하다.
    """
    user, password, _ = _sender()
    if not user or not password:
        raise RuntimeError("SMTP_USER / SMTP_PASSWORD 가 없다 — 메일을 보낼 수 없다")

    msg = build_message(to_email=to_email, template=template, payload=payload)
    context = ssl.create_default_context()

    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT_SEC, context=context) as s:
            s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT_SEC) as s:
            s.ehlo()
            s.starttls(context=context)  # **평문으로 로그인하지 않는다**
            s.ehlo()
            s.login(user, password)
            s.send_message(msg)


def is_permanent_failure(exc: Exception) -> bool:
    """되받을 가치가 없는 실패인가.

    주소가 없는 계정에 5번 재시도하는 것은 그 자체로 발신 평판을 깎는다.
    인증 실패도 마찬가지 — 재시도한다고 앱 비밀번호가 생기지 않는다.
    """
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return True
    if isinstance(exc, smtplib.SMTPRecipientsRefused | smtplib.SMTPNotSupportedError):
        return True
    code = getattr(exc, "smtp_code", None)
    return isinstance(code, int) and 500 <= code < 600


def link(path: str, token: str) -> str:
    base = os.environ.get("APP_BASE_URL", "http://localhost:5173").rstrip("/")
    return f"{base}{path}?token={token}"


def new_message_id() -> str:
    return uuid.uuid4().hex
