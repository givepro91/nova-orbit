# Goal-as-Unit 아키텍처 전환

작성일: 2026-04-21
상태: 구현 완료 · 운영 계약 (2026-07-11 현재)
근거 사례: drift 기능 Full Auto 구현 실패 (false-positive 1,000건+, git log 파편화)

---

## Context

### 현재 구조 (Task-per-worktree)

`engine.ts executeTask()` 기준:

1. 태스크 실행 시작 → `createWorktree(workdir, agentName, task.title)` 호출
   - 브랜치명: `agent/{agentSlug}/{taskSlug}-{uid}`
   - 경로: `{workdir}/.crewdeck-worktrees/{agentSlug}-{taskSlug}-{uid}/`
2. 에이전트가 해당 worktree에서 구현 실행
3. Quality Gate 검증 통과 → `runGitWorkflow()` 호출 → `commitTaskResult()` → worktree 브랜치에 commit
4. commit 완료 후 `mergeBranchSequential(worktreeBranch → main)` — 태스크마다 main에 1 commit
5. `removeWorktree()` — worktree 및 브랜치 삭제

```
Goal
 └── Task A → worktree-A (commit) → merge→main → 삭제
 └── Task B → worktree-B (commit) → merge→main → 삭제
 └── Task C → worktree-C (commit) → merge→main → 삭제
```

**결과**: Goal 당 태스크 수만큼 커밋이 main에 쌓임. 태스크 간 코드 공유 없음.

### 변경 동기 (drift 사례 재현)

- drift 감지 태스크가 10개로 분해됨 → main에 10 commit
- 각 태스크가 독립 worktree에서 실행되므로 이전 태스크의 실제 파일 변경을 모름
- 검증 스크립트(`drift-audit.ts`) 부재 → 엉뚱한 파일도 "완료" 처리
- false-positive 1,000건+ 발생: 태스크 단위 검증이 실데이터 audit을 통과하지 못함

---

## Problem (MECE 분해)

### P1. 단위 문제 — 태스크가 배포 단위로 승격됨

- 현재: 태스크 완료 = 즉시 commit = 즉시 main 반영
- 영향: Goal 미완성 상태가 main에 지속 노출. 다음 태스크가 이전 commit을 바탕으로 실행되지만 **코드 컨텍스트**는 공유되지 않음 (각 태스크의 worktree는 main 기준 체크아웃)

### P2. 검증 문제 — 실데이터 audit이 DoD에 없음

- 현재: Quality Gate = 5-dimension 정적 검증 (코드 읽기 기반)
- 영향: `drift-audit.ts` 같은 런타임 검증이 없으면 "기능이 동작하는가"를 확인 불가
- Goal 또는 Task 수준에서 acceptance script 실행 지점이 없음

### P3. 관찰 문제 — Goal 단위 진행 가시성 부족

- 현재: 대시보드에 태스크 단위 git event만 표시됨 (`task:git` broadcast)
- 영향: "이 Goal이 main에 어떤 1개의 커밋으로 귀결되는가"가 보이지 않음
- PR 모드에서는 태스크 수만큼 PR이 생성되는 구조적 문제 존재

---

## Solution

### 현행 스케줄링 계약

> 이 절이 현행 구현의 규범 계약이다. 아래 §§1–5는 Goal-as-Unit 전환 배경과 구현 의사결정을 보존한다.

#### 병렬성 단위와 환경변수

- 프로젝트 실행 동시성의 단위는 agent나 task가 아니라 **활성 goal slot**이다.
- 기본 상한은 goal 2개다. `CREWDECK_MAX_CONCURRENCY` 환경변수로 override하며, `server/utils/constants.ts`에서 기본값 `2`를 해석한다.
- rate limit 발생 시 scheduler의 AIMD가 해당 프로젝트의 효과 동시성을 임시로 낮추고, 성공/쿨다운 후 설정 상한까지 복구한다. 대시보드의 `maxConcurrency`는 이 효과값이다.
- goal 간은 각자의 worktree가 격리되므로 slot 상한까지 병렬 실행한다. goal 내부는 공유 worktree·체크포인트·선행 맥락을 보호하기 위해 **항상 태스크 1개만 live**다.
- 동일 task assignee도 한 번에 live execution lane 1개만 소유한다. 수동 실행과 scheduler 실행은 같은 DB claim 경계를 사용한다.

