# 계정·인증·권한·어드민

> `SERVER.md` 의 하위 문서. 사용자 생명주기부터 어드민 콘솔까지.
>
> 전제 하나: **사용자의 곡은 사적인 창작물이다.** 어드민이 그것을 아무 때나 볼 수
> 있으면 그건 기능이 아니라 사고다. 아래 권한 설계 전체가 이 전제에서 나온다.

## 1. 계정 생명주기

```
        가입
         │
         ▼
  pending_verification ──(이메일 확인)──▶ active
         │                                 │
         │                    (약관 위반)  ├──▶ suspended ──(해제)──▶ active
         │                                 │
         └──(7일 미확인, 자동 삭제)         └──(본인 삭제)──▶ deleted
                                                              │ 30일
                                                              ▼
                                                            purged
```

| 상태 | 로그인 | 편집 | 새 결제 | 비고 |
|---|---|---|---|---|
| `pending_verification` | ✅ | ✅ | ❌ | **편집을 막지 않는다** — 확인 메일 때문에 첫 경험이 끊기면 안 된다 |
| `active` | ✅ | ✅ | ✅ | |
| `suspended` | ✅ | ❌ | ❌ | **로그인은 열어 둔다.** 자기 곡을 내보내 가져갈 수 있어야 한다 |
| `deleted` | ❌ | ❌ | ❌ | 30일 복구 창 |
| `purged` | — | — | — | 되돌릴 수 없다 |

> `suspended` 에서 데이터 반출을 막지 않는 것은 판단이다. 정지는 우리 서비스를
> 못 쓰게 하는 것이지 **사용자의 창작물을 인질로 잡는 것이 아니다.**

## 2. 인증

### 2-1. 비밀번호

- **Argon2id.** `memory=64MiB, iterations=3, parallelism=4` 에서 시작하고,
  로그인 지연이 100ms 를 넘지 않는 선에서 메모리를 올린다
- 파라미터를 **해시 문자열에 담아** 저장한다 (Argon2 인코딩이 이미 그렇다).
  나중에 비용을 올릴 때 **로그인 성공 시점에 재해싱**한다
- 최소 길이 10자. 복잡도 규칙(대문자·특수문자)은 **걸지 않는다** — 실효가 없고
  사용자가 더 나쁜 비밀번호를 만든다. 대신 유출 목록 대조(k-anonymity API)를 본다
- 로그인 실패는 **사용자 존재 여부를 알려주지 않는다.** 같은 메시지, 같은 응답 시간

### 2-2. 토큰

```
액세스 토큰   JWT, 10분,  Authorization 헤더
리프레시 토큰 불투명 난수, 30일, HttpOnly + Secure + SameSite=Lax 쿠키
```

- **액세스만 JWT.** 짧으니 취소를 못 해도 위험 창이 10분이다
- **리프레시는 DB 에 해시로.** 취소가 확실해야 하고, 그건 Redis 로는 보장 못 한다
  (`SERVER_REDIS.md` 1절)
- **회전 + 재사용 감지.** 리프레시할 때마다 새 토큰을 발급하고 옛것을 폐기한다.
  **이미 쓴 토큰이 다시 오면 탈취로 간주하고 그 계정의 모든 세션을 끊는다.**
  `refresh_tokens.rotated_from` 이 그걸 위한 컬럼이다
- 로그아웃은 해당 리프레시만, "모든 기기에서 로그아웃"은 사용자별 전체 폐기

### 2-3. 나중에 붙일 것 — 자리만 만들어 둔다

- **TOTP 2단계 인증**: `user_mfa(user_id, kind, secret_enc, confirmed_at, backup_codes)`
- **OAuth**: `auth_identities` 가 이미 `(provider, subject)` 로 되어 있어 그대로 붙는다
- **매직 링크**: 비밀번호 없는 가입. 스키마 변경 없이 `auth_identities.provider='email'`

## 3. 권한 — 두 축이 있다

**섞으면 반드시 사고가 난다.** 플랫폼 역할과 리소스 역할은 다른 것이다.

```
플랫폼 역할 (users.platform_role)     리소스 역할 (project_members.role)
  user      보통 사용자                  owner    삭제·공유 설정
  support   고객 지원                    editor   편집
  admin     운영                         viewer   보기
  owner     최고 관리자
```

```sql
ALTER TABLE users ADD COLUMN platform_role text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD CONSTRAINT ck_users_platform_role
    CHECK (platform_role IN ('user', 'support', 'admin', 'owner'));
```

### 핵심 규칙: **플랫폼 역할이 리소스 접근을 자동으로 주지 않는다**

`admin` 이라고 해서 남의 프로젝트를 열 수 있으면 안 된다. 접근하려면
**명시적 근거와 기록이 남는 경로**(4절 대리 접속)를 거쳐야 한다.

| 할 수 있는 것 | support | admin | owner |
|---|---|---|---|
| 사용자 검색 (이메일·id) | ✅ | ✅ | ✅ |
| 플랜·사용량 조회 | ✅ | ✅ | ✅ |
| **프로젝트 내용 열람** | ❌ | ❌* | ❌* |
| 사용량 한도 임시 상향 | ✅ (소액) | ✅ | ✅ |
| 환불 처리 | ❌ | ✅ | ✅ |
| 계정 정지·해제 | ❌ | ✅ | ✅ |
| **대리 접속** | ✅ (동의 필요) | ✅ (동의 필요) | ✅ |
| 플랫폼 역할 변경 | ❌ | ❌ | ✅ |
| 감사 로그 열람 | ❌ | ✅ | ✅ |

