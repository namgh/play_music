# 과금 — 구독·미터링·웹훅

> `SERVER.md` 의 하위 문서.
>
> `plan.md` 6 이 정한 것: **DAW(①②)는 무료, AI(③)만 유료.** 근거는 비용 구조와
> 과금 지점을 일치시키는 것 — 편집은 클라이언트 연산이라 서버 비용이 거의 없고,
> 실제 비용은 AI 추론에서 난다.

## 1. 플랜

| | Free | Pro |
|---|---|---|
| DAW 전체 기능 | ✅ | ✅ |
| **음질** | ✅ **동일** | ✅ 동일 |
| 저장 프로젝트 | 5개 | 무제한 |
| AI 생성 | 월 N회 체험 | 월 M회 |
| 컨텍스트 기억 | 세션 1회성 | 누적·진화 |
| **상업적 이용** | ❌ | ✅ |
| 협업 인원 | 1 | 팀 |

> **음질을 플랜으로 나누지 않는다** (`plan.md` 6). 편집 중 소리를 깎으면 체험이
> 망가지고 바이럴도 죽는다. 무료로 만든 곡도 끝까지 좋은 소리로 나간다.

## 2. 구독 상태 기계

결제사(Stripe 등)의 상태를 그대로 쓰지 않고 **우리 상태로 정규화**한다.
결제사를 바꿀 때 이 매핑만 다시 쓰면 되기 때문이다.

```
none ──(결제)──▶ active ──(갱신 실패)──▶ past_due ──(유예 만료)──▶ canceled
                   │  ▲                      │                        │
                   │  └──(결제 성공)─────────┘                        │
                   └──(사용자 해지)──▶ canceling ──(기간 종료)────────┘
```

| 상태 | AI | 상업 이용 | 설명 |
|---|---|---|---|
| `active` | ✅ | ✅ | |
| `canceling` | ✅ | ✅ | 해지 예약. **기간 끝까지 다 쓴다** |
| `past_due` | ✅ (유예 7일) | ✅ | 카드 문제일 수 있다. 바로 끊지 않는다 |
| `canceled` | ❌ | ❌ (아래 3절) | 무료로 돌아간다 |

**`past_due` 에서 즉시 차단하지 않는 이유:** 카드 만료는 사용자 잘못이 아니고,
작업 중이던 곡이 갑자기 막히는 경험이 해지보다 나쁘다. 대신 화면에 계속 알린다.

## 3. 상업적 이용권 — 시점을 고정한다

**유료 차별화 지점**(`plan.md` 6)이라 정확해야 한다. 핵심 판단:

> **곡을 만들고 내보낸 시점에 유료였다면, 나중에 해지해도 그 곡의 상업 이용권은
> 유지된다.**

해지했다고 이미 발표한 곡의 권리를 회수하는 것은 말이 안 되고, 그런 서비스는
쓸 수 없다. 그래서 **권리를 내보내기마다 스냅샷**으로 남긴다.

```sql
ALTER TABLE project_exports
    ADD COLUMN license text NOT NULL DEFAULT 'personal';  -- 'personal' | 'commercial'
ALTER TABLE project_exports
    ADD COLUMN license_snapshot jsonb;  -- 발급 시점의 플랜·구독 id·시각
```

- 내보내기 요청 시 그 순간의 엔타이틀먼트를 읽어 **함께 기록**한다
- 사용자는 나중에도 "이 파일은 상업 이용 가능"을 증명할 수 있다
- 반대로 무료로 내보낸 파일을 나중에 상업 이용하려면 **다시 내보내면 된다**
  (렌더는 클라이언트가 하므로 우리 비용이 0이다 — 이 구조가 여기서 이득을 준다)

## 4. 미터링 — 원장에서 시작한다

`SERVER.md` 가 정한 대로 `usage_events` 는 **추가만 되는 원장**이다.
카운터를 `UPDATE` 로 올리면 프로세스끼리 경쟁하고, 무엇보다 **분쟁이 생겼을 때
근거가 없다.**

### 4-1. 언제 기록하나

**작업이 성공했을 때만.** AI 생성이 실패하면 사용자에게 청구하지 않는다.

```
ai_jobs: queued → running → succeeded
                                └─ 같은 트랜잭션에서 usage_events 삽입
```

같은 트랜잭션이라는 것이 중요하다. 나눠 놓으면 "생성은 됐는데 카운트가 안 된"
경우나 그 반대가 생기고, 둘 다 나중에 찾기 어렵다.

### 4-2. 한도는 어떻게 검사하나

