# Autopilot + Hierarchical Delegation

> CPS Plan — 개요 페이지 완전 자동화 & 계층적 위임

## Context (배경)

Crewdeck은 Solo Founder가 AI 에이전트 팀을 조직하고, 목표(Goal)를 설정하면 태스크로 분해→실행→검증까지 수행하는 오케스트레이션 도구다.

### 현재 상태

**이미 구현된 자동화:**
- Goal decomposition: CTO 에이전트가 AI 기반으로 태스크 분해 (수동 트리거)
- Task queue: 우선순위 기반 순차 실행 (수동 시작)
- Quality Gate: 실행→검증→auto-fix(1회) 파이프라인
- Org Context: 에이전트 프롬프트에 팀 구조 정보 주입

**수동 개입이 필요한 지점:**
```
Goal 생성 → [수동 클릭] Decompose → Tasks 생성 → [수동 클릭] Run Queue → 자동 실행
```

**계층적 위임 상태:**
- DB에 `parent_id` 존재, OrgChart UI에 계층 표시
- 하지만 2뎁스→3뎁스 태스크 위임 로직 없음
- CTO의 직계 자식(2뎁스)에게만 역할 기반 할당
- 3뎁스 에이전트는 항상 유휴(Idle) 상태

## Problem (문제)

### P1. 수동 개입으로 인한 자동화 단절
Goal 생성 후 Decompose 클릭, Queue 시작 클릭 — 2번의 수동 개입이 전체 자동화를 막고 있다. Solo founder가 목표만 던지고 다른 일을 하고 싶은데, 계속 대시보드를 들여다봐야 한다.

### P2. 3뎁스 에이전트 활용 불가
조직도에서 Frontend Dev 밑에 Frontend Developer(3뎁스)를 배치해도, 실제로는 일감이 전달되지 않는다. 조직 구조를 만든 의미가 없다.

### P3. 실행 제어 부재
완전 자동화가 되면 "폭주" 위험이 있다. 사용자가 자동화 수준을 ON/OFF할 수 있어야 안심하고 사용 가능.

### P4. Full Autopilot의 스코프 불확실성
CTO가 Goal까지 스스로 생성하는 Full Autopilot의 경우, "어디까지 할 건지" 사용자가 예측할 수 없다. 끝없이 Goal을 만들어서 실행하면 비용·시간 모두 통제 불가. Rate limit에 걸려 중간에 끊기면 상태 복구도 어렵다.

### P5. Rate Limit 중단 시 복원
Autopilot 실행 중 rate limit이 발생하면 현재는 해당 태스크만 'todo'로 되돌린다. 하지만 자동 파이프라인 전체가 멈춰야 하고, rate limit 해소 후 자동 재개할 수 있어야 한다.

## Solution (해결)

### 아키텍처 개요

```
┌─────────────────────────────────────────────────────────┐
│            Autopilot Mode (3단계)                        │
│     [ Manual ]     [ Goal ]        [ Full ]             │
│     수동 제어       Goal 이후 자동   미션부터 자동        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ Full 모드만 ─┐                                       │
│  │ CTO가 Mission │                                       │
│  │ 분석 → Goal   │                                       │
│  │ 자동 생성     │                                       │
│  └───────┬───────┘                                       │
│          ↓                                               │
│  Goal (사용자 추가 or CTO 자동 생성)                      │
│    ↓ [Goal/Full 모드: 자동]                               │
│  CTO가 Goal Decompose → 태스크 생성                      │
│    ↓ [Goal/Full 모드: 자동]                               │
│  역할 기반 에이전트 할당 (2뎁스)                           │
│    ↓ [자동]                                              │
│  Queue 자동 시작                                          │
│    ↓                                                     │
│  Task 실행 시작                                           │
│    ↓ [계층적 위임]                                        │
│  하위 에이전트 있으면 → 서브태스크 분해·위임               │
│    ↓                                                     │
│  Quality Gate 검증                                       │
│    ↓                                                     │
│  완료 / Auto-fix                                         │
│                                                          │
│  ── Rate Limit 발생 시 ──                                │
│  Queue paused → backoff 재시도 → 자동 재개 or 정지        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

### Feature 1: Autopilot Mode (3단계 자동화)

#### 1.1 모드 정의

| 모드 | 값 | Goal 생성 | Decompose | Queue 실행 | 대상 사용자 |
|------|---|----------|-----------|-----------|------------|
| **Manual** | `off` | 수동 | 수동 클릭 | 수동 시작 | 세밀한 제어 원할 때 |
| **Goal Autopilot** | `goal` | **사용자가 추가** | 자동 | 자동 | **기본 추천 모드** |
| **Full Autopilot** | `full` | CTO가 자동 생성 | 자동 | 자동 | 미션만 주고 방치 |

#### 1.2 Goal Autopilot (추천 모드)

사용자가 Goal을 직접 추가하면, 이후 과정은 전부 자동.

```
사용자: Goal "로그인 페이지 구현" 추가
  ↓ [자동] CTO가 Decompose → 3개 태스크 생성
  ↓ [자동] Queue 시작 → 태스크 순차 실행
  ↓ [자동] Quality Gate → 완료
