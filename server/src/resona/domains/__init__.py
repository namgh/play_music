"""도메인 묶음.

**이 모듈 하나를 임포트하면 모든 테이블이 `metadata` 에 등록된다.** 알렘빅과
테스트가 그것에 기댄다 — 도메인을 추가하고 여기에 안 적으면, 그 테이블은
마이그레이션 자동 생성에서 **조용히 빠진다.**

도메인끼리는 서로의 `models`·`repository` 를 임포트하지 않는다. 외래키는 테이블
이름 문자열로 걸리므로 파일이 갈라져도 참조는 유지된다.
"""

from resona.domains.accounts import models as accounts_models  # noqa: F401
from resona.domains.assets import models as assets_models  # noqa: F401
from resona.domains.billing import models as billing_models  # noqa: F401
from resona.domains.jobs import models as jobs_models  # noqa: F401
from resona.domains.ops import models as ops_models  # noqa: F401
from resona.domains.payments import models as payments_models  # noqa: F401
from resona.domains.projects import models as projects_models  # noqa: F401
from resona.domains.workspaces import models as workspaces_models  # noqa: F401
