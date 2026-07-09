# [Plan] Phase 2: Production-Ready Safety & Trust

> Nova Engineering — CPS Framework
> 작성일: 2026-04-05
> 작성자: Claude (Adversarial Review 기반)
> Design: designs/phase2-production-ready.md

---

## Context (배경)

### 현재 상태

Crewdeck v0.2.0은 핵심 오케스트레이션 아키텍처가 완성된 상태다:
- Autopilot 3단계 (Manual/Goal/Full)
- Hierarchical Delegation (2→3뎁스, 서브태스크 5개 상한)
- Parallel Scheduler (에이전트별 1태스크, max 3 동시)
- Quality Gate (Generator-Evaluator 분리, 5차원 검증)
- Rate Limit Recovery (backoff + pause + manual resume)
- vitest 22/22 PASS, tsc/build PASS

### 왜 필요한가

3관점 종합 진단(Paperclip 레퍼런스 비교, 완성도 갭 분석, 적대적 보안 평가)에서 **"아키텍처는 있으나 동작 검증이 없는 프로토타입"**으로 판정됨.

**진단 결과 핵심:**
1. Claude Code CLI spawn → result 전체 루프가 E2E 검증된 적 없음
2. Task 완료 후 git commit/push/PR 파이프라인이 전혀 없음 (stub만 존재)
3. API 인증 완전 부재 — `Access-Control-Allow-Origin: *`, 미들웨어 없음
4. AI 응답이 무검증으로 goal/task로 승격 → 즉시 실행 (human-in-the-loop 없음)
5. 에이전트들이 같은 workdir에서 동시 작업 — 파일 충돌 무방비
6. 서버 크래시 시 in_progress 태스크 고착, subprocess 고아화

**전략적 위기 (EVALUATOR.md에서 이미 경고):**
> Paperclip이 Quality Gate를 추가하면 Nova의 차별점이 사라진다.
> 진짜 해자(moat)는: UX 압도적 차이 + Claude 네이티브 최적화 깊이 + 신뢰할 수 있는 안전장치

### 관련 자료
- 3관점 진단 결과: 이전 세션 대화 (2026-04-05)
- docs/EVALUATOR.md: 적대적 리뷰 (P1 위험: Paperclip 차별점 상실)
- docs/PROJECT.md: Phase 1 설계 원본
- docs/designs/autopilot-hierarchical-delegation.md: v0.2.0 설계

---

## Problem (문제 정의)

### 핵심 문제

**Solo Founder가 Crewdeck을 "믿고 쓸 수 있는" 수준이 아니다.** 코드를 생성하는 AI 에이전트가 검증 없이 실행되고, 결과물이 git에 안전하게 반영되지 않으며, 에이전트 간 작업 충돌 방지가 없고, 서버가 죽으면 복구할 수 없다.

### MECE 분해

| # | 문제 영역 | 설명 | 영향도 |
|---|----------|------|--------|
| 1 | **Trust Boundary 부재** | API 인증 없음, AI 응답 무검증 승격, dangerouslySkipPermissions 제어 없음. 동일 네트워크 공격자가 모든 API 호출 가능 | Critical |
| 2 | **E2E 동작 미검증** | Claude Code spawn → prompt → result → DB 저장 전체 루프가 실제로 테스트된 적 없음. "에이전트 실행" 클릭 → 아무것도 안 될 가능성 | Critical |
| 3 | **Git Workflow 단절** | createAgentBranch, createPullRequest가 정의만 되고 호출 안됨. Task 완료 후 코드가 git에 반영되는 경로가 없음 | Critical |
| 4 | **작업 격리 부재** | 모든 에이전트가 동일 workdir에서 작업. 동시 파일 수정 시 충돌. 2인 이상 관리 시 branch 충돌 | High |
| 5 | **복원력 부재** | 서버 크래시 시 in_progress 태스크 영구 고착. subprocess PID 미저장 → 고아 프로세스 API 비용 누수 | High |
| 6 | **Approval UX 부재** | Full Autopilot에서 사용자 승인 없이 task 즉시 실행. "이 task는 내가 확인하고 싶다" 설정 불가. 비용 추적 없음 | High |
| 7 | **차별화 해자 약화** | Quality Gate만으로는 Paperclip 대비 장기 차별점 불충분. Claude 네이티브 최적화, UX 차별화가 해자 | Medium |

### 제약 조건