#### Lookahead 1

- spec/decompose 준비 lane은 실행 lane과 별도이며, 프로젝트당 동시에 하나의 `goalPreparationFlight`만 소유한다.
- task 상태를 진실원으로 활성 goal을 계산하고, `activeGoalCount < effectiveConcurrency + 1`일 때만 다음 미분해 goal 하나를 우선순위 순으로 spec → decompose한다. 즉 실행 slot 밖에 최대 1개 goal만 선행 준비한다.
- 큐를 명시적으로 정지하면 이미 실행 중인 session은 강제 종료하지 않지만, 새 spec/decompose, decompose retry, full-autopilot 재시작, 새 task dispatch는 시작하지 않는다.

#### Claim 소유권과 lane 상태

`claimTaskForExecution()`이 transaction 안에서 유일한 실행 소유권을 획득한다.

1. 후보 task가 `todo` 또는 `pending_approval`인지 확인한다.
2. 같은 goal의 다른 `in_progress`/`in_review` task, 같은 agent의 다른 live task, 그리고 최근 5초 내 반납된 claim settle lease가 없을 때만 CAS로 `in_progress`를 기록한다.
3. scheduler는 claim 성공 후에만 비동기 실행을 시작한다. 수동 API는 성공 시 `202 { status: "started", taskId }`, 충돌 시 현재 DB 상태를 포함한 `409`를 반환한다.

스케줄링에서 lane을 점유하는 상태는 다음과 같다.

| 상태 | 스케줄링 의미 |
|------|-----------------|
| `todo` | 실행 후보. 단, 최근 claim이 반납된 task는 `started_at` 기준 5초 settle 기간 동안 goal lane을 보유한다. |
| `pending_approval` | 수동 승인 전에는 scheduler 후보가 아니다. goal/full autopilot 큐 시작 시 `todo`로 자동 승인할 수 있다. |
| `in_progress` | Generator/아키텍트/실행 단계가 goal lane을 점유한다. 미종결 child를 기다리는 delegation parent는 live session이 없으므로 점유 계산에서 제외한다. |
| `in_review` | 독립 Evaluator 검증 중이며 같은 goal lane을 계속 점유한다. |
| `blocked` | 재시도 가능하면 쿨다운 동안 그 goal slot을 예약한다. retry/reassign 두 한도가 모두 소진되면 영구 차단으로 취급하여 신규 slot을 점유하지 않는다. |
| `done` | terminal. lane을 반납하고 다음 태스크나 goal squash 단계를 진행한다. |

실행 후보 정렬은 goal `priority` → `sort_order` → `created_at`이다. 각 goal 안에서는 실행 가능한 첫 task 하나만 선택한다. 상위 goal이 dependency 또는 reviewer gate에 막히면 slot을 노는 대신 다음 goal을 검색한다. retry/failover는 신규 sibling보다 먼저 같은 task를 재claim한다.

Goal-as-Unit의 integration 상태는 task lane과 별개다.

| `squash_status` | 의미 |
|-----------------|------|
| `none` | task 실행 중 또는 squash 미시작. |
| `triggering` | 마지막 task 완료 후 squash 준비 CAS를 획득한 임시 상태. |
| `pending_approval` | acceptance/QA/squash 준비가 끝나 사용자 반영 승인을 기다림. |
| `approved` | 승인됐고 integration을 진행 중임. |
| `resolving` | 병렬 goal과의 변경 겹침을 별도 해결 session이 처리 중임. |
| `merged` | terminal. squash 반영과 worktree 정리가 완료됨. |
| `blocked` | acceptance, worktree, 충돌 해결 또는 integration 실패로 사람 개입/재시도가 필요함. |

#### Generator–Evaluator 분리

- Generator의 구현 session과 Evaluator session은 다른 session ID여야 한다. Quality Gate는 구현 assignee를 reviewer 후보에서 제외하고, 필요하면 전용 `[Crewdeck] Evaluator` agent를 사용한다.
- session 재사용이 감지되면 검증은 통과할 수 없고 분리 계약 실패를 기록한다.
- task는 검증 동안 `in_review`를 유지하므로 Evaluator가 완료되기 전에 같은 goal의 다음 Generator가 시작할 수 없다. FAIL 시 fix → 재검증도 같은 goal lane에서 순차 수행한다.

