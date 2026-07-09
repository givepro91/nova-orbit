# Goal-as-Unit Dashboard UI 설계

작성일: 2026-04-21
상태: 설계 확정 (구현 전) — 백엔드 스펙 확인 완료
연관 문서: docs/design/goal-as-unit.md, docs/design/quality-gate-phase3.md

---

## Context

백엔드에 Goal-as-Unit 아키텍처가 구현됐으나 Dashboard UI 부재로 사용자가 기능에 접근할 수 없다.

- `squash_status = 'pending_approval'` Goal 이 main 에 영원히 안 반영됨
- `acceptance_script` 입력 UI 없음 → 게이트 활용 불가
- QA 회귀 태스크 가시성 부재

대상: Solo founder + 비개발자 — 개발 전문 용어 금지.

---

## 확인된 백엔드 스펙

### WebSocket 이벤트 payload
| 이벤트 | payload |
|-------|---------|
| `goal:squash_ready` | `{ goalId, commitMessage, filesChanged, acceptanceOutput }` |
| `goal:merged` | `{ goalId, sha, prUrl }` |
| `goal:squash_blocked` | `{ goalId, output }` or `{ goalId, reason }` |
| `goal:squash_failed` | `{ goalId, error }` |
| `goal:qa_regression_created` | `{ goalId, qaTaskId }` |

### API 엔드포인트
- `POST /goals/:id/squash-approve` — 응답 `{ success, sha?, prUrl?, error? }`
- `GET /goals/:id` 는 `SELECT *` 이므로 신규 컬럼 자동 포함

### DB 신규 컬럼 (goals)
`goal_model`, `worktree_path`, `worktree_branch`, `acceptance_script`, `squash_commit_sha`, `squash_status`, `qa_regression_task_id`

---

## Problem (MECE)

- **P1** 목표 반영 승인 경로 부재 — WebSocket `goal:squash_ready` 수신해도 버튼 없음
- **P2** `acceptance_script` 입력 UI 부재 — DB 컬럼만 있고 폼 없음
- **P3** QA 회귀 태스크 가시성 부재 — Goal 카드에 지연 사유 안 보임
- **P4** WebSocket switch 에 `goal:*` 5 케이스 미등록
- **P5** Store `Goal` 타입에 신규 필드 없음 — `(goal as any)` 남용

---

## Solution

### 1. Store 확장 (`dashboard/src/stores/useStore.ts`)

```typescript
interface Goal {
  id: string
  project_id: string
  title: string
  description: string
  references: string
  priority: string
  progress: number
  // 신규
  goal_model: 'legacy' | 'goal_as_unit'
  squash_status: 'none' | 'pending_approval' | 'approved' | 'merged' | 'blocked'
  squash_commit_sha: string | null
  acceptance_script: string | null
  qa_regression_task_id: string | null
  worktree_path: string | null
  worktree_branch: string | null
}

// 신규 액션
updateGoal: (goal: Partial<Goal> & { id: string }) => void
// goals.map(g => g.id === goal.id ? { ...g, ...goal } : g)
```

### 2. API 클라이언트 (`dashboard/src/lib/api.ts`)

```typescript
api.goals.squashApprove(goalId: string): Promise<{ success: boolean; sha?: string; prUrl?: string; error?: string }>
```

### 3. WebSocket 핸들러 (`dashboard/src/hooks/useWebSocket.ts`)

| 이벤트 | 처리 |
|-------|------|
| `goal:squash_ready` | `updateGoal({ id: goalId, squash_status: 'pending_approval' })` + Toast "목표 반영 승인이 필요합니다" (info) + `crewdeck:refresh` dispatch |
| `goal:merged` | `updateGoal({ id: goalId, squash_status: 'merged', squash_commit_sha: sha })` + Toast "반영 완료: {sha.slice(0,7)}" (success) |
| `goal:squash_blocked` | `updateGoal({ id: goalId, squash_status: 'blocked' })` + Toast "목표 반영 차단됨" (error, detail=output/reason) |
| `goal:squash_failed` | `updateGoal({ id: goalId, squash_status: 'none' })` + Toast "목표 반영 실패" (error, detail=error) |
| `goal:qa_regression_created` | `updateGoal({ id: goalId, qa_regression_task_id: qaTaskId })` + `crewdeck:refresh` |