사용자: 결과 확인
```

**장점:**
- 사용자가 스코프를 통제 (Goal 단위로 무엇을 할지 결정)
- 비용 예측 가능 (Goal 1개 ≈ 태스크 3~5개)
- Rate limit에 걸려도 해당 Goal 범위 내에서만 영향

**트리거:**
```
POST /goals → Goal 생성 → autopilot='goal'|'full' 체크
  → engine.decomposeGoal() 자동 호출
  → decompose 완료 → scheduler.startQueue() 자동 호출
```

#### 1.3 Full Autopilot (미션 기반)

프로젝트의 mission을 기반으로 CTO가 Goal까지 자동 생성.

```
사용자: Autopilot → Full 전환, mission = "MVP 런칭"
  ↓ [자동] CTO가 mission 분석 → Goal 3개 생성
  ↓ [자동] 각 Goal Decompose → 태스크 생성
  ↓ [자동] Queue 실행
  ↓ ... (반복)
  ↓ [자동 정지] 예산 도달 or Goal 전부 완료
```

**안전장치 (Full 모드 전용):**

| 안전장치 | 기본값 | 설명 |
|---------|--------|------|
| **Goal 개수 제한** | 최대 5개 | CTO가 한 번에 생성하는 Goal 상한 |
| **자동 정지 조건** | 모든 Goal done | Goal 전부 완료 시 Full 모드 자동 해제 → Goal 모드로 전환 |
| **Rate limit pause** | 자동 | rate limit 발생 → 파이프라인 일시정지 → 해소 후 자동 재개 |
| **사용자 중단** | 언제든 | 토글을 Manual/Goal로 바꾸면 즉시 새 Goal 생성 중단 |

#### 1.4 Rate Limit 대응

```
실행 중 rate limit 발생
  ↓
현재 태스크 → status: 'todo' (기존 동작)
Queue → paused 상태 (신규)
  ↓
WebSocket → 대시보드에 "Rate limit — 일시정지" 배너
  ↓
[자동] 60초 후 재시도 (exponential backoff: 60s → 120s → 240s, 최대 5분)
  ↓
성공 → Queue 자동 재개
실패 3회 연속 → Queue 정지, 사용자 알림
```

**DB 변경:**
```sql
-- projects 테이블에 Queue 상태 추가는 불필요 (메모리에서 관리)
-- scheduler에 paused 상태 + resume timer 추가
```

#### 1.5 프로젝트 설정

**DB 변경** (`server/db/schema.ts`):
```sql
-- projects 테이블에 컬럼 추가
autopilot TEXT DEFAULT 'off'  -- 'off' | 'goal' | 'full'
```

#### 1.6 대시보드 UI

**Overview 탭 상단 — 3단계 토글:**
```
┌──────────────────────────────────────────────────────────────┐
│  Autopilot   [ Manual ·  Goal ·  Full ]                     │
│                         ~~~~~~                               │
│  Goal을 추가하면 자동으로 분해·할당·실행합니다                  │
└──────────────────────────────────────────────────────────────┘
```

- **Manual 선택 시:** 현재와 동일 (Decompose 버튼, Queue 버튼 노출)
- **Goal 선택 시:** Decompose 버튼 숨김, Goal 추가 시 자동 진행, Queue 자동
- **Full 선택 시:** Goal 추가 영역 숨김 + "CTO가 mission 기반으로 자동 진행 중" 상태 표시
  - Full 전환 시 확인 다이얼로그: "CTO가 미션을 기반으로 Goal을 자동 생성합니다. 계속하시겠습니까?"

**Rate Limit 배너 (Queue 일시정지 시):**
```
┌──────────────────────────────────────────────────┐
│  ⏸ Rate limit 감지 — 120초 후 자동 재개 (2/3)    │
│                                    [지금 재개]    │
└──────────────────────────────────────────────────┘
```

---

### Feature 2: Hierarchical Delegation (계층적 위임)

#### 2.1 위임 전략

**원칙:** 태스크를 할당받은 에이전트가 하위 에이전트를 보유하면, 자동으로 서브태스크를 생성하여 위임한다.

**위임 판단 기준:**
- 할당된 에이전트에게 `children` (DB: parent_id = 해당 에이전트)이 1명 이상 존재
- 태스크의 complexity가 위임 가치가 있다고 AI가 판단

**위임 흐름:**
```
Task 실행 시작 (assignee = Frontend Dev)
  ↓