\* 대리 접속을 통해서만. 직접 조회 API 자체를 만들지 않는다.

## 4. 대리 접속 (impersonation) — 반드시 이 형태로

지원 업무에는 필요하지만, 잘못 만들면 **감시 도구**가 된다.

1. **사용자 동의가 선행한다.** 지원 요청을 열 때 "지원팀이 내 계정을 볼 수 있게
   허용" 체크. 동의 없이 여는 것은 `owner` 만, 그것도 보안 사고 조사에 한정
2. **시간 제한.** 세션 30분, 자동 만료
3. **읽기 전용이 기본.** 쓰기는 별도 승인
4. **화면에 항상 배너.** 지원 담당자 본인도 헷갈리면 안 된다
5. **모든 요청이 감사 로그에 남는다.** `actor_id`(담당자) 와 `on_behalf_of`(사용자)를
   **둘 다** 기록한다 — 하나만 남기면 누가 했는지 또는 누구 것인지 모른다
6. **사용자에게 알린다.** 세션이 끝나면 "지원팀이 N분간 접속했습니다" 메일

```sql
CREATE TABLE impersonation_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id     uuid NOT NULL REFERENCES users(id),
    subject_id      uuid NOT NULL REFERENCES users(id),
    reason          text NOT NULL,              -- 필수. 빈 문자열 금지
    ticket_ref      text,
    consent_id      uuid REFERENCES support_consents(id),
    write_allowed   boolean NOT NULL DEFAULT false,
    started_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    ended_at        timestamptz
);
CREATE INDEX ON impersonation_sessions (subject_id, started_at DESC);

CREATE TABLE support_consents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz
);
```

## 5. 어드민 콘솔 — 무엇을 만드나

**별도 서비스로 만들지 않는다.** 같은 FastAPI 앱의 `/admin` 라우터로 두되:

- 별도 인증 요구 (2단계 인증 필수)
- 별도 레이트 리밋
- **모든 엔드포인트가 감사 로그를 남긴다** — 데코레이터로 강제하고, 안 붙이면
  라우터 등록 시점에 실패시킨다 (잊어버리는 것을 코드가 막게)

| 화면 | 내용 |
|---|---|
| 사용자 | 검색, 상태, 플랜, 가입일, 최근 접속, 정지/해제 |
| 사용량 | 기간별 AI 호출, 저장 용량, 한도 대비 |
| 결제 | 구독 상태, 결제 실패 이력, 환불 |
| 잡 | `ai_jobs` 상태별 목록, 실패 원인, **재시도 버튼** |
| 시스템 | 큐 적체, 워커 하트비트, 에러율 |
| 감사 | 누가 무엇을 했는지. **어드민 자신의 행위도 포함** |

### 지표는 어드민이 직접 SQL 을 치게 두지 않는다

운영 중 실수로 `UPDATE` 를 치는 사고가 실제로 흔하다. 필요한 조회는 화면으로 만들고,
그래도 필요하면 **읽기 전용 복제본에 붙은 별도 계정**으로 준다.

## 6. 감사 로그 — 무엇을 남기나

```
남긴다:  로그인 성공·실패, 비밀번호 변경, 토큰 재사용 감지,
        플랜 변경, 환불, 정지, 대리 접속(모든 요청),
        어드민의 모든 변경 행위, 계정 삭제 요청·수행

남기지 않는다:  프로젝트 편집 내용 (사용자의 창작 활동을 추적하지 않는다)
```

- **보존 1년.** 그 뒤 익명화
- `actor_id` 는 사용자 삭제 시에도 **익명 id 로 치환**해서 남긴다 (`SERVER_DATA.md` 4-2)
- 감사 로그는 **append only.** 수정·삭제 API 를 만들지 않는다

## 7. 남용 대응

| 위협 | 대응 |
|---|---|
| 대량 계정 생성 | IP 레이트 리밋 + 일회용 이메일 도메인 차단 + 이메일 확인 |
| 크리덴셜 스터핑 | 계정+IP 이중 리밋, 실패 시 지연, 유출 비밀번호 대조 |
| 스토리지 남용 | 업로드 URL 발급 리밋 + 계정별 용량 상한 + 미완료 업로드 자동 정리 |
| AI 비용 남용 | **결제 수단 등록 전에는 무료 한도만.** 잡 큐에서 사용자별 동시 실행 1개 |
| 공유 링크 유출 | 링크에 만료·조회수 제한, 필요 시 비밀번호 |

## 8. 개인정보

- **수집을 최소화한다.** 이메일과 표시 이름이면 서비스가 성립한다.
  생년월일·전화번호를 "나중에 쓸지도 모르니" 받지 않는다
- 저장 시 암호화: MFA 시크릿, OAuth 토큰 (`pgcrypto` 또는 앱 레벨 KMS)
- **로그에 PII 를 남기지 않는다.** 이메일은 해시나 사용자 id 로 대체.
  실수로 남는 것을 막으려면 로거에 필터를 건다
- 데이터 반출(export): 사용자가 자기 데이터 전부를 받을 수 있어야 한다 —
  프로젝트 JSON + 에셋 목록. **이미 파일 저장 기능이 있으므로 거의 공짜다**
