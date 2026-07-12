# Goal 실행 비용·성과 리포트 계약

> 상태: API 및 집계 계약 확정 (2026-07-12)

## 범위와 원칙

리포트는 goal에 속한 영속 실행 기록을 읽기 전용으로 집계한다. 가격표로 비용을 추정하거나, provider가 보고하지 않은 token·cost를 `0`으로 바꾸지 않는다. 모든 시각은 DB의 UTC 시각을 ISO 8601 문자열로 직렬화한다.

집계 대상은 해당 goal의 `goal_execution_runs` 전체이다. run에 연결된 `tasks.execution_run_id` 및 `sessions.execution_run_id`를 우선하고, run 도입 전 legacy row만 `goal_id` 연결로 보완한다. 다른 goal이나 project의 기록은 합치지 않는다.

## HTTP 계약

- `GET /projects/:projectId/goal-reports` → `{ reports: ReportSummary[] }`
- `GET /goals/:goalId/execution-report` → `ReportDetail`

서버의 공통 mount prefix를 포함한 실제 URL은 각각 `/api/projects/:projectId/goal-reports`, `/api/goals/:goalId/execution-report`이다. 프로젝트 목록은 goal당 항목 하나를 반환하며 기본 순서는 `startedAt DESC NULLS LAST`, 동률이면 `goalId ASC`이다. 없는 project·goal은 `404`를 반환한다.

공유 TypeScript 계약은 `shared/types.ts`의 `ReportSummary`, `ReportDetail`, `ProjectGoalReportsResponse`를 단일 소스로 사용한다. `ReportSummary` 형태는 다음과 같다.

```ts
interface ReportSummary {
  goalId: string;
  title: string;
  finalStatus: "running" | "completed" | "failed" | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  providers: Array<{
    provider: "claude" | "codex";
    sessionCount: number;
    tokens: number | null;
    costUsd: number | null;
  }>;
  retryCount: number;
  failoverCount: number;
  evaluationCount: number;
  fixRoundCount: number;
  finalVerdict: "pass" | "conditional" | "fail" | null;
  telemetry: "complete" | "partial" | "none";
}
```

`ReportDetail`은 `ReportSummary` 전체에 아래를 더한다.

```ts
{
  agentRoles: string[];
  history: Array<{
    kind: "failure" | "retry" | "failover" | "evaluation" | "fix";
    occurredAt: string;
    taskId: string | null;
    summary: string;
  }>;
}
```

`providers`는 실제 session row가 있는 provider만 포함하며 `provider ASC` 순으로 고정한다. `agentRoles`는 실제 참여 근거가 있는 `sessions.agent_id`와 시작된 fix round의 `assignee_id`에서만 role을 읽어 중복 제거한 뒤 문자열 오름차순으로 반환한다. 재할당 전 값을 잃은 `tasks.assignee_id`는 과거 참여자 근거로 쓰지 않는다. 근거가 없으면 빈 배열이다. `history`는 `occurredAt ASC`, 동률이면 kind·영속 ID 순으로 고정해 재조회 시 순서가 흔들리지 않게 한다.

Dashboard의 provider 정렬은 각 goal의 고정된 `providers[].provider`를 `+`로 연결한 구성 문자열을 내림차순으로 비교하며, provider 기록이 없는 goal은 마지막에 둔다.

## 시간 경계와 최종 상태

- `startedAt`: 해당 goal의 run `started_at` 최솟값. run이 없으면 `null`.
- `endedAt`: active run이 하나라도 있으면 `null`. 모든 run이 종료됐으면 non-null `ended_at` 최댓값. 종료 run의 `ended_at`이 누락된 경우도 `null`.
- `durationMs`: `startedAt`과 `endedAt`이 모두 있을 때만 `max(0, endedAt - startedAt)`. 실행 중이거나 경계가 불완전하면 `null`. 조회 시각까지의 경과 시간을 임의 계산하지 않는다.
- `finalStatus`: active run이 있으면 `running`; 없고 최신 run이 `completed`면 `completed`, `failed`면 `failed`. 최신 run은 `ORDER BY started_at DESC, id DESC` 전체 순서로 선택한다. `started_at`이 같은 run은 영속 `PRIMARY KEY`인 `id DESC`로 결정적으로 tie-break하며, 목록과 상세 집계가 반드시 이 공통 순서를 사용한다. terminal run status가 session status보다 항상 우선한다. 정상 orchestration cleanup도 session을 `killed`로 저장하므로 `sessions.status = 'killed'`만으로 `interrupted`를 판정하지 않는다. 실행 기록은 있지만 terminal run status가 없는 legacy 종결 기록만 `interrupted`이며 telemetry는 `partial`이다.
- 실행 run과 legacy task/session/verification/fix 기록이 모두 없는 goal은 계약에 `not_started`가 없으므로 `interrupted`를 사용하되, `telemetry: "none"`을 함께 반환한다. UI는 이 조합을 반드시 “기록 없음”으로 표시하고 “중단”으로 표시하지 않는다. run은 없지만 legacy 실행 기록이 있는 goal은 `interrupted`/`partial`이다.

