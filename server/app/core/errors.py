"""오류 형태를 하나로 — `SERVER_OPS.md` 7절.

`code` 는 기계용, `message` 는 사람용. 클라이언트가 `message` 를 파싱하게 만들면
문구를 영영 못 고친다. `request_id` 는 항상 실어 준다 — 문의가 오면 그걸로 로그를 찾는다.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request, status
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)


class AppError(Exception):
    """서비스가 의도적으로 내는 오류. 예상 못 한 예외와 구분한다"""

    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.details = details or {}
        self.headers = headers or {}


class NotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class Forbidden(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"


class Unauthorized(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"


class Conflict(AppError):
    """낙관적 잠금 충돌 등. **현재 상태를 details 에 실어 보낸다** (`SERVER.md` 3-3)"""

    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class LimitReached(AppError):
    status_code = status.HTTP_402_PAYMENT_REQUIRED
    code = "limit_reached"


class RateLimited(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"


class Unprocessable(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = "unprocessable"


def error_body(
    code: str, message: str, request_id: str, details: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
            "request_id": request_id,
        }
    }


async def app_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    request_id = getattr(request.state, "request_id", "-")
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, request_id, exc.details),
        headers={**exc.headers, "X-Request-Id": request_id},
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """**내부 사정을 밖으로 내보내지 않는다.** 스택은 로그에만 남긴다.

    여기서 반드시 로깅한다 — **요청과 예외를 동시에 아는 유일한 지점**이다.
    예전에는 아무것도 안 남겨서, uvicorn 이 찍는 트레이스백에 request_id·경로·
    사용자가 빠진 채로만 남았다. 같은 버그가 1000번 터져도 묶을 방법이 없었다.
    """
    request_id = getattr(request.state, "request_id", "-")
    log.exception(
        "unhandled_error",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "user_id": str(getattr(request.state, "user_id", "") or ""),
        },
        exc_info=exc,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=error_body(
            "internal_error",
            "일시적인 오류입니다. 잠시 후 다시 시도해 주세요",
            request_id,
        ),
        # **500 에도 헤더를 붙인다.** 사용자가 화면의 request_id 를 들고 문의할 때
        # 클라이언트가 헤더로도 같은 값을 로깅할 수 있어야 한다
        headers={"X-Request-Id": request_id},
    )
