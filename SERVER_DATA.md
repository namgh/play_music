# 스키마 형상관리와 데이터 정책

> `SERVER.md` 의 하위 문서. **Alembic** 으로 스키마를 관리하고, 무중단 배포와
> 보존·삭제 정책을 정한다.
>
> 전제: `api` 워커가 여러 개 동시에 돈다. **배포 중에는 옛 코드와 새 코드가 같은
> DB 를 함께 쓴다.** 이 한 문장이 아래 규칙 대부분의 이유다.

## 1. Alembic 설정 — 자동 생성이 쓸 만해지려면

### 1-1. 제약 이름 규칙을 먼저 정한다

이걸 안 정하면 Postgres 가 지어 준 이름(`projects_owner_id_fkey1` 같은)이 그대로
마이그레이션에 박힌다. 나중에 그 제약을 지우려 할 때 **환경마다 이름이 달라서**
스테이징에서는 되고 운영에서는 실패한다.

```python
# server/db/base.py
from sqlalchemy import MetaData

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}
metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

**첫 마이그레이션 전에 정해야 한다.** 나중에 바꾸면 기존 제약 전체를 개명하는
마이그레이션을 따로 써야 한다.

### 1-2. 자동 생성이 놓치는 것을 켜 둔다

```python
# server/migrations/env.py
context.configure(
    connection=connection,
    target_metadata=metadata,
    compare_type=True,             # 타입 변경 감지 (기본은 꺼져 있다)
    compare_server_default=True,   # 기본값 변경 감지
    include_schemas=False,
    # 마이그레이션이 운영 DB 를 오래 잠그지 못하게 막는다 (1-5)
    transaction_per_migration=True,
)
```

`compare_type` 이 꺼져 있으면 `varchar(50) → varchar(100)` 같은 변경이 **조용히
누락**된다. 모델에는 있고 DB 에는 없는 상태로 배포된다.

### 1-3. 헤드는 항상 하나 — CI 로 강제한다

브랜치 두 개에서 각각 마이그레이션을 만들면 헤드가 갈라진다. 머지된 뒤에야 발견되고,
그때는 `merge` 리비전을 손으로 써야 한다.

```bash
# CI 에서 돌린다
test "$(alembic heads | wc -l)" -eq 1 || { echo "헤드가 갈라졌다"; exit 1; }
# 모델과 DB 가 어긋나지 않는지도 본다 — 빈 마이그레이션이 나와야 정상
alembic upgrade head && alembic check
```

`alembic check` 는 "모델을 바꿨는데 마이그레이션을 안 만든" 경우를 잡는다.
**이게 없으면 로컬에서만 되는 코드가 머지된다.**

### 1-4. 다운그레이드에 기대지 않는다

`downgrade()` 는 작성하되 **운영 복구 수단으로 삼지 않는다.**

- 데이터를 지우는 마이그레이션은 되돌려도 데이터가 안 돌아온다
- 롤백 중에도 옛/새 코드가 섞여 돈다 — 다운그레이드가 그 상태를 더 나쁘게 만든다
- 운영 복구는 **앞으로 가는 수정(forward fix)** 이나 **백업 복원**이다

그래서 아래 확장-축소 절차가 필요하다.

### 1-5. 마이그레이션이 운영을 멈추지 못하게 한다

Postgres 의 DDL 은 대부분 `ACCESS EXCLUSIVE` 락을 잡는다. 그 앞에 긴 트랜잭션이
하나라도 있으면 **DDL 이 기다리고, 그 뒤의 모든 쿼리가 DDL 뒤에 줄을 선다.**
테이블 하나 바꾸려다 서비스가 멈춘다.

```python
def upgrade() -> None:
    # 못 잡으면 실패시킨다. 기다리다가 서비스를 멈추는 것보다 낫다
    op.execute("SET lock_timeout = '3s'")
    op.execute("SET statement_timeout = '30s'")
    op.add_column("projects", sa.Column("cover_asset_id", psql.UUID(), nullable=True))
```

인덱스는 **동시 생성**한다. 트랜잭션 안에서는 안 되므로 블록을 벗어난다:

```python
def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
            "ix_project_versions_project_id_seq ON project_versions (project_id, seq DESC)"
        )
```

> `CONCURRENTLY` 는 실패하면 **무효 인덱스**를 남긴다. 재시도 전에
> `DROP INDEX IF EXISTS` 를 먼저 넣는 이유다.

## 2. 무중단 배포 — 확장 후 축소

**한 릴리스에서 스키마와 코드를 동시에 바꾸면 배포 중에 반드시 깨진다.**
롤링 중에는 옛 워커와 새 워커가 같은 DB 를 쓰기 때문이다.

컬럼 하나를 바꾸는 데 **세 번의 배포**가 든다. 그게 정상이다.

```
릴리스 N     [확장]  새 컬럼을 nullable 로 추가. 옛 코드는 모른다
             배치 백필. 새 코드는 둘 다 쓴다(이중 쓰기)
