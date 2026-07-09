# NOVA-ORBIT-PROJECT.md

> Crewdeck — AI 팀 오케스트레이션 + Quality Gate
> 1인 창업자/솔로 개발자를 위한 로컬 AI 팀 운영 도구

---

## 1. 프로젝트 비전

### 한 줄 요약

"혼자서도 팀처럼 빌드하라" — Claude Code 세션을 에이전트로 편성하고, 목표 기반으로 오케스트레이션하며, Nova Quality Gate로 결과물을 독립 검증하는 로컬 설치형 도구.

### 핵심 차별점 (vs Paperclip)

| 비교 축         | Paperclip                           | Crewdeck                               |
| --------------- | ----------------------------------- | ---------------------------------------- |
| 품질 관리       | ❌ 없음                             | ✅ Generator-Evaluator 분리, 5차원 검증  |
| 설정 난이도     | Postgres 설정 + onboarding 위자드   | `npx crewdeck` 한 줄 (SQLite 내장)     |
| 에이전트 런타임 | 아무거나 (Claude, Codex, HTTP...)   | Claude Code 세션 네이티브 최적화         |
| UX              | 기능 중심 대시보드                  | Notion 스타일 직관적 인터페이스          |
| 타겟            | "autonomous company" (20+ 에이전트) | 1인 창업자 (3-7 에이전트)                |
| 비용 구조       | API 키 직접 입력                    | Claude Pro/Team 구독 세션 활용 ($0 추가) |

### 사용자 시나리오

**시나리오 A: 새 프로젝트 시작**

```
1. 사용자는 Claude Pro 구독 중이고, Claude Code CLI가 설치되어 있다.
2. `npx crewdeck` 실행 → localhost:3000 대시보드 열림.
3. "새 프로젝트" 생성 → "SaaS MVP 빌드"
4. 에이전트 편성:
   - Coder (백엔드 구현)
   - Reviewer (코드 리뷰 + QA)
   - Marketer (랜딩페이지 + 콘텐츠)
5. 목표 설정: "MVP를 2주 안에 배포"
6. 대시보드에서 각 에이전트의 태스크 진행 확인.
7. Coder가 구현 → Nova Quality Gate가 자동 검증 → PASS/FAIL.
8. 사용자는 대시보드에서 승인/수정 지시.
9. 모든 커밋은 검증 통과 후에만 허용.
```

**시나리오 B: 기존 로컬 프로젝트 임포트**

```
1. 대시보드에서 "Import Project" 클릭
2. 로컬 디렉토리 경로 입력 (예: ~/projects/my-saas)
3. Crewdeck이 코드베이스를 자동 분석:
   - 기술 스택 감지 (package.json, build.gradle 등)
   - 디렉토리 구조 파악
   - 기존 README/문서 스캔
4. 분석 결과 기반으로 적합한 에이전트 구성 자동 제안
5. 사용자 승인 후 에이전트 편성 완료
6. 이후 에이전트는 해당 디렉토리를 workdir로 사용
```

**시나리오 C: GitHub 레포 연결**

```
1. 대시보드에서 "Connect GitHub" 클릭
2. GitHub repo URL 입력 (예: https://github.com/user/my-saas)
3. 로컬에 자동 clone
4. 시나리오 B와 동일하게 코드베이스 분석 + 에이전트 제안
5. 추가 기능:
   - 에이전트 커밋을 자동 push (설정에 따라)
   - PR 자동 생성 (에이전트별 브랜치)
   - Issue 연동 (GitHub Issue → Crewdeck Task 동기화)
```

### 멀티 프로젝트 지원

사용자는 여러 프로젝트를 동시에 운영할 수 있다.
각 프로젝트는 독립된 에이전트 세트, 목표, 태스크, 워크스페이스를 가진다.

```
Dashboard Sidebar:
├── 📁 Project: "My SaaS MVP"        (로컬 ~/projects/my-saas)
├── 📁 Project: "Blog Platform"      (GitHub: user/blog)
├── 📁 Project: "Landing Page"       (새로 생성)
└── ➕ New Project / Import / Connect GitHub
```

**수익 모델 적용 (검토 필요):**

- Free: 프로젝트 1개, 에이전트 3개
- Pro: 프로젝트 무제한, 에이전트 무제한
- 참고: 프로젝트 제한 수는 베타 유저 피드백 후 결정. 초기에는 제한 없이 오픈하고, 유료 전환 시 제한을 두는 것도 전략.

