# 서버 설계 — 저장·동기화·AI

> 2026-08-10. **FastAPI (Python) + PostgreSQL + Redis + 객체 스토리지.**
> 멀티프로세스로 돌리는 것을 전제로 설계한다.
>
> 상위 문서: `plan.md` 5-2 (아키텍처) · 5-4 (데이터 스키마) · 6 (수익 모델)

## 0. 이 서버가 하지 않는 것

**오디오를 렌더링하지 않는다.** `plan.md` 5-2 의 확정 결정이고 근거는 두 가지다 —
서버 왕복 지연으로는 편집 도구가 성립하지 않고, 사용자당 CPU 비용이 계속 나가면
"DAW 무료" 구조가 무너진다. 내보내기도 클라이언트의 `OfflineAudioContext` 가 한다.

그래서 이 서버는 **I/O 바운드**다. CPU 를 거의 안 쓰고, 오디오 라이브러리를 하나도
의존하지 않으며, 스케일 축은 연결 수와 스토리지다. 이 성질이 아래 설계 전체를 정한다.

> 나중에 AI 생성(Phase 3)이 들어오면 그때 CPU/GPU 바운드 작업이 생긴다.
> **그건 API 프로세스가 아니라 워커에서 돈다** (아래 2절).

## 1. 프로세스 구성

멀티프로세스에서 가장 흔한 사고는 **"한 프로세스에만 있는 상태"** 다.
프로세스를 역할별로 나누고, 상태는 전부 밖에 둔다.

| 프로세스 | 개수 | 하는 일 | 상태 |
|---|---|---|---|
| `api` | N (CPU 코어 수) | HTTP 요청 처리 | **없음** |
| `worker` | M | AI 생성, 썸네일, 정리 작업 | **없음** (잡 테이블에서 임대) |
| `scheduler` | 1 | 주기 작업 (정산, 만료 정리) | 리더 락 |
| `migrate` | 1회성 | 스키마 마이그레이션 | — |

### 절대 규칙

1. **`api` 프로세스에 상태를 두지 않는다.** 캐시·세션·레이트리밋·구독자 목록을
   메모리에 두면 워커마다 다른 답을 준다. 전부 Redis 나 Postgres 로.
2. **`BackgroundTasks` 를 쓰지 않는다.** 프로세스가 죽으면 같이 죽고, 재시도도
   관측도 없다. 백그라운드 작업은 **잡 테이블 + 워커**다 (2절).
3. **마이그레이션을 앱 시작 시점에 돌리지 않는다.** 워커 N개가 동시에 시작하면
   서로 경쟁한다. 배포 파이프라인에서 `migrate` 를 **한 번** 돌리고 그다음 롤아웃한다.
4. **인프로세스 스케줄러(APScheduler 등)를 `api` 에 붙이지 않는다.** N개가 각자
   돌아 같은 작업이 N번 실행된다. `scheduler` 를 하나만 띄우거나 리더 락을 쓴다.
5. **WebSocket·SSE 브로드캐스트는 Redis pub/sub 를 거친다.** 인프로세스로 뿌리면
   그 워커에 붙은 클라이언트만 받는다.

### 커넥션 풀 — 조용히 터지는 지점

```
workers × (pool_size + max_overflow) ≤ postgres.max_connections − 예약분
```

FastAPI 워커 8개 × 풀 20 = 160 커넥션. Postgres 기본 `max_connections` 가 100 이면
**배포하는 순간 터진다.** 흔하고, 부하가 걸려야 나타나서 스테이징에서 안 잡힌다.

- 워커당 풀은 작게 (5~10). I/O 바운드라 큰 풀이 필요 없다
- 워커를 8개 넘게 늘리면 **PgBouncer (transaction 모드)** 를 앞에 둔다
- PgBouncer transaction 모드에서는 세션 상태를 못 쓴다 →
  asyncpg 는 `statement_cache_size=0`, `prepared_statement_cache` 끄기

## 2. 백그라운드 작업 — 잡 테이블 + 임대

Redis 큐 대신 **Postgres 를 큐로 쓴다.** 이유:

- 잡과 결과가 **같은 트랜잭션**에 있다. "AI 결과는 저장됐는데 잡은 실패로 남음" 같은
  불일치가 원천적으로 안 생긴다
- 관측·재처리가 SQL 하나다. 운영에서 이게 크다
- 인프라가 하나 줄어든다. Redis 는 캐시·pub/sub 용으로만 남는다

처리량이 초당 수천 건이 되면 그때 전용 큐로 옮긴다. 지금 규모에서는 과설계다.

```sql
-- 워커가 잡을 집는 방법. SKIP LOCKED 가 핵심이다 —
-- 워커 M개가 동시에 돌아도 같은 잡을 두 번 집지 않는다
UPDATE ai_jobs SET
    status = 'running',
    locked_by = $1,
    locked_until = now() + interval '5 minutes',
    attempts = attempts + 1,
    started_at = coalesce(started_at, now())
WHERE id = (
    SELECT id FROM ai_jobs
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY priority DESC, run_after
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *;
```

- **임대(lease) 방식**이라 워커가 죽어도 `locked_until` 이 지나면 다른 워커가 집는다
- 그래서 **최소 한 번(at-least-once)** 실행이다 → 잡 처리는 **멱등**해야 한다
- 재시도는 지수 백오프로 `run_after` 를 밀어 둔다

## 3. 데이터 모델 — 핵심 판단

### 3-1. 프로젝트는 **문서 버전**으로 저장한다 (음표를 행으로 쪼개지 않는다)

`plan.md` 5-4 가 프로젝트를 **순수 직렬화 가능한 JSON** 으로 정했고, 클라이언트는
언제나 문서 전체를 읽고 쓴다. "3마디의 음만 주세요" 같은 요청이 없다.

| | 음표를 행으로 | **문서 JSONB (선택)** |
|---|---|---|
| 저장 한 번 | 음 1만 개 = 1만 행 변경 | 한 행 |
| 클라이언트 요구 | 없음 (항상 전체를 씀) | 그대로 맞음 |
| 스키마 진화 | 컬럼 마이그레이션 | `schemaVersion` + 코드 (`sound.md` 9-8) |
| 실시간 협업 | 유리 | 불리 |

협업은 `plan.md` 6-1 에서 MVP 밖으로 미뤄 뒀다. 나중에 필요해지면 **연산 로그
테이블을 옆에 추가**하면 되고, 지금 문서 모델을 택해도 그 길이 막히지 않는다.

### 3-2. 버전은 **불변**, 현재 위치만 움직인다

```
projects.head_version_id ──▶ project_versions (append only)
```

이 구조가 한 번에 주는 것:

- **기기 간 되돌리기** — 지금 언두는 브라우저 메모리에만 있다
- **동시 쓰기 안전** — 낙관적 잠금 (아래)
- **AI 출처 추적** — 어느 버전을 AI 가 만들었는지 (`차별점 ②`)
- **중복 제거** — 같은 내용을 다시 저장하면 새 행을 안 만든다 (`doc_sha256`)

### 3-3. 동시 쓰기는 **낙관적 잠금**

두 탭에서 같은 곡을 열어 두는 것은 흔하다. 잠금을 걸면 잠긴 채로 탭이 닫혔을 때
복구가 어렵고, 오프라인 편집과도 맞지 않는다.

```
PUT /projects/{id}   If-Match: <head_version_id>
  → 200  새 버전 생성, head 이동
  → 409  현재 head 를 함께 돌려준다. 클라이언트가 병합하거나 사용자에게 묻는다
```

**409 에 현재 문서를 실어 보낸다.** 안 그러면 클라이언트가 한 번 더 왕복해야 하고,
그 사이 또 바뀔 수 있다.

### 3-4. 오디오 파일은 **API 프로세스를 통과하지 않는다**

내보낸 WAV 는 수십~수백 MB 다. 그걸 FastAPI 가 버퍼링하면 워커 하나가 그 시간 동안
묶인다 — 멀티프로세스에서 가장 쉽게 서비스를 죽이는 방법이다.

