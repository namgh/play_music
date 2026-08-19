"""${message}

리비전: ${up_revision}
이전:   ${down_revision | comma,n}
생성:   ${create_date}

주의 (`SERVER_DATA.md` 2절):
  - 롤링 배포 중에는 **옛 코드와 새 코드가 같은 DB 를 쓴다**
  - 컬럼 삭제·개명은 **다음 릴리스**로 미룬다 (확장 후 축소)
  - 인덱스는 `CONCURRENTLY`, DDL 앞에는 `lock_timeout`
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | None = ${repr(branch_labels)}
depends_on: str | None = ${repr(depends_on)}


def upgrade() -> None:
    # DDL 하나가 서비스를 멈추지 못하게 한다
    op.execute("SET lock_timeout = '3s'")
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    # **운영 복구 수단으로 쓰지 않는다** — 앞으로 가는 수정이나 백업 복원이다.
    # 못 되돌리는 마이그레이션을 CI 에서 발견하는 용도다
    ${downgrades if downgrades else "pass"}