#### 실패·재시작·취소 정리

**실패 및 재디스패치**

- Goal-as-Unit task 시작 전 stash checkpoint를 만든다. PASS/conditional이면 checkpoint를 drop한다. 검증 FAIL이 최종 QA로 이월되는 경로는 checkpoint를 drop하고 현재 변경을 유지한다. 실행 예외는 task를 `blocked` 또는 `todo`로 전이하지만 `restoreCheckpoint()`/`saveDiscardedDiff()`를 호출하지 않으므로 재시도는 현재 worktree 상태에서 계속한다. 태스크 단위 실패 rollback 보장은 아직 Known Gap이다.
- 복구 가능한 실패는 `blocked` + 쿨다운 → 같은 task의 `todo` 승격 → atomic re-claim 순으로 처리한다. retry/reassign 소진 전까지 해당 goal slot은 다른 goal에 빼앗기지 않는다.
- provider failover가 허용된 실패는 같은 task를 대체 backend으로 우선 재디스패치한다. task에 시도 provider·원본 session·재디스패치 session을 연결하고, 재시작 후에도 영속 트레이스로 왕복 루프를 차단한다.

**서버 재시작**

- scheduler·HTTP route를 열기 전 `recoverOnStartup()`이 한 번 실행된다. 기존 `in_progress`/`in_review` task는 한 SQL update로 `todo`로 복구하고, 전 프로세스의 active session/process는 `killed`로 정리한 후 agent를 `idle`로 초기화한다. 복구 완료 전에는 새 dispatch가 없다.
- `generating` spec은 `failed`로 바꾸어 재시도/오류 표시가 가능하게 하고, `triggering` squash는 `none`, `resolving` squash는 `blocked`로 복구한다.
- `merged`가 아닌 goal의 활성 worktree는 보존하고 나머지 stale worktree와 `crewdeck-checkpoint-*` stash를 정리한다. `pending_approval`은 worktree가 있으면 `goal:squash_ready`를 재방송하고, 없으면 `blocked`로 전환한다.

**Goal 취소(삭제)**

- `DELETE /goals/:id`가 DB transaction 안에서 goal을 삭제하고 task/verification을 cascade 정리한다. side effect에 필요한 task ID·session 소유자·worktree 메타데이터는 삭제 전 캡처한다.
- commit 후 task 실행 session, `spec-*`, `decompose-*`, `architect-*`, `evaluator-*`를 종료한다. scheduler의 preparation flight, decompose retry, task claim, failover/backfill timer·trace 소유권도 해제하여 삭제된 goal이 재디스패치되지 않게 한다. 단, 병렬 squash 충돌 해결에 쓰는 `squash-resolve:${goalId}` session은 현재 DELETE 경로가 종료하지 않는 Known Gap이다.
- task checkpoint를 먼저 drop한 뒤 goal worktree·branch를 best-effort로 제거하고 `project:updated`를 broadcast한다. Git 정리 실패는 삭제 transaction을 롤백하지 않고 경고 로그로 남긴다.

### 1. Goal-per-worktree

**핵심 원칙**: Worktree의 수명 = Goal의 수명. 태스크는 그 안에서 실행되는 세부 작업.

#### 1.1 Worktree 생성 시점 변경

| 현재 | 변경 후 |
|------|---------|
| `executeTask()` 내부에서 태스크마다 생성 | Goal 실행 시작 시 1회 생성 |
| 브랜치: `agent/{slug}/{taskSlug}-{uid}` | 브랜치: `goal/{goalSlug}-{uid}` |
| 태스크 완료 시 삭제 | Goal 완료(squash 후) 시 삭제 |

**변경 대상 파일**:

- `/Users/keunsik/develop/swk/crewdeck/server/core/project/worktree.ts`
  - `createWorktree(projectWorkdir, agentName, taskSlug)` 시그니처를 `createGoalWorktree(projectWorkdir, goalSlug)` 로 추가
  - 브랜치 패턴: `goal/{goalSlug}-{uid}`
  - 경로 패턴: `{workdir}/.crewdeck-worktrees/goal-{goalSlug}-{uid}/`
  - 기존 `createWorktree` 는 삭제하지 않고 Goal-as-Unit 미지원 goal에 대한 fallback으로 유지