---

## 2. 기술 아키텍처

### 전체 구조

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│            localhost:3000 (Dashboard)             │
│   ┌─────────────────────────────────────────┐   │
│   │         Notion-style UI (React)          │   │
│   │  Projects | Agents | Tasks | Logs | Hub  │   │
│   └─────────────────┬───────────────────────┘   │
└─────────────────────┼───────────────────────────┘
                      │ WebSocket + REST
┌─────────────────────┼───────────────────────────┐
│              Crewdeck Server (Node.js)           │
│                                                   │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │
│  │Orchestr- │  │ Nova     │  │ Agent          │  │
│  │ation     │  │ Quality  │  │ Session        │  │
│  │Engine    │  │ Gate     │  │ Manager        │  │
│  │          │  │          │  │                │  │
│  │목표→태스크 │  │Gen-Eval  │  │Claude Code     │  │
│  │분해/할당  │  │5차원검증  │  │세션 생성/관리   │  │
│  └─────────┘  └──────────┘  └───────┬────────┘  │
│                                      │           │
│  ┌──────────────────────────────────┘           │
│  │                                               │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │  │Session #1│ │Session #2│ │Session #3│     │
│  │  │ Coder    │ │ Reviewer │ │ Marketer │     │
│  │  │(claude   │ │(claude   │ │(claude   │     │
│  │  │ code)    │ │ code)    │ │ code)    │     │
│  │  └──────────┘ └──────────┘ └──────────┘     │
│  │                                               │
│  ├─ SQLite (프로젝트/에이전트/태스크/로그 저장)     │
│  └─ File System (워크스페이스, 코드, 아티팩트)      │
└─────────────────────────────────────────────────┘
```

### 기술 스택

| 레이어        | 기술                           | 이유                                         |
| ------------- | ------------------------------ | -------------------------------------------- |
| **Frontend**  | React + TailwindCSS            | Notion 스타일 UI, 빠른 개발                  |
| **Backend**   | Node.js (TypeScript)           | Claude Code 생태계 호환, Paperclip 참조 용이 |
| **DB**        | SQLite (better-sqlite3)        | 설치 시 별도 DB 설정 불필요, 파일 하나       |
| **실시간**    | WebSocket (ws)                 | 에이전트 진행 상황 실시간 스트리밍           |
| **에이전트**  | Claude Code CLI (서브프로세스) | 사용자 기존 구독 활용, $0 추가 비용          |
| **검증 엔진** | Nova Core (포팅)               | CPS + Generator-Evaluator 로직               |
| **패키지**    | npx 배포                       | 설치 한 줄로 완료                            |

### Paperclip 오픈소스 참조 포인트

> 저장소: https://github.com/paperclipai/paperclip (MIT License)

### Paperclip 소스 분석 결과 (검증 완료)

> 저장소: https://github.com/paperclipai/paperclip (MIT License)
> **핵심 발견: Claude Code CLI를 서브프로세스로 제어하는 것은 Paperclip이 프로덕션에서 검증한 패턴이다.**

**claude_local 어댑터 동작 방식:**

```json
{
  "adapterType": "process",
  "adapter": "claude_local",
  "model": "claude-sonnet-4-20250514",
  "sessionBehavior": "resume-or-new",
  "heartbeatSchedule": { "enabled": true, "intervalSec": 1800 }
}
```

- Claude Code를 child_process.spawn으로 서브프로세스 실행
- stdin/stdout(stdio) 파이프로 태스크 전달/결과 수신
- `--add-dir` 플래그로 스킬 파일을 에이전트에 주입 (임시 디렉토리 + 심볼릭 링크)
- `sessionBehavior: "resume-or-new"`로 하트비트 간 세션 컨텍스트 유지
- 개발 환경에서는 PGlite(내장 Postgres) 사용 (DATABASE_URL 미설정 시 자동)

**참조해야 할 파일/디렉토리:**

| 경로                                | 참조 목적                                | Crewdeck 적용                                |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `packages/adapters/` (claude_local) | Claude Code spawn, stdio 통신            | 핵심 어댑터 재구현                             |
| `packages/adapter-utils/`           | 세션 관리, 에러 핸들링 공통 로직         | 유틸리티 참조                                  |
| `--add-dir` 스킬 주입 방식          | 에이전트에 컨텍스트 전달 메커니즘        | Nova Quality Gate 규칙 주입에 활용             |
| `sessionBehavior` 구현              | 세션 영속성, resume 로직                 | 에이전트 재시작 시 상태 복원                   |
| PGlite 내장 DB 패턴                 | 설치 시 DB 설정 불필요                   | SQLite 또는 PGlite로 동일 패턴 적용            |
| `server/`                           | Express REST API + 오케스트레이션 서비스 | 서버 구조 참조                                 |
| `ui/`                               | React + Vite 대시보드                    | UX는 참조하지 않음 (Notion 스타일로 새로 설계) |
| `packages/db/`                      | Drizzle 스키마, 마이그레이션             | 스키마 구조 참조 후 SQLite로 변환              |
| `packages/shared/`                  | 공유 타입, 상수, 밸리데이터              | 타입 설계 참조                                 |
| `.agents/skills/` + `skills/`       | 에이전트 스킬 정의 구조                  | Nova 에이전트 템플릿 시스템에 활용             |

**참조하지 말아야 할 부분 (차별화):**

- Postgres 의존성 → SQLite 또는 PGlite로 대체
- 복잡한 멀티 에이전트 런타임 (Codex, Cursor, HTTP 등) → Claude Code 세션 전용으로 단순화
- UX/UI 전체 → Notion 스타일로 새로 설계
- 멀티 런타임 어댑터 추상화 → Claude 전용이므로 어댑터 레이어 대폭 간소화

---

## 3. 핵심 모듈 설계

### 3.1 Agent Session Manager

Claude Code CLI를 서브프로세스로 생성하고 관리하는 모듈.
**Paperclip의 claude_local 어댑터가 이 패턴을 프로덕션에서 검증함.**

```typescript
interface AgentSession {
  id: string;
  role: AgentRole; // 'coder' | 'reviewer' | 'marketer' | 'designer' | 'qa' | 'custom'
  status: SessionStatus; // 'idle' | 'working' | 'waiting_approval' | 'paused'
  process: ChildProcess; // Claude Code CLI 서브프로세스
  workdir: string; // 에이전트별 작업 디렉토리
  systemPrompt: string; // 역할별 시스템 프롬프트
  skillsDir: string; // --add-dir로 주입할 스킬 디렉토리 (심볼릭 링크)
  sessionBehavior: "resume-or-new" | "new"; // Paperclip 패턴 참조
  currentTask: Task | null;
  costTracker: CostTracker;
}