### 4. Goal 카드 (`dashboard/src/components/ProjectHome.tsx` — `renderGoalCard`)

`goal.goal_model !== 'goal_as_unit'` 이면 squash 관련 UI 전부 숨김.

#### 4.1 squash_status 배지
| 상태 | 배지 | 액션 | 색상 |
|------|------|------|------|
| `none` | 없음 | 없음 | — |
| `pending_approval` | "목표 반영 대기 중" | [목표 반영] 버튼 | amber |
| `approved` | "처리 중..." + 스피너 | 없음 | blue |
| `merged` | "반영 완료 {sha.slice(0,7)}" | 없음 | green |
| `blocked` | "반영 차단" | [재시도] (handleDecomposeGoal 연결) | red |

#### 4.2 QA 회귀 대기 배지
`qa_regression_task_id !== null && 해당 태스크.status !== 'done'` → amber "실전 QA 회귀 대기 중" 배지

#### 4.3 [목표 반영] 클릭 흐름
```
클릭 → setSquashApprovalGoalId(goal.id)
     → GoalSquashApprovalDialog 렌더
     → 확정 → api.goals.squashApprove(goalId)
       → 성공: Toast "반영이 시작됐습니다" (최종 merged 는 WebSocket 이벤트로)
       → 실패: Toast error + detail, 다이얼로그 유지
```

### 5. `GoalSquashApprovalDialog` (신규)

파일: `dashboard/src/components/GoalSquashApprovalDialog.tsx`

```typescript
interface GoalSquashApprovalDialogProps {
  goal: { id: string; title: string; worktree_branch: string | null; acceptance_script: string | null }
  commitMessage?: string  // WebSocket payload 에서 받은 것
  filesChanged?: string[]
  acceptanceOutput?: string
  onConfirm: () => Promise<void>
  onCancel: () => void
  isApproving: boolean
}
```

레이아웃:
```
┌─────────────────────────────────────────┐
│ 목표 반영 확인                        [×] │
├─────────────────────────────────────────┤
│ 아래 내용을 검토하고 main에 반영하세요   │
│                                         │
│ [목표] {title}                          │
│                                         │
│ [반영 브랜치] (worktree_branch 있을 때) │
│   {worktree_branch}                     │
│                                         │
│ [커밋 메시지 프리뷰] <pre> 블록          │
│   {commitMessage}                       │
│                                         │
│ [변경 파일] (filesChanged 있을 때)       │
│   • {file1}                             │
│   • {file2}                             │
│                                         │
│ [검증 결과] (acceptanceOutput 있을 때)   │
│   <pre>{acceptanceOutput}</pre>         │
├─────────────────────────────────────────┤
│            [취소]  [목표 반영 확정]      │
└─────────────────────────────────────────┘
```

- `isApproving` 중: 버튼 비활성 + 스피너, 배경 클릭 무시
- Escape 닫힘 (useEffect 키 핸들러)
- 버튼 색: `bg-blue-600 text-white` (비파괴, red 금지)

### 6. AddGoalDialog / EditGoalDialog 확장

`acceptance_script` textarea 추가 (description 아래, References 위):
- AddGoalDialog: 항상 표시
- EditGoalDialog: `goal.goal_model === 'goal_as_unit'` 일 때만
- placeholder: "완료 직전 실행할 검증 스크립트. 예: npx tsx scripts/drift-audit.ts"
- 빈 값 → NULL

### 7. Adversarial 태스크 배지

`task.title.startsWith('[사전 조사]')` → violet 칩 "사전 조사"
- TaskList.tsx + KanbanBoard SortableCard 양쪽

### 8. 용어 매핑