- `/Users/keunsik/develop/swk/crewdeck/server/db/schema.ts`
  - `goals` 테이블에 컬럼 추가:
    ```sql
    worktree_path TEXT,           -- 현재 활성 worktree 경로 (NULL이면 구 모델)
    worktree_branch TEXT,         -- goal branch 이름
    goal_model TEXT NOT NULL DEFAULT 'legacy'  -- 'legacy' | 'goal_as_unit'
    acceptance_script TEXT,       -- Goal 수준 acceptance 스크립트
    squash_commit_sha TEXT,       -- squash 완료 후 기록
    squash_status TEXT NOT NULL DEFAULT 'none'  -- 'none' | 'pending_approval' | 'approved' | 'merged' | 'blocked'
    ```
  - `tasks` 테이블에 컬럼 추가:
    ```sql
    acceptance_script TEXT        -- 실행 가능한 스크립트 경로 또는 인라인 명령어
    ```

- `/Users/keunsik/develop/swk/crewdeck/server/core/orchestration/engine.ts`
  - `executeTask()` 내 worktree 생성 로직 조건 분기:
    ```
    if (goal_model === 'goal_as_unit'):
      worktreeInfo = goal에 이미 있는 worktree_path/branch 사용
      태스크 완료 후 removeWorktree 호출 안 함
    else (legacy):
      기존 로직 그대로 유지
    ```

#### 1.2 태스크 간 맥락 전이

같은 worktree에서 순차 실행되므로 파일시스템 상태가 자동으로 공유됨.

추가 컨텍스트 전달:
- `result_summary` (기존 필드): 이전 태스크 완료 요약을 다음 태스크 프롬프트 상단에 주입
- 구현 위치: `engine.ts buildImplementationPrompt()` (또는 동등 인라인 prompt 생성부)에 이전 태스크 `result_summary` 체인 삽입

```
## 이전 태스크 완료 상태
- [Task N-1] 타이틀: {summary}
- [Task N-2] 타이틀: {summary}
```

---

### 2. 태스크 체크포인트 (stash 기반) — 부분 구현, rollback 미연결

**현행 동작**: task 시작 전 checkpoint를 만드나, 실패 경로에서 해당 task만 롤백하는 연결은 아직 없다. `restoreCheckpoint()`는 helper로만 존재한다.

#### 2.1 스냅샷 타이밍

```
태스크 N 시작 직전:
  git stash push -m "crewdeck-checkpoint-{taskId}" (worktree 내에서)

태스크 N 성공:
  git stash drop crewdeck-checkpoint-{taskId}  (체크포인트 제거)

태스크 N 검증 FAIL 이월:
  git stash drop crewdeck-checkpoint-{taskId}
  → 현재 변경 유지 + status='done' + goal QA로 issue 이월

태스크 N 실행 예외:
  status='blocked' 또는 'todo'
  → checkpoint 복원 없이 현재 worktree에서 재시도 (Known Gap)
```

#### 2.2 구현 위치

`engine.ts executeTask()`는 `stashCheckpoint()`·`dropCheckpoint()`를 호출한다. `restoreCheckpoint()`·`saveDiscardedDiff()`는 실패 실행 경로에 연결되지 않았다.

신규 헬퍼 위치: `/Users/keunsik/develop/swk/crewdeck/server/core/project/worktree.ts`

```typescript
function stashCheckpoint(worktreePath: string, taskId: string): boolean
function restoreCheckpoint(worktreePath: string, taskId: string): boolean
function dropCheckpoint(worktreePath: string, taskId: string): void
```

#### 2.3 현재 정리 경계

| 시나리오 | 현재 처리 |
|----------|-----------|
| 재시도 반복 | 같은 `crewdeck-checkpoint-{taskId}`가 있으면 중복 push를 건너뛰고 현재 worktree 변경을 계속 사용 |
| 서버 재시작 후 dangling stash | `cleanupStaleWorktrees()`가 `crewdeck-checkpoint-` prefix stash를 제거 |
| 실패 task만 롤백 | helper는 있지만 호출부가 없음. 연결·충돌 처리·회귀 테스트가 후속 필요 |

---

### 3. Squash Merge 파이프라인 — 합의된 결정

**원칙**: Goal 완료 = 1 squash commit. 사용자 승인 후 main에 반영.