- **기술적**: Claude Code CLI의 rate limit (Pro/Team 플랜별 차이), subprocess 동시 실행 수 제한
- **시간**: Solo founder 1인 개발 — 스프린트당 2-3일 이내로 완결 가능해야
- **호환성**: v0.2.0 DB 스키마와 하위 호환 유지 (마이그레이션 필요)
- **비즈니스**: Paperclip이 Quality Gate 추가 전에 차별화 해자를 확보해야

---

## Solution (해결 방안)

### 선택한 방안

**6개 스프린트로 분할하여, Safety → Resilience → Git → Isolation → Trust UX → Claude Native 순서로 구현한다.**

안전장치를 먼저 깔고(Sprint 1-2), 핵심 기능을 연결하고(Sprint 3-4), 전략적 차별화를 완성한다(Sprint 5-6).

### 대안 비교

| 기준 | A: Safety First (채택) | B: Feature First | C: UX First |
|------|----------------------|------------------|-------------|
| 사용자 신뢰 | 처음부터 안전 → 신뢰 축적 | 기능은 있지만 위험 노출 | 예쁘지만 위험 |
| Paperclip 대응 | 안전장치 = 차별점 강화 | Quality Gate만으로는 부족 | UX만으로는 기능 열위 |
| 개발 순서 합리성 | 기반(보안) → 기능 → UX 자연스러운 적층 | 기능 위에 보안 나중에 붙이기 어려움 | UX 위에 기능 끼워넣기 부자연스러움 |
| Solo Founder 체감 | Sprint 3부터 실질적 가치 (git workflow) | Sprint 1부터 가치 있으나 불안 | Sprint 1부터 예쁘지만 못 씀 |
| 선택 | **채택** | 기각 (보안 부채 누적) | 기각 (기능 없는 UX 무의미) |

### 구현 범위

- [ ] Sprint 1: Safety Foundation — API 인증, CORS 제한, 경로 검증, 권한 제어
- [ ] Sprint 2: Crash Recovery — 서버 복구 루틴, subprocess PID 추적, 상태 복원
- [ ] Sprint 3: Git Workflow — agent branch → commit → push → PR 파이프라인
- [ ] Sprint 4: Worktree Isolation — 에이전트별 git worktree 독립 작업 공간
- [ ] Sprint 5: Trust UX — Approval gate, 비용 추적, 검증 배지, 에러 메시지
- [ ] Sprint 6: Claude Native Moat — Session context chain, smart resume, 에이전트 메모리

### 검증 기준

1. **Safety**: 인증 없는 API 호출이 401로 거부됨. dangerouslySkipPermissions가 명시적 설정 없이 활성화 불가
2. **Recovery**: 서버 kill -9 후 재시작 → in_progress 태스크가 todo로 복원, 고아 프로세스 정리됨
3. **Git**: Task PASS → agent branch 생성 → commit → push → PR 자동 생성 (prMode=true일 때)
4. **Isolation**: 2개 에이전트 동시 실행 시 각각 독립 worktree에서 작업, 파일 충돌 없음
5. **Trust UX**: Task 실행 전 approval 요청 표시, PASS/FAIL 배지 표시, 에이전트별 비용 누적 표시
6. **Claude Native**: session resume 시 이전 context 유지, 에이전트 메모리로 프로젝트 학습 누적

---

## Sprints (스프린트 분할)

### Sprint 1: Safety Foundation

**목적**: Trust boundary 확립. "외부에서 뚫을 수 없다"

| 항목 | 내용 |
|------|------|
| 기능 단위 | API 인증 미들웨어, CORS 제한, workdir 경로 검증 통일, dangerouslySkipPermissions 제어, WebSocket 인증, env 상속 제한 |
| 예상 파일 | `server/api/middleware/auth.ts` (신규), `server/index.ts`, `server/api/websocket.ts`, `server/api/routes/projects.ts`, `server/core/agent/adapters/claude-code.ts`, `server/core/project/github.ts`, `shared/types.ts` |
| 의존성 | 없음 |
| Done 조건 | ① 인증 토큰 없는 API 호출 → 401 ② CORS origin이 localhost만 허용 ③ workdir 설정 시 homedir() 외 경로 거부 ④ dangerouslySkipPermissions 기본 false, 활성화 시 설정 파일 필수 ⑤ WebSocket 연결 시 토큰 검증 ⑥ subprocess에 허용된 env만 전달 |

**세부 태스크:**