매 요청마다 원장 전체를 세면 느려진다. **롤업 + 최근분**으로 본다.

```sql
-- scheduler 가 시간마다 갱신
CREATE TABLE usage_rollups (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        text NOT NULL,
    period      daterange NOT NULL,     -- 청구 주기
    quantity    int NOT NULL,
    rolled_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, period)
);
```

```
사용량 = 롤업(느리지만 정확) + 롤업 이후의 원장(작다)
```

그리고 이 값을 Redis 에 **60초 캐시**한다 (`SERVER_REDIS.md` 4절).
경계에서 몇 건 더 나가는 것은 허용한다 — 정확히 막으려고 매번 DB 를 치는 비용이
초과분보다 크다. **단 결제 금액에 직접 연결되는 종량 과금을 도입하면 이 판단을
다시 해야 한다.**

### 4-3. 잡 제출 시 한도 검사도 원자적으로

```sql
-- 무료 한도와 같은 방식 (SERVER.md 5절). 동시 요청 두 개가 같이 통과하면 안 된다
PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
-- 사용량 확인 → 초과면 예외 → 아니면 ai_jobs INSERT
```

## 5. 웹훅 — 순서를 믿지 않는다

결제사 웹훅은 **중복해서 오고, 순서가 뒤바뀌고, 늦게 온다.** 세 가지를 전부 전제한다.

```python
# 1) 서명을 먼저 검증한다. 실패하면 400 이 아니라 그냥 버린다(로그만)
# 2) event.id 로 멱등 처리 — 이미 처리했으면 200 만 반환
# 3) 순서를 믿지 않는다: 이벤트의 타임스탬프가 우리가 마지막으로 반영한 것보다
#    오래됐으면 **무시**한다
```

```sql
CREATE TABLE billing_events (
    id              text PRIMARY KEY,           -- 결제사의 event id
    type            text NOT NULL,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL,       -- 결제사 기준 시각
    received_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    error           text
);

ALTER TABLE subscriptions
    ADD COLUMN last_event_at timestamptz;       -- 이보다 오래된 이벤트는 무시
```

- **웹훅 핸들러는 빨리 200 을 준다.** 무거운 처리는 잡으로 넘긴다 —
  결제사는 응답이 느리면 재시도하고, 그러면 중복이 더 늘어난다
- **웹훅만 믿지 않는다.** `scheduler` 가 하루 한 번 구독 상태를 결제사와 대조한다
  (reconciliation). 웹훅 유실은 반드시 일어난다
- 결제사 API 호출은 **멱등 키**를 붙인다. 재시도로 이중 청구가 나면 최악이다

## 6. 환불·분쟁

| 사건 | 처리 |
|---|---|
| 사용자 요청 환불 | 어드민이 처리, 사유 필수, 감사 로그 |
| 카드사 분쟁(chargeback) | 구독 즉시 `canceled`, 계정은 `suspended` 검토 |
| 중복 청구 | 즉시 환불. **먼저 사과하고 나중에 원인 조사** |

**이미 내보낸 파일의 상업 이용권은 환불해도 회수하지 않는다** (3절과 같은 이유).
악용이 걱정되면 그건 요금이 아니라 **약관과 계정 정지**로 다룰 문제다.

## 7. 가격을 코드에 박지 않는다

```sql
CREATE TABLE plans (
    code            text PRIMARY KEY,           -- 'free' | 'pro'
    display_name    text NOT NULL,
    limits          jsonb NOT NULL,             -- {"projects": 5, "ai_monthly": 20, ...}
    active          boolean NOT NULL DEFAULT true
);
```

- 한도를 **데이터로** 둔다. 캠페인·기업 플랜·개별 상향이 코드 배포 없이 된다
- **기존 가입자의 한도를 소급해 낮추지 않는다.** `subscriptions` 에 가입 시점의
  플랜 코드를 남기고, 플랜 정의를 바꿀 때는 새 코드를 만든다 (`pro_v2`)
- 가격 자체는 결제사에 두고 우리는 참조만 한다 (세금·통화 처리를 떠넘긴다)

## 8. 지금 정하지 않는 것

| 항목 | 왜 미루나 |
|---|---|
| 종량 과금 | 정액 한도로 시작한다. 종량은 미터링 정확도 요구가 급격히 올라간다 |
| 연간 결제·프로레이션 | 결제사가 계산하게 둔다. 우리가 계산하면 반드시 틀린다 |
| 세금·인보이스 | 결제사 기능 사용 |
| 팀·좌석 과금 | 협업 자체가 MVP 밖 (`plan.md` 6-1) |