릴리스 N+1   [전환]  새 코드가 새 컬럼만 읽는다. NOT NULL 을 건다
릴리스 N+2   [축소]  옛 컬럼을 지운다
```

| 변경 | 안전한가 | 방법 |
|---|---|---|
| nullable 컬럼 추가 | ✅ | 그냥 |
| **기본값 있는 컬럼 추가** | ✅ (PG11+) | 테이블 재작성 없음 |
| NOT NULL 걸기 | ❌ 바로 | 백필 → `NOT VALID` 체크 → `VALIDATE` |
| 컬럼 개명 | ❌ | 새 컬럼 추가 → 이중 쓰기 → 전환 → 삭제 |
| 컬럼 삭제 | ❌ 바로 | 코드에서 먼저 떼고 **다음 릴리스**에 삭제 |
| 타입 변경 | ❌ | 개명과 같은 절차 |
| 인덱스 추가 | ✅ | `CONCURRENTLY` |

백필은 **한 번의 UPDATE 로 하지 않는다.** 수백만 행을 한 트랜잭션에서 바꾸면 락과
WAL 이 터진다.

```sql
-- 배치로 나눠 돌린다. 워커에서 실행하고 진행 상황을 남긴다
UPDATE projects SET duration_sec = 0
WHERE id IN (
    SELECT id FROM projects WHERE duration_sec IS NULL LIMIT 1000
);
```

## 3. 문서 스키마 vs DB 스키마 — 축이 두 개다

헷갈리기 쉬운데 **전혀 다른 것**이다.

| | DB 스키마 | 문서 스키마 |
|---|---|---|
| 무엇 | 테이블·컬럼 | 프로젝트 JSON (`plan.md` 5-4) |
| 버전 | Alembic 리비전 | `schemaVersion` 정수 |
| 바꾸는 곳 | 마이그레이션 | 클라이언트·서버 양쪽 코드 |
| 규칙 | 확장 후 축소 | **필드 추가 자유, 제거·개명은 마이그레이션 함수 동반** (`sound.md` 9-8) |

`project_versions.schema_version` 을 컬럼으로 따로 두는 이유가 여기 있다.
**옛 버전을 읽을 때 어느 마이그레이션을 태울지 알아야 한다.** JSON 안을 파싱해서
알아내려 하면 목록 조회조차 무거워진다.

> 문서 마이그레이션은 **읽을 때** 적용하고 저장은 하지 않는다 (lazy).
> 전체를 일괄 변환하면 수백만 버전을 다시 쓰게 되고, 롤백도 못 한다.

## 4. 보존과 삭제

### 4-1. 삭제는 두 단계다

```
사용자가 삭제         → deleted_at 기록 (소프트)
30일 뒤 정리 잡        → 실제 행·객체 삭제 (하드)
```

- 소프트 구간이 있어야 **실수 복구**가 된다. 곡을 잃는 것은 되돌릴 수 없다
- 하드 삭제는 `scheduler` 가 큐에 넣고 `worker` 가 배치로 지운다
- 객체 스토리지 삭제가 실패해도 DB 는 지운다 → **고아 객체 청소 잡**을 따로 둔다
  (반대로 하면 DB 는 없는데 파일만 남아 계정 삭제가 안 끝난다)

### 4-2. 계정 삭제 — 무엇이 남는가

| 데이터 | 처리 | 이유 |
|---|---|---|
| 프로젝트·버전·에셋 | 하드 삭제 | 사용자의 창작물이다 |
| 음색 프리셋 | 공개본은 익명화, 나머지 삭제 | 남이 쓰고 있을 수 있다 |
| `usage_events` | 사용자 식별자 제거 후 집계만 보존 | 정산 근거 |
| 결제 기록 | **보존** | 법정 보존 의무 |
| `audit_log` | 보존 (actor 는 익명 id 로) | 보안 사고 조사 |

**"전부 지운다"가 항상 정답이 아니다.** 결제 기록을 지우면 세금 신고를 못 하고,
감사 로그를 지우면 침해 사고를 조사할 수 없다. 남기는 것은 **최소화하고 명시**한다.

### 4-3. 버전 보존 — 무한히 쌓게 두지 않는다

편집할 때마다 버전을 만들면 한 곡에 수천 개가 쌓인다.

- **자동 저장은 버전을 만들지 않는다.** 내용이 같으면(`doc_sha256`) 새 행이 없다
- 그래도 쌓이는 것은 **씨닝(thinning)** 한다: 최근 50개는 전부, 그 앞은 하루 1개,
  30일 이전은 주 1개. 명시적으로 "이름 붙인 버전"은 영구 보존
- 씨닝은 `scheduler` 가 밤에 돌린다

## 5. 백업과 복구

- **PITR 를 켠다** (Postgres WAL 아카이브). 스냅샷만으로는 "3시간 전 상태"로 못 간다
- 객체 스토리지는 **버저닝 + 수명주기 규칙**
- **복구 훈련을 분기마다 한다.** 안 해 본 백업은 백업이 아니다 —
  복원 시간(RTO)을 재서 기록한다
- 마이그레이션 배포 **직전에 스냅샷**을 남긴다. 확장-축소를 지켜도 사고는 난다

## 6. 테스트

- 마이그레이션은 **진짜 Postgres 로** 테스트한다 (SQLite 대체 금지 — JSONB·배열·
  부분 인덱스가 전부 다르게 동작한다)
- CI 에서 `alembic upgrade head` → `alembic check` → 시드 → 통합 테스트
- **다운그레이드도 한 번은 돌려 본다.** 못 되돌리는 마이그레이션을 발견하는 용도지
  운영에서 쓰려는 게 아니다
- 대용량 백필은 **운영 크기의 사본**에서 시간을 재 본다. 로컬 1천 행에서 1초면
  운영 1천만 행에서 3시간이다