// Claude Code 세션 생성 (Paperclip claude_local 어댑터 패턴 기반)
function spawnAgent(config: AgentConfig): AgentSession {
  // 1. 임시 디렉토리 생성, Nova 스킬/규칙 심볼릭 링크
  // 2. claude code CLI를 child_process.spawn으로 실행
  //    - --add-dir 플래그로 스킬 디렉토리 전달
  //    - stdin/stdout 파이프로 명령 전달/결과 수신
  // 3. 에이전트 역할에 맞는 시스템 프롬프트 + Nova Quality Gate 규칙 주입
  // 4. sessionBehavior에 따라 기존 세션 resume 또는 새 세션 생성
  // 5. 세션 상태를 DB에 영속화 (재시작 시 복원)
}
```

**핵심 동작:**

- Paperclip의 `--add-dir` 패턴 활용: Nova Quality Gate 규칙을 스킬 파일로 에이전트에 주입
- 세션 영속성: `resume-or-new`로 하트비트/재시작 시 컨텍스트 유지
- 비용 추적: 세션별 토큰 사용량 추정
- Generator-Evaluator 분리: 구현 에이전트와 검증 에이전트는 반드시 다른 세션으로 spawn

### 3.2 Project Manager

프로젝트 생성/임포트/GitHub 연결을 관리하는 모듈.

```typescript
interface Project {
  id: string;
  name: string;
  mission: string; // "Build MVP of note-taking SaaS"
  source: ProjectSource; // 'new' | 'local_import' | 'github'
  workdir: string; // 로컬 작업 디렉토리 경로
  github?: {
    repoUrl: string;
    branch: string;
    autoPush: boolean; // 에이전트 커밋 자동 push 여부
    prMode: boolean; // PR 자동 생성 모드
  };
  techStack?: TechStack; // 자동 감지된 기술 스택
  agents: AgentSession[];
  goals: Goal[];
  status: ProjectStatus;
}