#### 3.1 Goal 완료 감지

`scheduler.ts` 또는 `engine.ts`의 태스크 완료 처리부에 아래 로직 추가:

```
태스크 done 전환 시:
  남은 태스크 수 = SELECT COUNT(*) FROM tasks WHERE goal_id = ? AND status != 'done'
  if 남은 수 == 0 AND goal_model == 'goal_as_unit':
    → triggerGoalSquash(goalId) 호출
```

#### 3.2 Squash Commit 메시지 자동 생성

```
{goal.title}

Tasks:
- {task1.title}
- {task2.title}
...

Generated by Crewdeck (Goal-as-Unit)
Agent: {agentName}
```

#### 3.3 사용자 승인 흐름

```
triggerGoalSquash(goalId):
  1. acceptance_script 실행 (있을 경우) → FAIL 시 squash 차단, goal.squash_status='blocked'
  2. PASS or 없음 → goals.squash_status = 'pending_approval' 업데이트
  3. broadcast("goal:squash_ready", { goalId, commitMessage, filesChanged })
  4. 대시보드 Goal 카드에 [승인 후 반영] 버튼 표시
```

```
사용자 [승인] 클릭 → POST /goals/:goalId/squash-approve:
  1. goals.squash_status = 'approved'
  2. executeSquashMerge(goalId) 호출
  3. 모드별 처리 (§3.4)
  4. goals.squash_status = 'merged', squash_commit_sha 기록
  5. worktree 삭제, goal branch 삭제
  6. broadcast("goal:merged", { goalId, sha, prUrl })
```

#### 3.4 모드별 Squash 처리

| 모드 | 처리 방식 | 결과 |
|------|-----------|------|
| `local_only` | `git merge --squash goal/{branch}` → `git commit -m "{message}"` in main | 로컬 1 commit |
| `main_direct` | squash merge → main → `git push origin main` | 원격 1 commit |
| `branch_pr` | goal branch를 squash option으로 PR 생성 (`gh pr create --squash`) | PR 1개 |

**구현 위치**: `/Users/keunsik/develop/swk/crewdeck/server/core/project/git-workflow.ts`

신규 함수:
```typescript
function squashMergeGoal(
  projectWorkdir: string,
  goalBranch: string,
  commitMessage: string,
  mode: GitMode,
): { sha: string | null; prUrl: string | null; error?: string }
```

**변경 대상 파일**:
- `/Users/keunsik/develop/swk/crewdeck/server/api/routes/goals.ts` — `POST /goals/:id/squash-approve` 엔드포인트 추가
- `/Users/keunsik/develop/swk/crewdeck/dashboard/src/` — Goal 카드에 squash 승인 UI 추가 (ConfirmDialog 사용, window.confirm 금지)

---

### 4. Acceptance Script 게이트

**원칙**: 실데이터 audit을 squash 직전에 자동 실행. FAIL이면 merge 차단.

#### 4.1 DB Schema

`goals.acceptance_script`: Goal 수준 (예: `npx tsx scripts/drift-audit.ts`)
`tasks.acceptance_script`: Task 수준 (드문 경우, 태스크 성공 전 게이트)

#### 4.2 실행 시점

```
Goal 수준:
  triggerGoalSquash() → acceptance_script 실행 → PASS? → pending_approval

Task 수준 (선택):
  executeTask() 검증 통과 후, done 전환 직전에 실행
  FAIL → task blocked (재시도 대상)
```

#### 4.3 실행 방식

```typescript
function runAcceptanceScript(
  workdir: string,
  script: string,
  timeoutMs: number = 120_000,
): { passed: boolean; output: string }
```

- `spawnSync` 사용, 타임아웃 2분
- 종료 코드 0 = PASS, 그 외 = FAIL
- stdout/stderr를 activities에 기록 (최대 1,000자)

#### 4.4 UI

대시보드 Goal 카드:
- acceptance_script 입력 필드 (Goal 생성/편집 시)
- Squash pending 상태에서 스크립트 실행 결과 표시 (pass/fail + 출력 미리보기)

---

### 5. 호환성 전략 — 합의된 결정

**원칙**: 진행 중인 Goal은 기존 방식 유지. 신규 Goal부터만 Goal-as-Unit 적용.

#### 5.1 식별 방법

