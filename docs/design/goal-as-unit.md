# Goal-as-Unit 아키텍처 전환

작성일: 2026-04-21
상태: 설계 확정 (구현 전)
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

### 2. 태스크 체크포인트 (stash 기반) — 합의된 결정

**원칙**: 태스크 실패 시 해당 태스크만 롤백, 전체 Goal 롤백 금지.

#### 2.1 스냅샷 타이밍

```
태스크 N 시작 직전:
  git stash push -m "crewdeck-checkpoint-{taskId}" (worktree 내에서)

태스크 N 성공:
  git stash drop crewdeck-checkpoint-{taskId}  (체크포인트 제거)

태스크 N 실패 (blocked 전환 시):
  git stash pop crewdeck-checkpoint-{taskId}  (이 태스크 변경만 롤백)
  → 재시도 또는 재할당
```

#### 2.2 구현 위치

`engine.ts executeTask()` 내 Goal-as-Unit 분기에 stash 호출 삽입.

신규 헬퍼 위치: `/Users/keunsik/develop/swk/crewdeck/server/core/project/worktree.ts`

```typescript
function stashCheckpoint(worktreePath: string, taskId: string): boolean
function restoreCheckpoint(worktreePath: string, taskId: string): boolean
function dropCheckpoint(worktreePath: string, taskId: string): void
```

#### 2.3 stash 충돌 시나리오 처리

| 시나리오 | 처리 방안 |
|----------|-----------|
| stash pop 충돌 | `git stash drop` 후 태스크 blocked, 활동 피드에 "수동 개입 필요" 기록 |
| stash 스택 누적 (재시도 반복) | `git stash list` grep `crewdeck-checkpoint-{taskId}` — 중복 push 방지 |
| 서버 재시작 후 dangling stash | 서버 시작 시 `cleanupStaleWorktrees()` 확장: stash 목록에서 `crewdeck-checkpoint-` prefix 제거 |

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
  → FAIL: restoreCheckpoint(taskId), status='blocked' → retry
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
cd dashboard && npx tsc --noEmit

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
| **concurrency=2+ 재활성화 시 충돌** | Goal-as-Unit에서 concurrency>1이면 같은 worktree에 2개 에이전트가 동시 접근 | Goal-as-Unit goal의 태스크는 강제 concurrency=1. scheduler에서 goal별 lock 적용. `DEFAULT_MAX_CONCURRENCY=1`은 이미 적용됨 |
| **stash 충돌** | restoreCheckpoint 시 WD가 dirty한 경우 pop 충돌 | `git stash pop --index` 실패 시 `git checkout -- .` + `git stash drop` 후 blocked 전환. 활동 피드에 상세 기록 |
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
  - stash 기반 체크포인트 — `cleanupStaleWorktrees()` + `worktreeInfo` 수명 주기와 직교하므로 기존 cleanup 로직과 충돌 없음
  - squash merge 후 worktree 삭제 — 현재 `finally` 블록에서 `removeWorktree` 호출 패턴 그대로 Goal 완료 시점으로 이동

- **uncertain**:
  - **stash pop 충돌 빈도**: 실제 복잡한 태스크 실행 후 stash 충돌이 얼마나 자주 발생하는지 측정 데이터 없음. 빈번할 경우 stash 대신 lightweight commit + `git reset HEAD~1` 방식으로 전환 검토 필요
  - **acceptance_script 타임아웃 2분**: `drift-audit.ts` 실행 시간이 실제 환경(DB 크기, 네트워크)에 따라 다를 수 있음. 구현 후 실측 필요

- **not_tested**:
  - **concurrency=2 이상에서 Goal-as-Unit 동작**: `DEFAULT_MAX_CONCURRENCY=1`이 현재 기본값이나, 사용자가 override 가능한 경로가 있는지 확인 필요. Goal 단위 lock 구현 전까지 override 차단 필요
  - **서버 재시작 후 pending_approval 복구**: 재발송 broadcast 로직은 설계했으나 실제 클라이언트(대시보드 WebSocket reconnect 흐름)에서 수신 여부 미검증
  - **branch_pr 모드에서 `gh pr create --squash`**: gh CLI가 squash 옵션을 PR 생성 시점에 지정할 수 있는지 실제 CLI 동작 확인 필요 (옵션명: `--squash` 존재 여부)