| 내부 용어 | UI 노출 |
|----------|---------|
| squash merge | 목표 반영 |
| pending_approval | 목표 반영 대기 중 |
| merged | 반영 완료 |
| blocked | 반영 차단 |
| acceptance script | 완료 검증 스크립트 |
| QA regression | 실전 QA 회귀 |
| goal_model / worktree_* | 노출 안 함 |

### 9. i18n 키 추가 (ko.ts + en.ts)

```typescript
goalSquashPendingBadge, goalSquashApproveBtn, goalSquashApprovedBadge,
goalSquashMergedBadge, goalSquashBlockedBadge, goalSquashRetryBtn,
goalQaRegressionWaiting,
goalSquashDialogTitle, goalSquashDialogDesc, goalSquashDialogBranch,
goalSquashDialogCommitMsg, goalSquashDialogFilesChanged, goalSquashDialogAcceptance,
goalSquashDialogConfirmBtn, goalSquashApproving,
toastSquashReady, toastSquashMerged, toastSquashBlocked, toastSquashFailed,
acceptanceScriptLabel, acceptanceScriptPlaceholder, acceptanceScriptHelp,
adversarialBadge,
```

---

## 파일 변경 목록

### 신규
- `dashboard/src/components/GoalSquashApprovalDialog.tsx`

### 수정
- `dashboard/src/stores/useStore.ts` — Goal 타입 확장 + updateGoal
- `dashboard/src/lib/api.ts` — squashApprove 메서드
- `dashboard/src/hooks/useWebSocket.ts` — 5 이벤트 핸들러
- `dashboard/src/components/ProjectHome.tsx` — 배지/버튼/acceptance_script 필드
- `dashboard/src/components/TaskList.tsx` — adversarial 배지
- `dashboard/src/components/KanbanBoard.tsx` — SortableCard adversarial 배지
- `dashboard/src/i18n/ko.ts`, `dashboard/src/i18n/en.ts` — 신규 키

---

## 구현 순서

1. useStore.ts 타입 확장 + updateGoal
2. api.ts squashApprove
3. useWebSocket.ts 5 케이스
4. GoalSquashApprovalDialog 신규
5. ProjectHome.tsx squash UI + acceptance_script 필드
6. TaskList/KanbanBoard adversarial 배지
7. i18n 키
8. `cd dashboard && npx tsc --noEmit` PASS

---

## 리스크

- **renderGoalCard 비대화** (이미 200줄+) → squash JSX 는 인라인 유지, 차후 GoalCard.tsx 추출
- **WebSocket 중복 이벤트** (서버 재시작 시 재broadcast) → 핸들러에서 퇴행 방지: merged 상태에 pending_approval 덮어쓰기 방지
- **Toast.detail props** → 실제 `showToast(msg, type, detail?)` 시그니처 확인 후 사용

---

## self_verify

- **confident**:
  - ConfirmDialog 재사용 불가 (message:string 제약) — 코드 직접 확인, 전용 다이얼로그 필요성 명확
  - 백엔드 WebSocket payload 스펙 직접 확인 완료 (engine.ts:1919, goals.ts:523 등)
  - GET /goals/:id 가 SELECT * 이므로 신규 컬럼 자동 포함 (server/api/routes/goals.ts:135)
  - 기존 useWebSocket switch 패턴 동일하게 확장 (crewdeck:refresh dispatch 유지)

- **uncertain**:
  - [재시도] 버튼 — `blocked` 상태 recover 정식 엔드포인트 없음. `handleDecomposeGoal` 임시 연결 (재검토 필요)
  - acceptance_script 실행 결과 `acceptanceOutput` 이 현재 빈 문자열로 전송 중 (engine.ts:1923) — 실제 값 채우려면 후속 백엔드 변경 필요. UI 는 "결과 없음" 표시 대응

- **not_tested**:
  - E2E: 실제 goal 생성→pending_approval→승인→merged 전체 흐름
  - WebSocket 이벤트 중복 수신 방어