```
클라이언트 ──(1) 업로드 URL 요청──▶ api
클라이언트 ◀─(2) presigned PUT ────┘
클라이언트 ──(3) 직접 업로드──────▶ 객체 스토리지
클라이언트 ──(4) 완료 통지────────▶ api  (sha256·크기 검증)
```

## 4. 스키마 (PostgreSQL)

```sql
-- ============================================================
-- 계정
-- ============================================================
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext UNIQUE NOT NULL,
    display_name    text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

-- 로그인 수단. 이메일/비밀번호와 OAuth 를 같은 사용자에 묶는다
CREATE TABLE auth_identities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        text NOT NULL,              -- 'password' | 'google' | ...
    subject         text NOT NULL,              -- provider 안의 고유 id
    secret_hash     text,                       -- password 일 때만
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);

-- 리프레시 토큰은 **서버가 취소할 수 있어야 한다**.
-- 액세스 토큰만 JWT 로 두고 수명을 짧게(10분) 가져간다
CREATE TABLE refresh_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      text NOT NULL UNIQUE,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    user_agent      text,
    -- 탈취 감지: 회전할 때 이전 토큰을 가리킨다. 이미 쓴 토큰이 다시 오면 전부 취소
    rotated_from    uuid REFERENCES refresh_tokens(id)
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ============================================================
-- 프로젝트
-- ============================================================
CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            text NOT NULL,
    head_version_id uuid,                       -- FK 는 아래에서 (순환 참조)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,

    -- 목록·검색·AI 힌트용 **파생 컬럼**. 문서에서 뽑아 쓰되 진실은 문서다.
    -- 이걸 안 두면 목록 한 번에 JSONB 를 전부 파싱해야 한다
    bpm             real,
    key_tonic       text,
    key_mode        text,
    length_bars     int,
    track_count     int,
    duration_sec    real,
    instrument_ids  text[]
);
CREATE INDEX ON projects (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON projects USING gin (instrument_ids);

-- **불변 버전.** 절대 UPDATE 하지 않는다
CREATE TABLE project_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq             bigint NOT NULL,            -- 프로젝트 안에서 1,2,3...
    parent_id       uuid REFERENCES project_versions(id),
    schema_version  int NOT NULL,               -- 문서의 schemaVersion (sound.md 9-8)
    doc             jsonb,                      -- 작으면 여기
    doc_key         text,                       -- 크면 객체 스토리지 키
    doc_sha256      bytea NOT NULL,
    size_bytes      int NOT NULL,
    created_by      uuid REFERENCES users(id),
    origin          text NOT NULL DEFAULT 'user',   -- 'user' | 'ai' (차별점 ②)
    ai_job_id       uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, seq),
    -- 둘 중 정확히 하나에만 들어 있어야 한다
    CONSTRAINT doc_location CHECK ((doc IS NULL) <> (doc_key IS NULL))
);
CREATE INDEX ON project_versions (project_id, seq DESC);
-- 같은 내용을 다시 저장하면 새 버전을 안 만든다
CREATE INDEX ON project_versions (project_id, doc_sha256);

ALTER TABLE projects
    ADD CONSTRAINT projects_head_fk
    FOREIGN KEY (head_version_id) REFERENCES project_versions(id);

-- 협업. 지금은 owner 만 쓰지만 **나중에 넣으면 전체 마이그레이션**이라 먼저 둔다
CREATE TABLE project_members (
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            text NOT NULL,              -- 'owner' | 'editor' | 'viewer'
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

-- ============================================================
-- 에셋 (내보낸 오디오, 사용자 샘플, IR)
-- ============================================================
CREATE TABLE assets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            text NOT NULL,              -- 'export' | 'sample' | 'ir'
    storage_key     text NOT NULL UNIQUE,
    content_type    text NOT NULL,
    size_bytes      bigint NOT NULL,
    sha256          bytea NOT NULL,
    -- 업로드는 3단계다. 완료 통지를 받기 전 행은 'pending' 이고,
    -- 방치된 pending 은 scheduler 가 지운다
    status          text NOT NULL DEFAULT 'pending',   -- 'pending' | 'ready'
    created_at      timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz
);
CREATE INDEX ON assets (owner_id, created_at DESC);
CREATE INDEX ON assets (status, created_at) WHERE status = 'pending';

CREATE TABLE project_exports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_id      uuid NOT NULL REFERENCES project_versions(id),
    asset_id        uuid NOT NULL REFERENCES assets(id),
    format          text NOT NULL,              -- 'wav' | 'mid'
    sample_rate     int,
    bit_depth       int,
    -- 클라이언트가 렌더하며 잰 값. 넘쳤으면 그대로 남긴다 (SOUND_QUALITY.md)
    peak_dbfs       real,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- "내 음색" — 파라미터 JSON 이다 (`sound.md` 8절). 용량이 0 이라 링크로 공유된다
CREATE TABLE tone_presets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            text NOT NULL,
    instrument_id   text NOT NULL,
    schema_version  int NOT NULL,
    params          jsonb NOT NULL,
    is_public       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tone_presets (owner_id, created_at DESC);

-- ============================================================
-- AI (Phase 3)
-- ============================================================
CREATE TABLE ai_jobs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
    base_version_id   uuid REFERENCES project_versions(id),
    kind              text NOT NULL,            -- 'generate' | 'tone' | ...
    request           jsonb NOT NULL,
    status            text NOT NULL DEFAULT 'queued',
                      -- queued | running | succeeded | failed | cancelled
    priority          int NOT NULL DEFAULT 0,
    attempts          int NOT NULL DEFAULT 0,
    max_attempts      int NOT NULL DEFAULT 3,
    run_after         timestamptz NOT NULL DEFAULT now(),
    locked_by         text,
    locked_until      timestamptz,
    result_version_id uuid REFERENCES project_versions(id),
    error             text,
    -- **같은 요청이 두 번 들어와도 잡이 하나여야 한다** (재시도·더블클릭)
    idempotency_key   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    finished_at       timestamptz,
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX ON ai_jobs (status, priority DESC, run_after)
    WHERE status IN ('queued', 'running');
CREATE INDEX ON ai_jobs (user_id, created_at DESC);

-- **컨텍스트 기억** (차별점 ①). 세션이 끝나도 취향을 기억한다
CREATE TABLE user_memory (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            text NOT NULL,              -- 'preference' | 'style' | 'fact'
    content         jsonb NOT NULL,
    source_job_id   uuid REFERENCES ai_jobs(id),
    -- 무료는 세션 1회성, 유료는 누적 (`plan.md` 6). 만료로 그 차이를 만든다
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON user_memory (user_id, kind, created_at DESC);

-- ============================================================
-- 과금 (DAW 무료 / AI 유료 — plan.md 6)
-- ============================================================
CREATE TABLE subscriptions (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan                text NOT NULL DEFAULT 'free',
    status              text NOT NULL DEFAULT 'active',
    current_period_end  timestamptz,
    -- **상업적 이용권은 유료 차별화 지점**이다 (`plan.md` 6).
    -- 곡을 만든 시점의 권리를 나중에 부정하면 안 되므로, 내보내기마다 스냅샷을 남긴다
    commercial_license  boolean NOT NULL DEFAULT false,
    external_ref        text,                   -- 결제사 구독 id
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- **사용량은 카운터가 아니라 원장이다.**
-- 카운터를 UPDATE 로 올리면 프로세스끼리 경쟁하고, 무엇보다 감사 추적이 사라진다
CREATE TABLE usage_events (
    id              bigserial PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            text NOT NULL,              -- 'ai_generation' | 'export' | ...
    quantity        int NOT NULL DEFAULT 1,
    job_id          uuid REFERENCES ai_jobs(id),
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (user_id, kind, occurred_at DESC);

-- ============================================================
-- 운영
-- ============================================================
-- 같은 요청을 두 번 받아도 한 번만 수행한다. 모든 변경 API 가 쓴다
CREATE TABLE idempotency_keys (
    key             text PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        text NOT NULL,
    request_hash    bytea NOT NULL,
    response_status int,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
CREATE INDEX ON idempotency_keys (created_at);

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    actor_id        uuid REFERENCES users(id),
    action          text NOT NULL,
    target_type     text,
    target_id       uuid,
    detail          jsonb,
    ip              inet,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (target_type, target_id, occurred_at DESC);
```