`goals.goal_model` 컬럼:
- `'legacy'` (기본값): 기존 Task-per-worktree 동작
- `'goal_as_unit'`: 신 모델 적용

신규 Goal 생성 경로(`POST /goals`, `decomposeGoal()` 내 goal 생성)에서 `goal_model = 'goal_as_unit'` 으로 삽입.

기존 DB의 goals는 `goal_model = 'legacy'` 유지 (ALTER TABLE 기본값에 의해 자동 적용).

#### 5.2 Engine 분기 로직

`executeTask()` 시작부:
```typescript
const goal = db.prepare("SELECT goal_model, worktree_path, worktree_branch FROM goals WHERE id = ?").get(task.goal_id)
if (goal.goal_model === 'goal_as_unit') {
  // Goal 공유 worktree 사용
} else {
  // 기존 createWorktree() 로직 유지
}
```

#### 5.3 마이그레이션

`schema.ts migrate()` 에 증분 마이그레이션 추가:
```sql
ALTER TABLE goals ADD COLUMN goal_model TEXT NOT NULL DEFAULT 'legacy'
ALTER TABLE goals ADD COLUMN worktree_path TEXT
ALTER TABLE goals ADD COLUMN worktree_branch TEXT
ALTER TABLE goals ADD COLUMN acceptance_script TEXT
ALTER TABLE goals ADD COLUMN squash_commit_sha TEXT
ALTER TABLE goals ADD COLUMN squash_status TEXT NOT NULL DEFAULT 'none'
ALTER TABLE tasks ADD COLUMN acceptance_script TEXT
```

패턴: 기존 `if (!goalColumns.some(c => c.name === 'goal_model'))` 체크 방식 준수.

---

## 데이터 흐름 (Goal-as-Unit 전체 경로)

```
Goal 생성 (goal_model='goal_as_unit')
  ↓
decomposeGoal() → 태스크 생성
  ↓
Goal 실행 시작:
  createGoalWorktree() → .crewdeck-worktrees/goal-{slug}-{uid}/ (branch: goal/{slug}-{uid})
  goals.worktree_path = ..., goals.worktree_branch = ... 저장
  ↓
Task 1 실행 (shared worktree):
  stashCheckpoint(taskId)
  → 구현 → QG 검증
  → PASS: dropCheckpoint(taskId), result_summary 저장, status='done'
  → 검증 FAIL 이월: dropCheckpoint(taskId), 변경 유지, status='done', goal QA issue 이월
  → 실행 예외: status='blocked' 또는 'todo', 현재 worktree에서 retry (rollback 미연결)
  ↓
Task 2, 3 ... (동일 worktree, 이전 파일 상태 이어받음)
  ↓
마지막 Task done:
  acceptance_script 실행 (있을 경우)
  → FAIL: goal.squash_status='blocked', broadcast alert
  → PASS: goal.squash_status='pending_approval', broadcast("goal:squash_ready")
  ↓
사용자 [승인]:
  squashMergeGoal() → 1 commit (또는 1 PR)
  goal.squash_status='merged', squash_commit_sha 기록
  removeWorktree(worktree_path, worktree_branch)
```

---

## 구현 순서 및 우선순위

| 순서 | 작업 | 파일 | 의존성 |
|------|------|------|--------|
| 1 | DB schema 마이그레이션 | `schema.ts` | 없음 |
| 2 | `createGoalWorktree()` + stash 헬퍼 | `worktree.ts` | 1 |
| 3 | `squashMergeGoal()` | `git-workflow.ts` | 1 |
| 4 | `engine.ts` Goal-as-Unit 분기 + stash 삽입 | `engine.ts` | 2 |
| 5 | `runAcceptanceScript()` + `triggerGoalSquash()` | `engine.ts` | 3, 4 |
| 6 | API 엔드포인트 (`POST /goals/:id/squash-approve`) | `goals.ts` | 5 |
| 7 | 대시보드 UI (squash 승인 버튼, acceptance_script 입력) | `dashboard/src/` | 6 |

---

## 빌드 및 검증 명령

