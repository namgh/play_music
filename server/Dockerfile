# 서버 이미지 — **프로세스 4종이 같은 이미지를 쓴다** (`SERVER_OPS.md` 2절).
#
# api·worker·scheduler·migrate 가 커맨드만 다르다. 이미지를 나누면 "워커만 옛 코드"
# 같은 상태가 생기고, 그 조합은 아무도 테스트하지 않는다.

FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# 의존성 레이어를 먼저 굳힌다. 코드만 바뀌면 여기는 캐시가 산다
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY app ./app
COPY alembic.ini ./

# **root 로 돌리지 않는다.** 컨테이너가 뚫렸을 때 할 수 있는 일을 줄인다
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin resona \
    && chown -R resona:resona /srv
USER resona

EXPOSE 8000

# 기본은 API. worker·scheduler·migrate 는 compose/배포에서 커맨드를 덮어쓴다.
#
# `--workers` 를 **환경변수로 받는다** (`SERVER.md` 1절):
#   workers × (db_pool_size + db_max_overflow) ≤ Postgres max_connections − 예약분
# 이 부등식을 깨면 트래픽이 아니라 **배포 직후**에 커넥션이 마른다.
ENV WEB_CONCURRENCY=4
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY}"]