하위 에이전트 존재 확인
  ↓ 있음
Frontend Dev에게 "서브태스크 분해" 프롬프트 전송
  ↓
서브태스크 JSON 파싱 → 하위 에이전트에 할당
  ↓
서브태스크 순차 실행 (하위 에이전트가 수행)
  ↓
모든 서브태스크 완료 → 부모 태스크 완료 처리
```

#### 2.2 서브태스크 모델

**DB 변경** (`server/db/schema.ts`):
```sql
-- tasks 테이블에 컬럼 추가
parent_task_id TEXT  -- 서브태스크의 부모 태스크 ID (NULL이면 루트 태스크)
```

**계층 구조:**
```
Goal
  └── Task (assignee: Frontend Dev)       ← 루트 태스크
        ├── SubTask 1 (assignee: UI Dev)  ← 서브태스크
        └── SubTask 2 (assignee: UI Dev)  ← 서브태스크
```

#### 2.3 위임 엔진 (`server/core/orchestration/delegation.ts` 신규)

```typescript
interface DelegationResult {
  delegated: boolean;
  subtasks: Array<{ title: string; description: string; assigneeId: string }>;
}

async function attemptDelegation(taskId: string): Promise<DelegationResult>
```

**로직:**
1. Task의 assignee 조회
2. assignee의 children(하위 에이전트) 조회
3. children이 없으면 → `{ delegated: false }` → 직접 실행
4. children이 있으면 → assignee에게 "분해 프롬프트" 전송
5. 분해 결과를 서브태스크로 DB 저장
6. 서브태스크를 children에게 역할 기반 할당

#### 2.4 실행 파이프라인 변경 (`engine.ts`)

```
기존: executeTask() → spawn agent → send prompt → verify
변경: executeTask() → attemptDelegation()
        ├── delegated=true  → 서브태스크 순차 실행 → 모두 완료 시 부모 태스크 완료
        └── delegated=false → 기존 로직 (직접 실행)
```

#### 2.5 대시보드 UI

**Task 목록에서 서브태스크 표시:**
```
☐ Frontend UI 구현 (Frontend Dev)           ← 루트 태스크
  ├── ☐ 컴포넌트 스캐폴딩 (UI Developer)    ← 서브태스크 (접힘/펼침)
  └── ☐ 스타일링 적용 (UI Developer)         ← 서브태스크
```

- 루트 태스크 클릭 시 서브태스크 펼침
- 서브태스크 진행률이 루트 태스크 progress에 반영

---

### Feature 3: 통합 — Autopilot + Delegation

**시나리오 A: Goal Autopilot + Delegation**
```
1. 사용자: Autopilot → "Goal" 모드
2. 사용자: Goal 추가 "프론트엔드 리뉴얼"
3. [자동] CTO가 Goal을 3개 태스크로 분해
   - Task 1: "컴포넌트 리팩토링" → Frontend Dev
   - Task 2: "API 연동" → Backend Dev
   - Task 3: "E2E 테스트" → QA
4. [자동] Queue 시작
5. [자동] Task 1 실행 시작
   - Frontend Dev 하위에 UI Developer 있음
   - Frontend Dev가 서브태스크 2개로 분해
   - UI Developer가 서브태스크 순차 실행