// 로컬 프로젝트 임포트
async function importLocalProject(dirPath: string): Promise<Project> {
  // 1. 디렉토리 존재 확인
  // 2. 코드베이스 자동 분석 (package.json, build.gradle 등)
  // 3. 기술 스택 감지
  // 4. 적합한 에이전트 구성 자동 제안
  // 5. Project 생성 + workdir 설정
}

// GitHub 레포 연결
async function connectGitHub(repoUrl: string): Promise<Project> {
  // 1. 로컬에 clone
  // 2. importLocalProject와 동일한 분석 실행
  // 3. GitHub remote 설정 유지
  // 4. 에이전트 브랜치 전략 설정
}
```

### 3.3 Orchestration Engine

목표 → 프로젝트 → 태스크 → 에이전트 할당 흐름.

```typescript
interface Goal {
  id: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  tasks: Task[];
  progress: number; // 0-100
}

interface Task {
  id: string;
  goalId: string;
  title: string;
  description: string;
  assignee: AgentSession;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked";
  verificationResult?: VerificationResult; // Nova Quality Gate 결과
}
```

**흐름:**

1. 사용자가 Goal 생성 ("인증 시스템 구현")
2. Orchestration Engine이 Goal → Task 분해 (AI 활용)
3. 각 Task를 적합한 에이전트에 할당
4. 에이전트 실행 → 결과물 생성
5. Nova Quality Gate 검증
6. PASS → done, FAIL → 수정 요청 (자동 또는 수동)

### 3.3 Nova Quality Gate (기존 Nova 로직 포팅)

```typescript
interface VerificationResult {
  pass: boolean;
  dimensions: {
    functionality: Score; // 기능 요구사항 일치
    dataFlow: Score; // 데이터 관통 완전성
    designAlignment: Score; // 설계 정합성
    craft: Score; // 에러 핸들링, 타입 안전성
    edgeCases: Score; // 경계값 안전성
  };
  issues: Issue[]; // 발견된 문제 목록
  severity: "pass" | "soft-block" | "hard-block";
}

