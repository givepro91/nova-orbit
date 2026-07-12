# Agent handoff contract

Agent 실행 단계는 대화 세션을 이어받지 않고 SQLite에 저장된 `AgentHandoff`를 경계로 연결한다. 현재 계약 버전은 `1`이며 `decompose`, `implementation`, `verification`, `fix`가 동일한 구조를 생산한다.

```ts
interface AgentHandoff {
  version: 1;
  stage: "decompose" | "implementation" | "verification" | "fix";
  changed_files: string[];
  decisions: string[];
  unresolved_risks: string[];
  reproduction_commands: string[];
}
```

모든 배열은 필수다. 생산 단계에서는 누락 배열을 `[]`로 정규화하지만, 저장·소비 단계에서는 누락, 비문자열 원소, 빈 문자열, 버전·단계 불일치를 오류로 처리한다.

## 생산·소비 경계

| 실행 단계 | 소비하는 직전 handoff | 생산 handoff |
| --- | --- | --- |
| goal 분해 | 없음 | `decompose` (goal 범위) |
| 구현·provider 재디스패치 | 해당 goal의 `decompose` | `implementation` (task 범위) |
| 최초 검증·provider 재디스패치 | 해당 task의 최신 `implementation` | `verification` |
| fix·provider 재디스패치 | 해당 task의 최신 `verification` | `fix` |
| fix 후 재검증·provider 재디스패치 | 해당 task의 최신 `fix` | `verification` |

소비자는 `agent_handoffs.id DESC`의 첫 행만 authoritative하게 검사한다. 더 최신인 손상 행을 건너뛰고 오래된 정상 행으로 fallback하지 않는다. 따라서 fix 후 재검증이 이전 implementation 결과를 보거나, provider failover가 실패 전보다 오래된 맥락을 받는 일이 없다.

구조화 handoff를 소비하는 implementation, verification, fix 세션은 provider conversation을 resume하지 않고 항상 fresh session으로 시작한다. 공통 소환 컨텍스트에서도 `sessions.last_output`을 제외해 이전 세션의 비구조화 출력이 system prompt로 우회 주입되지 않게 한다.

failover는 실패한 실제 session의 agent를 기준으로 sessionKey를 복원한다. 구현·fix 실패는 task assignee key, Quality Gate 실패는 `evaluator-${taskId}` key에 provider override를 건다. 서버 재시작 뒤에도 원본 session의 agent를 조회해 같은 key를 복원한다.

검증은 subprocess spawn 전에 수행한다. 실패하면 provider 프로세스를 만들지 않고 `sessions.status = 'failed'`, `tasks.status = 'blocked'`, `activities.type = 'handoff_validation_failed'`를 같은 트랜잭션에 기록한다. 필드별 진단은 failed session의 `last_output`과 activity `metadata`에 JSON으로 남긴다.

Quality Gate 프롬프트는 handoff의 `changed_files`를 독립 점검 대상, `reproduction_commands`를 실행·검증 대상으로 명시한다. worktree의 git diff는 보조 증거로 유지하되 구현 세션의 비구조화 대화는 검증 입력으로 사용하지 않는다.