```bash
# 타입 검사 (필수, 커밋 전)
npm run typecheck
cd dashboard && npx tsc -b

# 수동 E2E 검증 시나리오
# 1. 새 프로젝트 생성 → 새 Goal 추가 (goal_model='goal_as_unit' 확인)
# 2. Full Auto 모드로 Goal 실행 → 태스크 순차 실행 확인
# 3. 마지막 태스크 완료 후 대시보드에 [승인 후 반영] 버튼 출현 확인
# 4. 승인 → git log에 커밋 1개만 생성되었는지 확인
# 5. 기존 진행 중 Goal(legacy) 은 기존 방식으로 계속 동작하는지 확인
```

---

## 위험 요소

| 위험 | 설명 | 완화 방안 |
|------|------|-----------|
| **concurrency=3+ 고부하 경합** | goal 간 병렬은 격리되지만 동시 squash/integration 경합이 커질 수 있음 | 기본 goal slot은 2. `CREWDECK_MAX_CONCURRENCY`로 높여도 atomic claim으로 goal 내부를 순차 1로 고정하고 integration-time 충돌 해결을 사용. 3+ 고부하는 미해결 과제로 남음 |
| **task 실패 rollback 미연결** | 실행 예외 후 부분 변경이 공유 worktree에 남아 재시도·sibling에 영향을 줄 수 있음 | `restoreCheckpoint()`·`saveDiscardedDiff()` 호출부와 충돌 처리를 연결하기 전까지 미해결 과제로 남음 |
| **승인 대기 중 서버 재시작** | `squash_status='pending_approval'` 상태에서 서버 재시작 | 서버 시작 시 `squash_status='pending_approval'` goal 목록 조회 → broadcast("goal:squash_ready") 재발송. worktree_path 존재 여부 확인 후 없으면 alert |
| **acceptance_script 무한 대기** | 스크립트가 interactive 프롬프트를 띄우는 경우 | `spawnSync` 타임아웃 2분 강제 적용. stdin = /dev/null |
| **worktree 중간 정리** | `cleanupStaleWorktrees()` 가 서버 재시작 시 진행 중 Goal worktree를 삭제 | `worktree_path IS NOT NULL AND squash_status != 'merged'` 인 goal의 worktree_path는 cleanup 제외 목록에 추가 |

---

## 측정 지표 (구현 후 확인)

| 지표 | 목표 | 측정 방법 |
|------|------|-----------|
| Goal 당 커밋 수 | 1 | `git log --oneline` 카운트 (drift goal 재현 후) |
| Goal 당 false-positive 수 (drift 재현) | 10 미만 | `drift-audit.ts` acceptance script PASS/FAIL 비율 |
| squash merge 성공률 | 95%+ | activities 테이블 `goal:merged` vs `git_error` 비율 |
| 기존 legacy goal 동작 이상 | 0건 | 기존 goal 실행 후 태스크별 커밋 방식 유지 여부 |

---

## self_verify

- **confident**:
  - `goal_model` 컬럼으로 신구 모델 분기 — 기존 `prompt_source`, `needs_worktree` 컬럼 증분 마이그레이션 패턴과 완전히 일치, 하위 호환성 보장
  - squash merge 후 worktree 삭제 — 현재 `finally` 블록에서 `removeWorktree` 호출 패턴 그대로 Goal 완료 시점으로 이동

- **uncertain**:
  - **task 단위 실패 rollback**: checkpoint helper는 있지만 실행 예외 경로에 복원·diff 보존 호출이 없음. 연결 후 stash 충돌 빈도와 공유 worktree 회귀를 실측해야 함
  - **acceptance_script 타임아웃 2분**: `drift-audit.ts` 실행 시간이 실제 환경(DB 크기, 네트워크)에 따라 다를 수 있음. 구현 후 실측 필요

- **not_tested**:
  - **concurrency=3+ 고부하**: 기본 2-goal 병렬은 구현·실측했지만, `CREWDECK_MAX_CONCURRENCY=3` 이상에서 동시 squash/integration 경합은 실운영 표본이 부족함
  - **서버 재시작 후 pending_approval 복구**: 재발송 broadcast 로직은 설계했으나 실제 클라이언트(대시보드 WebSocket reconnect 흐름)에서 수신 여부 미검증
  - **branch_pr 모드에서 `gh pr create --squash`**: gh CLI가 squash 옵션을 PR 생성 시점에 지정할 수 있는지 실제 CLI 동작 확인 필요 (옵션명: `--squash` 존재 여부)