6. [자동] Task 1 완료 → Task 2 실행 → ...
7. [자동] 전체 완료, Quality Gate PASS
8. 사용자: 결과 확인
→ 사용자가 다음 Goal을 추가할 때까지 대기
```

**시나리오 B: Full Autopilot + Delegation**
```
1. 사용자: Autopilot → "Full" 모드 (확인 다이얼로그 승인)
2. [자동] CTO가 project mission 분석
3. [자동] Goal 3개 자동 생성 (최대 5개)
4. [자동] 각 Goal decompose → 태스크 → 위임 → 실행
5. [Rate limit 발생] → Queue paused → 120초 대기 → 자동 재개
6. [자동] 모든 Goal 완료 → "Goal" 모드로 자동 전환
7. 사용자: 결과 확인, 필요시 추가 Goal 입력
```

**시나리오 C: Rate Limit 중단 & 복원**
```
1. Task 3 실행 중 rate limit 발생
2. [자동] 현재 태스크 → 'todo'로 롤백
3. [자동] Queue → 'paused' 상태
4. [자동] 대시보드에 "Rate limit — 60초 후 재개" 배너
5. [자동] 60초 후 Queue 재개 → Task 3 재실행
6. 연속 3회 실패 → Queue 정지, "수동 재개 필요" 알림
```

---

## 변경 범위

### 서버 (9 파일)

| # | 파일 | 변경 내용 | 신규/수정 |
|---|------|----------|-----------|
| 1 | `server/db/schema.ts` | projects.autopilot, tasks.parent_task_id 컬럼 | 수정 |
| 2 | `server/core/orchestration/delegation.ts` | 위임 엔진 (attemptDelegation) | **신규** |
| 3 | `server/core/orchestration/engine.ts` | executeTask에 delegation 통합, Full모드 goal 자동생성 | 수정 |
| 4 | `server/core/orchestration/scheduler.ts` | 서브태스크 인식, 부모 완료 판정, rate limit pause/resume | 수정 |
| 5 | `server/api/routes/goals.ts` | Goal 생성 시 autopilot 자동 트리거 | 수정 |
| 6 | `server/api/routes/projects.ts` | autopilot 모드 변경 API, Full 모드 시작 트리거 | 수정 |
| 7 | `server/api/routes/orchestration.ts` | 위임 관련 엔드포인트 | 수정 |
| 8 | `server/api/routes/tasks.ts` | 서브태스크 CRUD, 계층 조회 | 수정 |
| 9 | `shared/types.ts` | Task.parentTaskId, Project.autopilot, AutopilotMode 타입 | 수정 |

### 대시보드 (5 파일)

| # | 파일 | 변경 내용 | 신규/수정 |
|---|------|----------|-----------|
| 10 | `dashboard/src/components/ProjectHome.tsx` | Autopilot 3단계 토글, rate limit 배너 | 수정 |
| 11 | `dashboard/src/components/TaskList.tsx` | 서브태스크 트리 표시 | 수정 |
| 12 | `dashboard/src/lib/api.ts` | autopilot API, 서브태스크 API | 수정 |
| 13 | `dashboard/src/stores/useStore.ts` | autopilot 상태, queue paused 상태 | 수정 |
| 14 | `dashboard/src/hooks/useWebSocket.ts` | delegation/subtask/rate-limit 이벤트 | 수정 |

**총 14파일** — 복잡도: 복잡 (8+ 파일, Plan→Design→스프린트)

---

## 스프린트 분할

### Sprint 1: Goal Autopilot 서버
- [ ] DB 마이그레이션: `projects.autopilot` TEXT ('off'|'goal'|'full')
- [ ] `shared/types.ts`: AutopilotMode, Project.autopilot 타입
- [ ] `projects.ts`: autopilot 모드 변경 API (`PATCH /projects/:id`)
- [ ] `goals.ts`: Goal 생성 시 autopilot='goal'|'full' → 자동 decompose
- [ ] `engine.ts`: decompose 완료 → autopilot 체크 → 자동 queue 시작
- [ ] 검증: Goal 생성 → 자동 decompose → 자동 queue 시작 (curl)

### Sprint 2: Full Autopilot + Rate Limit 대응
- [ ] `engine.ts`: Full 모드 — CTO가 mission 기반 Goal 자동 생성 (최대 5개)
- [ ] `engine.ts`: Full 모드 완료 → 자동으로 'goal' 모드 전환
- [ ] `scheduler.ts`: rate limit 시 paused 상태 + exponential backoff (60s→120s→240s)
- [ ] `scheduler.ts`: 3회 연속 실패 → queue 정지 + WebSocket 알림
- [ ] WebSocket: `queue:paused`, `queue:resumed`, `queue:stopped` 이벤트
- [ ] 검증: rate limit 시나리오 시뮬레이션 (mock)

### Sprint 3: Autopilot UI
- [ ] `ProjectHome.tsx`: 3단계 토글 (Manual / Goal / Full)
- [ ] `ProjectHome.tsx`: Full 모드 전환 시 확인 다이얼로그
- [ ] `ProjectHome.tsx`: Rate limit 배너 (남은 시간, 재시도 횟수, 수동 재개 버튼)
- [ ] `api.ts`: autopilot PATCH API
- [ ] `useStore.ts`: autopilot 모드, queuePaused 상태
- [ ] `useWebSocket.ts`: queue:paused/resumed/stopped 이벤트 처리
- [ ] 모드별 조건부 렌더링:
  - Manual: Decompose 버튼 + Queue 버튼 노출 (현재)
  - Goal: Decompose 숨김, Goal 추가만 노출
  - Full: Goal 추가도 숨김, "CTO 자동 진행 중" 상태 표시
- [ ] 검증: UI 토글 → 서버 반영 → Goal 추가 → 자동 실행 확인

### Sprint 4: Hierarchical Delegation 서버
- [ ] DB 마이그레이션: `tasks.parent_task_id` 컬럼
- [ ] `shared/types.ts`: Task.parentTaskId 타입
- [ ] `delegation.ts`: 위임 엔진 신규 작성 (attemptDelegation)
- [ ] `engine.ts`: executeTask에 delegation 통합
- [ ] `scheduler.ts`: 서브태스크 인식, 부모 완료 판정
- [ ] `tasks.ts`: 서브태스크 계층 조회 API
- [ ] 검증: 하위 에이전트 있는 조직 → 태스크 실행 → 서브태스크 자동 생성·실행

### Sprint 5: Delegation UI + 통합 테스트
- [ ] `TaskList.tsx`: 서브태스크 트리 표시 (접힘/펼침)
- [ ] `useWebSocket.ts`: delegation 이벤트 (task:delegated, subtask:created)
- [ ] 통합 테스트: Goal Autopilot + Delegation 시나리오
- [ ] 통합 테스트: Full Autopilot + Delegation + Rate Limit 시나리오
- [ ] 검증: 전체 시나리오 (Goal 생성 → 위임 → 완전 자동 완료)

---

## 트레이드오프

| 결정 | 선택 | 이유 |
|------|------|------|
| Autopilot 단계 | 3단계 (off/goal/full) | Goal 모드가 스코프 통제와 자동화의 균형점. Full은 고급 옵션 |
| Full 모드 완료 후 | 'goal' 모드로 자동 전환 | 무한 루프 방지. 사용자가 다시 Full로 켜야 재실행 |
| Rate limit 대응 | Exponential backoff + 3회 정지 | 무한 재시도 방지, 자동 복원과 안전 정지 사이 균형 |
| Full 모드 Goal 상한 | 5개 | 비용 폭발 방지. 사용자가 결과 확인 후 추가 실행 |
| 서브태스크 실행 | 순차 (직렬) | 현재 스케줄러가 프로젝트당 1동시 실행. 병렬은 Phase 2 |
| 위임 깊이 | 1단계만 (2뎁스→3뎁스) | 무한 재귀 방지. 3뎁스→4뎁스는 Phase 2 |
| 위임 판단 | AI 기반 | 규칙 기반보다 유연. 하위 에이전트 없으면 스킵 |
| 서브태스크 검증 | 개별 검증 안 함 | 루트 태스크 단위로 Quality Gate 실행 |

---

## 리스크

| 리스크 | 완화 |
|--------|------|
| Full Autopilot 비용 폭발 | Goal 5개 상한, 완료 후 자동 전환, 확인 다이얼로그 |
| Full 모드에서 엉뚱한 Goal 생성 | mission 기반 프롬프트 + Goal 개수 제한 + 즉시 모드 전환 가능 |
| Rate limit으로 중간 상태 오염 | 태스크 'todo' 롤백, Queue paused, backoff 후 재개 |
| Rate limit backoff 중 사용자 혼란 | 배너에 남은 시간·재시도 횟수 표시, 수동 재개 버튼 제공 |
| 위임 분해가 잘못될 수 있음 | 서브태스크 개수 제한 (최대 5개), 분해 실패 시 직접 실행 fallback |
| 서브태스크 실패 시 부모 태스크 처리 | 서브태스크 1개라도 fail → 부모 태스크 blocked |