## 5. 무료 한도를 **DB 제약으로** 건다

`plan.md` 6 은 무료에 "저장 프로젝트 수, 협업 인원수" 제한을 두기로 했다.
애플리케이션 코드에서만 세면 **프로세스 두 개가 동시에 통과시킨다.**

```sql
-- 프로젝트 생성은 이 함수를 통해서만. 트랜잭션 안에서 세고 만든다
CREATE OR REPLACE FUNCTION create_project_checked(
    p_owner uuid, p_name text, p_limit int
) RETURNS uuid AS $$
DECLARE v_count int; v_id uuid;
BEGIN
    -- 같은 사용자의 동시 생성을 직렬화한다. 행 락이 아니라 자문 락이라
    -- 다른 사용자를 막지 않는다
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
    SELECT count(*) INTO v_count FROM projects
        WHERE owner_id = p_owner AND deleted_at IS NULL;
    IF v_count >= p_limit THEN
        RAISE EXCEPTION 'project_limit_reached' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO projects (owner_id, name) VALUES (p_owner, p_name) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;
```

## 6. 오프라인 우선을 깨지 않는다

지금 클라이언트는 **localStorage 자동저장 + 파일 열기/저장**으로 서버 없이 완결된다.
서버를 붙이면서 이걸 잃으면 안 된다 — 비행기에서 곡을 못 만드는 DAW 가 된다.