// Generator-Evaluator 분리
// Task 실행 에이전트와 검증 에이전트는 항상 다른 세션
async function verify(task: Task, implementation: string): Promise<VerificationResult> {
  // 1. Evaluator 세션 생성 (실행 에이전트와 별도)
  // 2. 5차원 검증 실행
  // 3. Hard-Block 시 즉시 중단
  // 4. 결과를 대시보드에 실시간 표시
}
```

---

## 4. UX 설계 방향

### Notion 스타일 핵심 원칙

1. **왼쪽 사이드바 네비게이션** — 프로젝트/에이전트/태스크 트리 구조
2. **블록 기반 콘텐츠** — 태스크, 로그, 검증 결과가 각각 블록
3. **인라인 편집** — 클릭하면 바로 편집 가능
4. **드래그 앤 드롭** — 태스크 순서/할당 변경
5. **실시간 업데이트** — 에이전트 진행 상황 라이브 스트리밍
6. **미니멀 컬러** — 흰 배경 + 회색 텍스트 + 포인트 컬러 최소화
7. **커맨드 팔레트** — Cmd+K로 빠른 액션 (Notion처럼)

### 대시보드 페이지 구성

```
Sidebar (좌측)
├── 🏠 Home (프로젝트 리스트)
├── 📁 Project: "My SaaS MVP"
│   ├── 🎯 Goals
│   ├── 👥 Agents
│   ├── ✅ Tasks (Kanban or List)
│   ├── 📋 Verification Log
│   └── 💰 Cost Dashboard
├── 📁 Project: "Blog Automation"
│   └── ...
├── 🏪 Hub (템플릿 마켓)
└── ⚙️ Settings
```

### 주요 화면

**1. 프로젝트 홈**

- 미션 표시
- 에이전트 카드 (이름, 역할, 상태, 현재 태스크)
- 목표별 진행률 바
- 최근 활동 피드

**2. 에이전트 상세**

- 에이전트 프로필 (역할, 스킬, 시스템 프롬프트)
- 현재 세션 상태 (실시간 터미널 출력 미리보기)
- 태스크 히스토리
- 검증 통과율 차트
- 비용 누적 그래프

**3. 태스크 보드 (Kanban)**

- Todo | In Progress | In Review | Done | Blocked
- 각 카드에 에이전트 아바타, 검증 상태 배지
- 드래그로 상태 변경
- 클릭 시 상세 (에이전트 대화 로그, 검증 결과, 코드 diff)

**4. 검증 로그**

- 타임라인 뷰
- 각 검증 결과: 5차원 스코어 레이더 차트
- Hard-Block 이슈 빨간 배지 강조
- "Fix" 버튼 → 해당 에이전트에 수정 태스크 자동 생성

---

## 5. Phase 1 구현 범위 (MVP)

### 포함

- [ ] `npx crewdeck` 설치 + 초기 설정
- [ ] SQLite 자동 생성
- [ ] 프로젝트 CRUD (새로 생성 + 로컬 임포트 + GitHub 연결)
- [ ] 코드베이스 자동 분석 (임포트 시 기술 스택 감지 + 에이전트 제안)
- [ ] 에이전트 생성 (Claude Code 세션 spawn)
- [ ] 에이전트에 태스크 할당 + 실행
- [ ] Nova Quality Gate 검증 (Standard 레벨)
- [ ] 대시보드 기본 UI (프로젝트 홈 + 태스크 보드 + 에이전트 상태)
- [ ] 멀티 프로젝트 사이드바 (여러 프로젝트 전환)
- [ ] 실시간 진행 상황 WebSocket 스트리밍

### 미포함 (Phase 2+)

- [ ] Pro 라이센스 시스템
- [ ] Nova Hub (템플릿 마켓)
- [ ] Cloud Sync
- [ ] 하트비트 (스케줄 기반 자동 실행)
- [ ] 멀티 프로젝트
- [ ] 비용 추적 대시보드
- [ ] 커맨드 팔레트 (Cmd+K)
- [ ] Jury Mode (/nova:xv 멀티 AI)

---

## 6. 디렉토리 구조 (초안)

```
crewdeck/
├── package.json
├── bin/
│   └── crewdeck.ts          # npx 진입점, onboarding
├── server/
│   ├── index.ts              # Express/Fastify 서버
│   ├── db/
│   │   ├── schema.ts         # SQLite 스키마
│   │   └── migrations/
│   ├── core/
│   │   ├── orchestration/
│   │   │   ├── engine.ts     # 목표→태스크 분해, 할당
│   │   │   ├── scheduler.ts  # 태스크 큐, 우선순위
│   │   │   └── governance.ts # 승인 게이트
│   │   ├── project/
│   │   │   ├── project.ts    # 프로젝트 CRUD
│   │   │   ├── importer.ts   # 로컬 프로젝트 임포트 + 코드베이스 분석
│   │   │   ├── github.ts     # GitHub 연결, clone, push, PR
│   │   │   ├── analyzer.ts   # 기술 스택 자동 감지 + 에이전트 제안
│   │   │   ├── goal.ts
│   │   │   └── task.ts
│   │   ├── agent/
│   │   │   ├── session.ts    # Claude Code 세션 관리
│   │   │   ├── roles.ts      # 역할별 프리셋
│   │   │   └── adapters/
│   │   │       └── claude-code.ts  # Claude Code CLI 어댑터
│   │   ├── quality-gate/
│   │   │   ├── evaluator.ts  # Generator-Evaluator 분리
│   │   │   ├── dimensions.ts # 5차원 검증 기준
│   │   │   └── severity.ts   # Auto-Resolve/Soft/Hard Block
│   │   └── quality-gate/
│   │       ├── evaluator.ts  # Generator-Evaluator 분리
│   │       ├── dimensions.ts # 5차원 검증 기준
│   │       └── severity.ts   # Auto-Resolve/Soft/Hard Block
│   ├── api/
│   │   ├── routes/
│   │   │   ├── projects.ts
│   │   │   ├── agents.ts
│   │   │   ├── tasks.ts
│   │   │   └── verification.ts
│   │   └── websocket.ts      # 실시간 스트리밍
│   └── utils/
│       ├── cost-tracker.ts
│       └── logger.ts
├── dashboard/                 # React 프론트엔드
│   ├── src/
│   │   ├── components/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── ProjectHome.tsx
│   │   │   ├── AgentCard.tsx
│   │   │   ├── TaskBoard.tsx  # Kanban
│   │   │   ├── VerificationLog.tsx
│   │   │   └── Terminal.tsx   # 에이전트 세션 미리보기
│   │   ├── hooks/
│   │   │   └── useWebSocket.ts
│   │   ├── stores/            # Zustand
│   │   └── App.tsx
│   └── tailwind.config.ts
├── templates/                 # 에이전트/프로젝트 기본 템플릿
│   ├── agents/
│   │   ├── coder.yaml
│   │   ├── reviewer.yaml
│   │   ├── marketer.yaml
│   │   └── designer.yaml
│   └── projects/
│       ├── saas-mvp.yaml
│       └── blog-automation.yaml
└── docs/
    ├── architecture.md
    ├── paperclip-reference.md  # Paperclip 코드 참조 가이드
    └── ux-spec.md
