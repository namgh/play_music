"""API 프로세스 — 상태를 갖지 않는다 (`SERVER.md` 1절).

캐시·세션·레이트리밋·구독자 목록을 메모리에 두면 워커마다 다른 답을 준다.
전부 Redis 나 Postgres 로 간다.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1 import admin, assets, auth, billing, health, jobs, projects
from app.config import get_settings
from app.core import redis as r
from app.core.errors import AppError, app_error_handler, error_body, unhandled_error_handler
from app.db.session import dispose_engine, init_engine
from app.logging import setup_logging

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    setup_logging(settings)
    # **fork 이후에 만든다.** 부모에서 만들면 자식들이 커넥션을 공유해 깨진다
    init_engine(settings)
    r.init_redis(settings)
    log.info("api_started", extra={"env": settings.env})
    yield
    # SIGTERM 드레인: FastAPI 가 진행 중 요청을 끝낸 뒤 여기 온다
    await dispose_engine()
    await r.close_redis()
    log.info("api_stopped")


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
        로그가 섞여서 못 읽는다"""
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["X-Request-Id"] = request_id
        log.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "elapsed_ms": round(elapsed_ms, 2),
            },
        )
        return response

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
    app.include_router(auth.router, prefix="/v1")
    app.include_router(projects.router, prefix="/v1")
    app.include_router(assets.router, prefix="/v1")
    app.include_router(jobs.router, prefix="/v1")
    app.include_router(billing.router, prefix="/v1")
    app.include_router(admin.router, prefix="/v1")
    return app


app = create_app()