- 서버는 **동기화 대상**이지 진실의 원천이 아니다
- 저장 실패는 **경고**지 편집 차단이 아니다. 로컬에 남기고 나중에 올린다
- 충돌은 낙관적 잠금으로 감지하고 **사용자에게 보여 준다** (조용히 덮어쓰지 않는다)
- 로그인하지 않아도 앱이 그대로 동작해야 한다 — 계정은 동기화를 켜는 스위치다

## 7. 관측과 종료

- **헬스/레디니스를 나눈다.** health 는 프로세스가 살아 있는가, ready 는 DB·Redis 에
  붙었는가. 롤링 배포에서 이걸 안 나누면 준비 안 된 워커로 트래픽이 간다
- **SIGTERM 에 드레인한다.** `api` 는 새 요청을 안 받고 진행 중인 것만 끝낸다.
  `worker` 는 현재 잡을 끝내거나 임대를 반납한다 (반납해야 다른 워커가 바로 집는다)
- 요청마다 `request_id`, 잡마다 `job_id` 를 로그에 싣는다. 멀티프로세스에서 이게
  없으면 로그가 섞여서 못 읽는다

## 8. 지금 정해야 하는 것

- **결제사** (Stripe / 국내 PG) — `subscriptions.external_ref` 의 형태가 여기 달렸다
- **객체 스토리지** (S3 / R2 / 국내) — presigned URL 방식은 같지만 SDK 가 다르다
- **문서를 JSONB 에 둘 크기 상한** — 1MiB 로 시작하고 실제 프로젝트 크기를 보고 조정
- **인증 방식** — 이메일+비밀번호부터인지, OAuth 만인지

## 9. 만들지 않는 것 (지금은)

| 항목 | 이유 |
|---|---|
| 실시간 협업 (CRDT/OT) | `plan.md` 6-1 에서 MVP 밖. 문서 버전 모델이 나중 확장을 막지 않는다 |
| 서버 오디오 렌더링 | `plan.md` 5-2 확정 — 지연·비용·엔진 이중화 |
| 마이크로서비스 분리 | 트래픽이 없다. `api`/`worker` 두 종류로 충분하고, 나눌수록 운영이 는다 |
| 전용 큐 (Kafka/SQS) | Postgres 큐로 충분한 규모. 잡과 결과의 트랜잭션 일관성을 잃는다 |
