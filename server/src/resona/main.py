"""API 프로세스 — 상태를 갖지 않는다 (`SERVER.md` 1절).

캐시·세션·레이트리밋·구독자 목록을 메모리에 두면 워커마다 다른 답을 준다.
전부 Redis 나 Postgres 로 간다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from resona.core import health
from resona.core import redis as r
from resona.core.config import get_settings
from resona.core.db import dispose_engine, init_engine
from resona.core.errors import AppError, app_error_handler, error_body, unhandled_error_handler
from resona.core.logging import setup_logging

# **도메인 모듈에서 라우터를 직접 가져온다.**
# `domains/<d>/__init__.py` 로 re-export 하지 않는 이유는, 알렘빅이 메타데이터를
# 채우려고 `resona.domains` 를 임포트하는데 그때 FastAPI 라우터까지 딸려 오면
# 마이그레이션이 앱 전체에 의존하게 되기 때문이다
from resona.domains.accounts import router as accounts_router
from resona.domains.accounts import router_me as accounts_me_router
from resona.domains.assets import router as assets_router
from resona.domains.billing import router as billing_router
from resona.domains.jobs import router as jobs_router
from resona.domains.jobs import router_events as jobs_events_router
from resona.domains.ops import router as ops_router
from resona.domains.payments import router as payments_router
from resona.domains.payments import router_stripe as payments_stripe_router
from resona.domains.projects import router as projects_router
from resona.domains.projects import router_presets as projects_presets_router
from resona.domains.workspaces import router as workspaces_router

log = logging.getLogger(__name__)


# LB 가 이 인스턴스를 뺄 시간. 헬스체크 주기의 두 배쯤을 준다 —
# 짧으면 빼기도 전에 죽어서 진행 중 요청이 5xx 로 나간다
DRAIN_WAIT_SEC = float(os.environ.get("DRAIN_WAIT_SEC", "8"))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    setup_logging(settings)
    # **fork 이후에 만든다.** 부모에서 만들면 자식들이 커넥션을 공유해 깨진다
    init_engine(settings)
    r.init_redis(settings)
    _install_drain_handler()
    log.info("api_started", extra={"env": settings.env})
    yield
    # 여기 도달했다는 것은 uvicorn 이 이미 수신을 멈췄다는 뜻이다.
    # **실제 드레인은 SIGTERM 핸들러가 더 앞에서 시작한다** (`_install_drain_handler`)
    await dispose_engine()
    await r.close_redis()
    log.info("api_stopped")


def _install_drain_handler() -> None:
    """SIGTERM 을 받으면 **먼저 `/readyz` 를 실패로 바꾸고** 잠시 기다린다.

    순서가 핵심이다 (`SERVER_OPS.md` 4절):
        SIGTERM → readyz 503 → LB 가 뺀다 → 진행 중 요청 완료 → 종료

    uvicorn 도 SIGTERM 을 받아 종료를 시작하므로, 우리는 플래그만 세우고 기본
    핸들러로 넘긴다. 기다리는 동안 uvicorn 은 진행 중 요청을 계속 처리한다.
    """
    loop = asyncio.get_running_loop()
    previous = signal.getsignal(signal.SIGTERM)

    def on_sigterm(signum, frame):  # type: ignore[no-untyped-def]
        health.begin_drain()
        log.info("api_draining", extra={"wait_sec": DRAIN_WAIT_SEC})
        loop.call_later(DRAIN_WAIT_SEC, lambda: None)
        if callable(previous):
            previous(signum, frame)

    with contextlib.suppress(ValueError):  # 메인 스레드가 아니면 못 건다
        signal.signal(signal.SIGTERM, on_sigterm)


# API 는 JSON 만 낸다. 그래도 헤더를 다는 이유는 **오류 응답이나 잘못된
# Content-Type 으로 브라우저가 내용을 해석하려 드는 경우**를 막기 위해서다.
# CSP 는 문서를 안 내보내므로 최소한만 — 프레임 삽입과 스니핑을 끊는다
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="RESONA API",
        version="1.0.0",
        lifespan=lifespan,
        # 오류 형태를 우리가 통제한다 (`SERVER_OPS.md` 7절)
        docs_url="/docs" if not settings.is_production else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,  # 리프레시 쿠키
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag", "X-Request-Id", "X-Version-Unchanged"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
        """**모든 로그에 `request_id` 를 싣는다.** 멀티프로세스에서 이게 없으면
        로그가 섞여서 못 읽는다.

        **5xx 도 반드시 로그를 남긴다.** 예전에는 `call_next` 이후에만 찍어서,
        처리되지 않은 예외가 미들웨어를 뚫고 올라가면 **로그가 아예 안 남았다** —
        로그만 보면 5xx 가 0건이고, DB 풀 고갈처럼 전부 500 이 되는 장애에서는
        오히려 조용해졌다. 가장 봐야 할 요청이 가장 안 보였다.
        """
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()

        # **본문을 읽기 전에** 크기를 본다. 파싱한 뒤 거절하면 메모리는 이미 썼다
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
            return JSONResponse(
                status_code=413,
                content=error_body(
                    "payload_too_large",
                    "요청이 너무 큽니다",
                    request_id,
                    {"limit_bytes": settings.max_body_bytes},
                ),
                headers={"X-Request-Id": request_id},
            )

        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-Id"] = request_id
            for header, value in _SECURITY_HEADERS.items():
                response.headers.setdefault(header, value)
            if settings.is_production:
                response.headers.setdefault(
                    "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
                )
            return response
        finally:
            log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    # **라우트 템플릿**으로 남긴다. 원문 경로는 UUID 가 섞여 있어
                    # 엔드포인트별로 묶이지 않는다
                    "route": getattr(request.scope.get("route"), "path", request.url.path),
                    "path": request.url.path,
                    "status": status,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
                    "user_id": str(getattr(request.state, "user_id", "") or ""),
                },
            )

    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        """FastAPI 기본 형식 대신 **우리 오류 형태**로 통일한다"""
        return JSONResponse(
            status_code=422,
            content=error_body(
                "validation_error",
                "요청 형식이 올바르지 않습니다",
                getattr(request.state, "request_id", "-"),
                {"fields": exc.errors()},
            ),
        )

    app.include_router(health.router)
    for domain_router in (
        accounts_router,
        accounts_me_router,
        workspaces_router,
        projects_router,
        projects_presets_router,
        assets_router,
        jobs_router,
        jobs_events_router,
        billing_router,
        payments_router,
        payments_stripe_router,
        ops_router,
    ):
        app.include_router(domain_router.router, prefix="/v1")
    return app


app = create_app()