1. **API 인증 미들웨어** (`server/api/middleware/auth.ts` 신규)
   - 서버 최초 시작 시 랜덤 API 키 생성 → `~/.crewdeck/api-key` 저장
   - 대시보드는 초기 로드 시 이 키를 받아서 이후 요청에 `Authorization: Bearer <key>` 헤더 포함
   - 모든 `/api/*` 라우트에 미들웨어 적용

2. **CORS 강화** (`server/index.ts`)
   - `Access-Control-Allow-Origin: *` → `http://localhost:5173, http://localhost:3000, http://127.0.0.1:*`
   - Preflight 요청 처리

3. **경로 검증 통일** (`server/api/routes/projects.ts`)
   - `/analyze`, `/import`에만 있는 homedir() 체크를 `/github`, `PATCH /projects/:id` workdir 업데이트에도 적용
   - `validateWorkdir()` 헬퍼 함수 추출

4. **dangerouslySkipPermissions 제어** (`server/core/agent/adapters/claude-code.ts`)
   - 기본값 `false` 하드코딩
   - 활성화하려면 `~/.crewdeck/config.json`에 `{"allowDangerousPermissions": true}` 명시 필수
   - 활성화 시 대시보드에 경고 배너

5. **WebSocket 인증** (`server/api/websocket.ts`)
   - 연결 시 `?token=<api-key>` 쿼리 파라미터 검증
   - 미인증 연결 즉시 close

6. **subprocess env 제한** (`server/core/agent/adapters/claude-code.ts`)
   - `process.env` 전체 상속 → 허용 목록(PATH, HOME, SHELL, ANTHROPIC_API_KEY 등)만 전달

---

### Sprint 2: Crash Recovery & Resilience

**목적**: "서버가 죽어도 상태가 복구된다"

| 항목 | 내용 |
|------|------|
| 기능 단위 | 서버 시작 시 상태 복구, subprocess PID DB 저장, 고아 프로세스 정리, in_progress → todo 복원, graceful shutdown |
| 예상 파일 | `server/index.ts`, `server/core/agent/session.ts`, `server/db/schema.ts`, `server/core/orchestration/scheduler.ts`, `server/core/recovery.ts` (신규) |
| 의존성 | Sprint 1 (인증 미들웨어가 서버 시작에 포함) |
| Done 조건 | ① 서버 kill -9 후 재시작 → in_progress 태스크가 todo로 복원 ② 고아 subprocess가 정리됨 (PID 기반 kill) ③ scheduler가 복원된 태스크를 재실행 ④ graceful shutdown 시 실행 중 세션에 중단 신호 |

**세부 태스크:**

1. **DB 스키마 확장** (`server/db/schema.ts`)
   - `sessions` 테이블에 `pid INTEGER` 컬럼 추가 (마이그레이션)
   - `tasks` 테이블에 `started_at TEXT` 컬럼 추가 (타임아웃 판별용)

2. **Recovery 모듈** (`server/core/recovery.ts` 신규)
   - `recoverOnStartup()`: 서버 시작 시 실행
     - `in_progress` 태스크 → `todo`로 복원
     - `sessions`에서 PID가 있는 레코드 → `process.kill(pid)` 시도 → 정리
     - `busyAgents` 맵 초기화
   - `pragma busy_timeout = 5000` 설정 (SQLite 동시 쓰기 안전)

3. **PID 추적** (`server/core/agent/session.ts`)
   - `spawnAgent()` 시 `proc.pid`를 `sessions` 테이블에 저장
   - `killSession()` 시 DB에서 PID 제거

4. **Graceful Shutdown** (`server/index.ts`)
   - `SIGINT`, `SIGTERM` 핸들러
   - 실행 중 세션에 `proc.kill('SIGTERM')` 전송
   - 5초 대기 후 강제 종료
   - `uncaughtException` 핸들러에서 상태 정보 DB에 기록

---

### Sprint 3: Git Workflow Pipeline

**목적**: "Task 완료 → 코드가 git에 안전하게 반영된다"

| 항목 | 내용 |
|------|------|
| 기능 단위 | Task PASS 후 자동 commit, agent branch 생성, push, PR 자동생성, autoPush/prMode 설정 연동 |
| 예상 파일 | `server/core/project/github.ts`, `server/core/orchestration/engine.ts`, `server/api/routes/orchestration.ts`, `server/core/project/git-workflow.ts` (신규), `dashboard/src/components/ProjectSettings.tsx`, `shared/types.ts` |
| 의존성 | Sprint 2 (crash recovery가 git 작업 중 실패 시 복구 보장) |
| Done 조건 | ① Task PASS → agent branch에 자동 commit ② prMode=true → `gh pr create` 자동 실행 ③ autoPush=true → main에 직접 push ④ git 실패 시 task를 blocked으로 전환 (데이터 유실 없음) ⑤ 대시보드에서 autoPush/prMode 토글이 실제 동작 |

