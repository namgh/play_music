# server — RESONA 백엔드

FastAPI + PostgreSQL + Redis. **오디오는 여기서 한 줄도 돌지 않는다** (`plan.md` 5-2 —
확정된 결정). 렌더링·재생·내보내기는 전부 브라우저가 하고, 서버는 저장·동기화·계정·
과금·AI 잡만 맡는다. 그래서 이 서버는 전부 I/O 바운드다.

설계 근거는 저장소 루트의 문서에 있다. **코드를 고치기 전에 해당 문서를 먼저 읽어라.**

| 문서 | 내용 |
|---|---|
| `SERVER.md` | 프로세스 구성, 절대 규칙, 커넥션 풀, 잡 큐, 문서 버전 모델 |
| `SERVER_DATA.md` | Alembic 규약, 무중단 마이그레이션(확장 후 축소), 보존·삭제 |
| `SERVER_REDIS.md` | 캐시/코어 분리, 키 규칙, 실패 모드 표 |
| `SERVER_ACCOUNTS.md` | 계정 상태 기계, 토큰 회전, 2축 RBAC, 대리 접속 |
| `SERVER_BILLING.md` | 플랜, 사용량 원장, 웹훅 내성, 라이선스 스냅샷 |
| `SERVER_OPS.md` | 배포 순서, 헬스체크, 드레인, 로그·지표, API 규약 |

## 시작하기

```bash
docker compose up -d              # postgres(55432) · redis(56379)
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env              # .env 는 커밋하지 않는다
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m pytest        # 진짜 Postgres·Redis 로 돈다
```

앱 프로세스까지 컨테이너로 띄우려면 `docker compose --profile app up`.

## 프로세스 넷

같은 이미지, 커맨드만 다르다.

| | 커맨드 | 하는 일 |
|---|---|---|
| `migrate` | `alembic upgrade head` | **앱 시작 시 돌리지 않는다.** N개 인스턴스가 같은 DDL 을 친다 |
| `api` | `uvicorn ... --workers N` | 상태를 갖지 않는다. 잡을 처리하지 않는다 |
| `worker` | `python -m app.worker.main` | 잡 테이블에서 임대해 처리. 여러 개 띄워도 안전 |
| `scheduler` | `python -m app.scheduler.main` | 주기 작업. 하나만 띄운다 (락은 최후 방어선) |

## 이 코드에서 절대 하지 않는 것

- **API 프로세스에 상태를 두지 않는다** — 인스턴스가 늘면 상태가 갈라진다
- **`BackgroundTasks` 로 일을 처리하지 않는다** — 배포 때 사라지고 재시도가 없다
- **앱 시작 시 마이그레이션을 돌리지 않는다**
- **API 안에 스케줄러를 넣지 않는다** — 인스턴스 수만큼 중복 실행된다
- **파일 바이트를 API 로 통과시키지 않는다** — 서명 URL 만 발급한다
- **어드민에게 남의 프로젝트를 읽는 경로를 주지 않는다** — 대리 접속(동의·시한·감사)만

## 이 코드가 지키는 성질

테스트가 이것들을 잠그고 있다 (`tests/`). 깨면 CI 가 잡는다.

- 저장은 `If-Match` 낙관적 잠금. 충돌 시 **현재 문서를 409 에 실어** 준다
- 같은 내용을 다시 저장해도 새 버전을 만들지 않는다 (자동 저장이 이력을 더럽히지 않게)
- 리프레시 토큰은 회전하고, **재사용이 감지되면 그 계정의 모든 세션을 끊는다**
- 정지 계정은 **로그인·읽기·반출이 되고 편집만 막힌다**
- 상업 이용 권리는 **내보낸 시점에 고정**되고 해지해도 회수되지 않는다
- 웹훅은 중복·역순·지연이 와도 구독 상태를 망가뜨리지 않는다
- 워커 여럿이 같은 잡을 두 번 집지 않는다 (`FOR UPDATE SKIP LOCKED`)
- 실패한 잡은 과금하지 않는다. 사용량은 **성공과 같은 트랜잭션**에서 기록된다
