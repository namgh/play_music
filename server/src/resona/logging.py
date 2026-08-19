"""구조화 로그 — `SERVER_OPS.md` 5절.

멀티프로세스에서 텍스트 로그는 섞여서 못 읽는다. JSON 으로 내고 `request_id`·`job_id`
를 항상 싣는다.

그리고 **PII 필터를 로거에 건다.** 사람이 조심하는 것으로는 반드시 새어 나간다.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

from resona.config import Settings

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module",
    "exc_info", "exc_text", "stack_info", "lineno", "funcName", "created", "msecs",
    "relativeCreated", "thread", "threadName", "processName", "process", "taskName",
}


class PiiFilter(logging.Filter):
    """이메일을 마스킹한다. 완벽하진 않지만 **가장 흔한 유출 경로**를 막는다"""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _EMAIL.sub("<email>", record.msg)
        for key, value in list(record.__dict__.items()):
            if isinstance(value, str) and key not in _RESERVED:
                record.__dict__[key] = _EMAIL.sub("<email>", value)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(settings: Settings) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(PiiFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO if settings.is_production else logging.DEBUG)

    # 접근 로그는 우리 미들웨어가 낸다. uvicorn 것과 이중으로 남기지 않는다
    logging.getLogger("uvicorn.access").disabled = True