**세부 태스크:**

1. **Git Workflow 모듈** (`server/core/project/git-workflow.ts` 신규)
   - `commitTaskResult(taskId)`: task의 변경 파일을 감지 → `git add` → `git commit -m "feat(agent): {task.title}"`
   - `pushBranch(workdir, branch)`: `git push origin {branch}`
   - `createPR(workdir, branch, title, body)`: `gh pr create` 실행
   - 모든 git 명령에 타임아웃 30초, 실패 시 structured error 반환

2. **Engine 통합** (`server/core/orchestration/engine.ts`)
   - `executeOne()` 파이프라인에 git workflow 단계 추가:
     ```
     Task 실행 → Quality Gate → PASS → Git Workflow → Done
                              → FAIL → Auto-fix or Blocked
     ```
   - project.github 설정에 따라 분기:
     - `prMode=true`: `createAgentBranch()` → commit → push → PR
     - `autoPush=true`: main에 commit → push
     - 둘 다 false: commit만 (로컬)

3. **기존 stub 연결** (`server/core/project/github.ts`)
   - `createAgentBranch()`, `createPullRequest()`를 git-workflow에서 호출
   - URL 정규화 강화 (SSRF 방지: hostname === 'github.com' 명시 검증)

4. **대시보드 연동** (`dashboard/src/components/ProjectSettings.tsx`)
   - autoPush, prMode 토글 → `PATCH /api/projects/:id` → 실제 github_config 업데이트

---

### Sprint 4: Worktree Isolation

**목적**: "에이전트가 서로의 작업을 방해하지 않는다"

| 항목 | 내용 |
|------|------|
| 기능 단위 | 에이전트별 git worktree 생성/정리, 작업 완료 후 worktree merge, 2인 이상 관리 시 branch 충돌 방지 |
| 예상 파일 | `server/core/project/worktree.ts` (신규), `server/core/agent/adapters/claude-code.ts`, `server/core/orchestration/engine.ts`, `server/core/project/git-workflow.ts`, `server/core/agent/session.ts` |
| 의존성 | Sprint 3 (git workflow가 worktree 기반으로 동작) |
| Done 조건 | ① 에이전트 실행 시 독립 worktree 생성 (`git worktree add`) ② 에이전트의 cwd가 worktree 경로 ③ Task 완료 후 worktree에서 commit → main으로 merge 가능 ④ 2개 에이전트 동시 실행 시 파일 충돌 없음 ⑤ 완료된 worktree 자동 정리 (`git worktree remove`) |

**세부 태스크:**

1. **Worktree 모듈** (`server/core/project/worktree.ts` 신규)
   - `createWorktree(projectWorkdir, agentName, taskSlug)`:
     - branch: `agent/{agentName}/{taskSlug}`
     - path: `{projectWorkdir}/.nova-worktrees/{agentName}-{taskSlug}`
     - `git worktree add {path} -b {branch}`
   - `removeWorktree(worktreePath)`:
     - `git worktree remove {path}`
     - branch 정리 (optional)
   - `listWorktrees(projectWorkdir)`: 현재 활성 worktree 목록

2. **Claude Code Adapter 수정** (`server/core/agent/adapters/claude-code.ts`)
   - `spawn()` 시 `cwd`를 project.workdir 대신 worktree 경로로 설정
   - worktree 경로를 session DB에 저장

3. **Engine 통합** (`server/core/orchestration/engine.ts`)
   - Task 시작 전: `createWorktree()` → worktree 경로 확보
   - Task 완료 후 (Git Workflow): worktree에서 commit → push → PR
   - Task 완료/실패 후: `removeWorktree()` 정리

4. **Git Workflow 수정** (`server/core/project/git-workflow.ts`)
   - `commitTaskResult()`가 worktree 경로에서 동작하도록 수정
   - merge 전략: PR 기반 (worktree branch → main PR 생성)

---

### Sprint 5: Trust UX — Approval Gate & Transparency

**목적**: "AI가 뭘 하는지 보이고, 내가 통제할 수 있다"