```

---

## 7. Paperclip 코드 분석 가이드

> 이 섹션은 에이전트가 Paperclip 소스를 분석할 때 참조하는 가이드입니다.

### 분석 우선순위

1. **`package.json`의 `bin` 필드와 onboarding 스크립트**
   - npx 실행 방식, 초기 설정 플로우 이해
   - 우리도 동일한 패턴 사용

2. **에이전트 어댑터 패턴 (`src/adapters/`)**
   - Paperclip이 다양한 에이전트를 어떻게 추상화하는지
   - 우리는 Claude Code 전용이므로 단순화 가능

3. **태스크 체크아웃 로직 (`src/core/orchestration/`)**
   - 원자적 실행 보장 방법
   - 동시 실행 시 충돌 방지 패턴

4. **하트비트 시스템 (`src/core/heartbeat/`)**
   - 에이전트 스케줄 실행 패턴
   - Phase 2에서 참조

5. **거버넌스 (`src/core/governance/`)**
   - 승인 게이트 구현 방식
   - 롤백 메커니즘

### 분석 시 주의

- Paperclip은 Postgres 의존 → 우리는 SQLite, 스키마 변환 필요
- Paperclip은 멀티 에이전트 런타임 → 우리는 Claude Code 전용, 복잡도 대폭 축소
- Paperclip의 UI 코드는 참조하지 않음 → Notion 스타일로 새로 설계
- MIT 라이선스이므로 코드 참조/수정 자유로움, 단 Attribution 필요

---

## 8. 에이전트 역할 프리셋 (기본 제공)

```yaml
# templates/agents/coder.yaml
name: Coder
role: coder
description: "백엔드/프론트엔드 코드를 구현합니다."
systemPrompt: |
  당신은 시니어 소프트웨어 엔지니어입니다.
  할당된 태스크의 코드를 구현하세요.
  구현 전 반드시 기존 코드베이스를 분석하세요.
  커밋 전 lint/type-check를 통과시키세요.
capabilities:
  - code_write
  - file_read
  - terminal_execute
verificationLevel: standard # Nova Quality Gate 레벨

---
# templates/agents/reviewer.yaml
name: Reviewer
role: reviewer
description: "코드 리뷰와 품질 검증을 수행합니다."
systemPrompt: |
  당신은 코드 리뷰어입니다.
  "통과시키지 마라, 문제를 찾아라" — 적대적 자세로 검증하세요.
  Nova의 5차원 검증 기준을 적용하세요:
  기능, 데이터 관통, 설계 정합성, 크래프트, 경계값.
capabilities:
  - code_read
  - file_read
verificationLevel: full

---
# templates/agents/marketer.yaml
name: Marketer
role: marketer
description: "랜딩페이지, 블로그 포스트, SNS 콘텐츠를 작성합니다."
systemPrompt: |
  당신은 그로스 마케터입니다.
  SEO 최적화된 콘텐츠를 작성하세요.
  타겟 오디언스와 핵심 메시지를 항상 의식하세요.
capabilities:
  - code_write
  - file_read
verificationLevel: lite
```

---

## 9. 수익 모델 요약

| Stream          | 내용                                           | 가격                              | Phase |
| --------------- | ---------------------------------------------- | --------------------------------- | ----- |
| **Core (무료)** | 에이전트 3개, 프로젝트 1개, Standard 검증      | $0                                | 1     |
| **Pro Key**     | 무제한 에이전트/프로젝트, Full 검증, Jury Mode | $19/월 or $149/년                 | 2     |
| **Nova Hub**    | 에이전트/프로젝트 템플릿 마켓                  | $5-29/템플릿, 커뮤니티 30% 수수료 | 3     |
| **Cloud Sync**  | 기기 간 동기화, 웹 대시보드, 팀 공유           | $9/월 (Pro 추가)                  | 4     |
