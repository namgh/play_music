"""잡 상태 철자 통일 — cancelled → canceled

`subscriptions` 는 `canceled`, `ai_jobs` 는 `cancelled` 로 갈렸다. 코드는 한쪽만
쓰므로 취소 요청이 **체크 제약 위반으로 500 이 났다** (테스트가 잡음).
결제사(Stripe)와 구독 테이블에 맞춰 `canceled` 로 통일한다.

리비전: 2b946fa8fef2
이전:   b5b1b19ad8ac
생성:   2026-08-11 08:05:43.574385

주의 (`SERVER_DATA.md` 2절):
  - 롤링 배포 중에는 **옛 코드와 새 코드가 같은 DB 를 쓴다**
  - 컬럼 삭제·개명은 **다음 릴리스**로 미룬다 (확장 후 축소)
  - 인덱스는 `CONCURRENTLY`, DDL 앞에는 `lock_timeout`
"""
from __future__ import annotations

from alembic import op

revision: str = '2b946fa8fef2'
down_revision: str | None = 'b5b1b19ad8ac'
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # DDL 하나가 서비스를 멈추지 못하게 한다
    op.execute("SET lock_timeout = '3s'")
    # 아직 아무도 이 값을 못 넣었으므로 데이터 변환은 필요 없다.
    # 값이 있었다면 UPDATE 를 먼저 하고 제약을 바꿔야 한다 (순서가 반대면 실패한다)
    op.drop_constraint("status", "ai_jobs", type_="check")
    op.create_check_constraint(
        "status",
        "ai_jobs",
        "status IN ('queued','running','succeeded','failed','canceled')",
    )


def downgrade() -> None:
    # **운영 복구 수단으로 쓰지 않는다** — 앞으로 가는 수정이나 백업 복원이다.
    # 못 되돌리는 마이그레이션을 CI 에서 발견하는 용도다
    op.drop_constraint("status", "ai_jobs", type_="check")
    op.create_check_constraint(
        "status",
        "ai_jobs",
        "status IN ('queued','running','succeeded','failed','cancelled')",
    )