| 항목 | 내용 |
|------|------|
| 기능 단위 | Task 실행 전 approval 게이트, 비용 추적, 검증 배지, structured 에러 메시지, 에이전트 출력 실시간 표시 |
| 예상 파일 | `server/core/orchestration/engine.ts`, `server/core/orchestration/scheduler.ts`, `server/db/schema.ts`, `server/api/routes/orchestration.ts`, `dashboard/src/components/KanbanBoard.tsx`, `dashboard/src/components/TaskDetail.tsx`, `dashboard/src/components/ProjectHome.tsx`, `dashboard/src/components/AgentTerminal.tsx`, `dashboard/src/lib/api.ts` |
| 의존성 | Sprint 3 (git workflow 상태가 UX에 표시) |
| Done 조건 | ① Goal autopilot에서 task 생성 후 "pending_approval" 상태로 대기 (Full mode 포함) ② 대시보드에서 Approve/Reject 버튼 동작 ③ Task 카드에 PASS/FAIL/PENDING 배지 표시 ④ 에이전트별 세션 토큰 사용량 표시 ⑤ 에러 발생 시 "무엇이 실패했고, 어떻게 해야 하는지" 메시지 표시 |

**세부 태스크:**

1. **Approval Gate** (`server/core/orchestration/engine.ts`, `scheduler.ts`)
   - Task 상태에 `pending_approval` 추가
   - Goal decomposition 후 task를 `pending_approval`로 생성 (Full autopilot 포함)
   - `POST /api/orchestration/:projectId/tasks/:taskId/approve` 엔드포인트
   - `POST /api/orchestration/:projectId/tasks/:taskId/reject` 엔드포인트
   - Scheduler가 `pending_approval` 태스크는 skip

2. **비용 추적** (`server/db/schema.ts`, `server/core/agent/adapters/claude-code.ts`)
   - `sessions` 테이블에 `input_tokens INTEGER`, `output_tokens INTEGER` 추가
   - Claude Code stream-json 출력에서 usage 데이터 파싱
   - `GET /api/projects/:id/cost` → 에이전트별/goal별 비용 집계

3. **검증 배지** (`dashboard/src/components/KanbanBoard.tsx`, `TaskDetail.tsx`)
   - Task 카드에 verification 상태 배지: PASS(초록), FAIL(빨강), PENDING(회색)
   - TaskDetail에서 5차원 스코어 표시 (숫자, 레이더 차트는 Phase 3)

4. **에러 메시지 구조화** (`server/core/agent/adapters/claude-code.ts`)
   - error code + context + recovery suggestion 구조
   - 대시보드에 user-friendly 메시지 표시
   - 예: "에이전트 세션이 rate limit에 도달했습니다. 2분 후 자동 재시도합니다."

5. **에이전트 출력 실시간** (`dashboard/src/components/AgentTerminal.tsx`)
   - WebSocket `agent:output` 이벤트를 터미널 UI로 실시간 렌더링
   - 현재 실행 중인 에이전트의 stdout/stderr 스트리밍

---

### Sprint 6: Claude Native Moat — 전략적 차별화

**목적**: "Paperclip이 따라올 수 없는 Claude 네이티브 깊이"

| 항목 | 내용 |
|------|------|
| 기능 단위 | Session context chain (이전 태스크 맥락 유지), 에이전트 메모리 (프로젝트 학습 누적), smart resume (실패 지점부터 재개), 프로젝트 컨텍스트 자동 주입 |
| 예상 파일 | `server/core/agent/adapters/claude-code.ts`, `server/core/agent/session.ts`, `server/core/agent/memory.ts` (신규), `server/core/orchestration/engine.ts`, `server/db/schema.ts`, `templates/agents/*.yaml` |
| 의존성 | Sprint 4 (worktree 격리 위에서 에이전트 메모리 동작) |
| Done 조건 | ① 에이전트가 이전 태스크 결과를 참조하며 다음 태스크 수행 (session resume + context) ② 에이전트 메모리에 "이 프로젝트에서 배운 것" 누적 (`.crewdeck/memory/{agentId}.md`) ③ 실패한 태스크 재실행 시 이전 실패 원인을 프롬프트에 포함 ④ 프로젝트 기술 스택/아키텍처 정보가 에이전트 프롬프트에 자동 주입 |

**세부 태스크:**

1. **Session Context Chain** (`server/core/agent/session.ts`, `claude-code.ts`)
   - 태스크 완료 시 결과 요약을 DB에 저장 (`tasks.result_summary`)
   - 다음 태스크 실행 시 같은 에이전트의 최근 3개 태스크 결과를 system prompt에 주입
   - `--resume` 플래그로 Claude Code 세션 컨텍스트 유지 (Paperclip 패턴 심화)