## 지표 산식과 중복 제거

### Provider session·token·cost

`sessionCount`는 provider별 `COUNT(DISTINCT sessions.id)`이다. task와 session 양쪽의 failover trace는 session 수에 추가하지 않는다.

`tokens`와 `costUsd`는 해당 provider의 session 중 그 지표를 보고한 row만 합산한다. 하나라도 미보고 row가 섞이면 부분합을 전체로 오인하지 않도록 provider 합계를 `null`로 두고 telemetry를 `partial`로 낮춘다. 실제로 보고된 0은 `0`이다.

현재 SQLite의 `sessions.token_usage`/`cost_usd` legacy default가 `0`이므로 저장값 0만으로는 “보고된 0”과 “미보고”를 구분할 수 없다. 집계기는 parser/provider 능력과 기록 근거를 함께 사용해야 한다. Codex의 cost는 현재 항상 `null`이고 가격표로 추정하지 않는다. 보고 여부를 입증할 수 없는 legacy 0도 `null`이다. 구현 단계에서 신규 상태 필드를 추가하기 전까지 0을 보고됨으로 간주하면 안 된다.

또한 현재 write path는 session별 usage를 완전하게 저장하지 않는다. 정상 implementation의 cost는 task에만 누적될 수 있고, fix usage는 token·cost 모두 task에만 누적되며, evaluator usage는 session에 영속되지 않는다. `tasks.token_usage`/`cost_usd`는 여러 provider의 누적값을 섞을 수 있으므로 provider별 합계 근거로 사용하지 않는다. implementation·fix·evaluation 모든 실행의 usage가 실제 사용한 provider의 정확한 `sessions.id`에 영속되기 전까지, 누락 가능성이 있는 provider metric은 부분합을 반환하지 않고 `null`/`partial`로 낮춘다.

### Retry

`retryCount`는 scheduler가 blocked task를 다시 실행 가능 상태로 전환한 횟수다. same-agent `blocked → todo` retry와 다른 agent로의 reassign `blocked → todo`를 각각 1회로 포함한다. provider failover의 즉시 redispatch, evaluator JSON parse 재요청, 서버 재시작 recovery resume는 포함하지 않는다. failover는 `failoverCount`, parse retry는 하나의 evaluation attempt, recovery는 history의 failure/재개 맥락으로 분리한다.

집계는 run task의 append-only retry/reassign 전환 사건을 task·attempt별로 중복 제거해 합산한다. `tasks.retry_count`는 재할당 때 0으로 reset되고, circuit breaker는 실제 시도 없이 retry/reassign counter를 budget 최댓값으로 설정하며, 대체 agent가 없을 때도 실제 재할당 없이 `reassign_count`가 증가한다. 따라서 두 counter는 단순 `SUM` 하거나 어떤 공식으로도 실제 retry 횟수로 환산하지 않는다.

영속 retry 사건이 없는 legacy/current 실행은 계약의 non-null 숫자 필드에 `retryCount: 0`을 두되 `telemetry: "partial"`로 반환한다. 이 0은 “재시도 없음”이 아니라 “확정된 사건 0건”이다. 현 계약은 지표별 완전성 flag가 없으므로 UI는 `telemetry: "partial"` 이면 `retryCount: 0`을 보수적으로 “미보고”로 표시한다. partial 이유가 다른 지표뿐이더라도 실제 0으로 단정하는 것보다 보수적인 표시를 우선한다. 신규 append-only 사건이 있는 기간의 횟수만 반환하는 혼합 기록도 partial이다.