2. **에이전트 메모리** (`server/core/agent/memory.ts` 신규)
   - 에이전트가 태스크 완료 시 "이 프로젝트에서 배운 것" 자동 추출
   - `.crewdeck/memory/{agentId}.md` 파일로 영속화
   - 다음 세션 시 메모리 파일을 `--add-dir`로 주입
   - 메모리 크기 제한 (최대 50KB, 오래된 것부터 정리)

3. **Smart Resume** (`server/core/orchestration/engine.ts`)
   - 실패한 태스크 재실행 시:
     - 이전 실패 원인 (`verification.issues`)을 프롬프트에 포함
     - "이전에 {issue}로 실패했습니다. 이번에는 이 점을 주의해서 수정하세요."
   - Auto-fix와 차별화: auto-fix는 즉시 재시도, smart resume은 컨텍스트가 풍부한 재시도

4. **프로젝트 컨텍스트 주입** (`server/core/agent/adapters/claude-code.ts`, `templates/agents/*.yaml`)
   - 에이전트 시스템 프롬프트에 자동 삽입:
     - 프로젝트 기술 스택 (`techStack`)
     - 디렉토리 구조 요약
     - 최근 git log (5개)
     - 팀 구성 정보 (OrgChart)
   - `--append-system-prompt-file`에 동적 컨텍스트 파일 생성

---

## 전체 스프린트 요약

| Sprint | 기능 단위 | 예상 파일 | 의존성 | Done 조건 |
|--------|----------|----------|--------|----------|
| 1 | Safety Foundation | auth.ts(신규), index.ts, websocket.ts, projects.ts, claude-code.ts, github.ts, types.ts | 없음 | 미인증 API 401, CORS localhost만, workdir 검증 통일, WS 인증 |
| 2 | Crash Recovery | index.ts, session.ts, schema.ts, scheduler.ts, recovery.ts(신규) | Sprint 1 | kill -9 후 재시작 → 태스크 복원, 고아 프로세스 정리 |
| 3 | Git Workflow | github.ts, engine.ts, orchestration.ts, git-workflow.ts(신규), ProjectSettings.tsx, types.ts | Sprint 2 | Task PASS → branch → commit → push → PR 자동 |
| 4 | Worktree Isolation | worktree.ts(신규), claude-code.ts, engine.ts, git-workflow.ts, session.ts | Sprint 3 | 에이전트별 독립 worktree, 동시 실행 충돌 없음 |
| 5 | Trust UX | engine.ts, scheduler.ts, schema.ts, orchestration.ts, KanbanBoard.tsx, TaskDetail.tsx, ProjectHome.tsx, AgentTerminal.tsx, api.ts | Sprint 3 | Approval gate, 비용 추적, 검증 배지, 에러 메시지 |
| 6 | Claude Native Moat | claude-code.ts, session.ts, memory.ts(신규), engine.ts, schema.ts, *.yaml | Sprint 4 | Context chain, 에이전트 메모리, smart resume |

---

## X-Verification (다관점 수집)

> 이 Plan은 3관점 종합 진단(Paperclip 비교, 완성도 갭, 적대적 보안 평가)의 결과를 기반으로 작성됨.
> 추가 교차검증이 필요한 설계 판단:

**Sprint 4 Worktree vs Branch-only 전략:**
- Worktree는 디스크 공간을 더 사용하지만 완전 격리 보장
- Branch-only는 가볍지만 checkout 시 충돌 위험
- → `/xv "에이전트 격리에 git worktree vs branch-only 중 어떤 전략이 적합한가?"` 권장

**Sprint 6 에이전트 메모리 전략:**
- 파일 기반 메모리 vs DB 기반 메모리
- Claude Code의 `--add-dir`로 주입 vs system prompt에 인라인
- → Design 단계에서 상세 결정

---

## Risk & Mitigation

| 위험 | 확률 | 영향 | 완화 |
|------|------|------|------|
| Claude Code CLI 버전 업데이트로 인자 변경 | 중 | High | adapter에 버전 감지 로직 추가, fallback 인자 세트 |
| git worktree가 대규모 repo에서 느림 | 중 | Medium | shallow worktree (`--depth 1`), SSD 전제 |
| Paperclip이 Phase 2 중 Quality Gate 출시 | 중 | High | Sprint 6(Claude Native Moat)을 차별화 핵심으로 |
| Solo founder가 Sprint 5 Approval에 피로감 | 낮 | Medium | "이 에이전트는 항상 자동 승인" 개별 설정 옵션 |