### Failover

`failoverCount`는 `provider_failover_redispatched = 1`인 실제 재디스패치만 세며, loop guard에 막힌 제안이나 cooldown만 걸린 실패는 세지 않는다. 사건 키는 우선순위대로 다음과 같다.

1. `(originalSessionId, redispatchedSessionId)` 쌍
2. redispatch session이 아직 backfill되지 않았으면 `(taskId, originalSessionId, fromProvider, toProvider)`

같은 trace가 `tasks`와 원본/재디스패치 `sessions`에 복제되어도 이 키로 한 번만 세며, history에도 하나만 넣는다. backfill 전후를 다른 사건으로 중복 계산하지 않도록 우선 task trace에 있는 완성된 쌍으로 병합한다.

### Quality Gate evaluation·fix round

- `evaluationCount`: run task에 연결된 `COUNT(DISTINCT verifications.id)`. evaluator 내부 JSON parse 재요청은 별도 verification row를 만들지 않으므로 중복하지 않는다.
- `fixRoundCount`: `COUNT(DISTINCT verification_fix_rounds.id)`. `source_verification_id` UNIQUE라는 DB 제약을 또 하나의 중복 방지 근거로 삼는다. `pending`, `running`, `completed`, `failed` 라운드를 모두 “시작된 수정 라운드”로 세되, legacy placeholder로 `started_at` 및 session 근거가 모두 없는 `pending`은 제외한다.
- `finalVerdict`: 최신 goal-level QA/regression task의 최신 verification verdict를 우선한다. 그 기록이 없으면 전체 run task의 최신 verification을 `created_at DESC, id DESC`로 선택한다. verification이 없으면 `null`.

## Telemetry 완전성과 빈 기록

- `none`: run, 연결 task/session, verification, fix round가 모두 없다. 카운터 필드는 계약상 `0`이지만 UI는 개별 0 지표 대신 “기록 없음”을 보여준다.
- `partial`: 어떤 실행 기록이든 있지만 종료 시각, provider, token/cost 보고 여부, retry 사건 중 하나라도 확정할 수 없다. provider 사용량의 미보고 `null`은 이 상태를 유발한다.
- `complete`: 실행 경계와 상태, 모든 session provider, provider별 token/cost 보고 여부, retry/failover/evaluation/fix 사건을 모두 확정할 수 있다. 실행 중 run은 `endedAt: null`이 정상이므로 그 자체만으로 partial은 아니다.

`null`은 오직 미보고·미확정을 뜻한다. 사용량이 정상적으로 보고된 실행의 합계 0은 `0`으로 반환한다. 추정값은 계약 밖이다.

## History 구성

- `failure`: verification과 독립적인 failed session과 종결 failure activity. 정상 cleanup으로 남은 killed session은 제외하고, 비정상 중단을 입증하는 recovery/failure 기록이 함께 있는 killed session만 포함한다. fail verification은 `failure`로 복제하지 않고 아래 `evaluation` 한 건의 summary에 verdict를 담는다.
- `retry`: 영속 scheduler retry 사건.
- `failover`: 위 failover 사건 키로 중복 제거된 실제 redispatch.
- `evaluation`: verification row 하나당 하나. pass·conditional·fail 모두 이 kind로만 표현한다.
- `fix`: 실제로 시작된 fix-round row 하나당 하나.

`summary`는 저장된 사유·판정·상태를 요약하는 표시용 문자열이다. provider stderr나 프롬프트 전문을 노출하지 않고, 빈 문자열을 반환하지 않는다.

## 현재 저장 계약의 제약

정확한 retry 사건, usage 보고 여부, 모든 실행 usage의 session 귀속은 현재 저장 계약으로 완전히 입증할 수 없다. 따라서 API 집계기 구현 시 다음을 먼저 영속화해야 `complete`를 정직하게 반환할 수 있다.

- append-only retry event(예: `task_execution_attempts` 또는 구조화 activity metadata)
- session 지표별 reported flag 또는 nullable usage 컬럼
- implementation·fix·evaluation usage를 발생시킨 정확한 `sessions.id`에 적재하는 write path

그 전까지 legacy/current row는 확정 가능한 값만 반환하고 `partial`로 낮추는 것이 “0으로 추정하지 않는다”는 범위 계약에 부합한다.
