@AGENTS.md

# Crewdeck — Claude Code 운영 지침

공통 계약(언어/빌드/시크릿/Git)은 `AGENTS.md`에 있다. 이 파일은 Claude Code로 이 레포를 다룰 때의 라우팅 지도와 함정만 담는다.

## Architecture (라우팅용 진입점)

```
bin/crewdeck.ts     → CLI entry (기본 127.0.0.1:7200, --port= / --no-open)
server/
  index.ts            → Express 5 + WebSocket, PID lock, bearer key 인증
  db/schema.ts        → SQLite 8 tables + 인라인 마이그레이션 (migrate() — 별도 migrate 파일 없음)
  api/routes/         → projects, agents, goals, tasks, sessions, verification, orchestration, activities
  core/
    agent/adapters/   → backend.ts(AgentBackend 추상화·getBackend) + claude-code.ts + codex.ts(codex exec --json) + stream-parser·codex-stream-parser (parseAgentOutput 라우팅)
    agent/provider.ts → resolveProvider(agent→project→전역) + loadProviderConfig(~/.crewdeck/config.json)
    agent/failover.ts → decideFailover — 한도/소진/env 오류 시 대체 백엔드 재디스패치 결정
    agent/session.ts  → spawn/kill/pause/resume + 컨텍스트 체인 주입
    agent/prompt-resolver.ts → 4-tier: custom → 대상 프로젝트 .claude/agents/*.md → templates preset → fallback
    orchestration/    → engine.ts (decompose→구현→검증→fix→git), scheduler.ts (autopilot, 기본 동시성 1)
    project/          → import/tech stack 분석, worktree 격리, git-workflow, GitHub 연동
    quality-gate/     → evaluator.ts — Generator-Evaluator 분리, 5-dimension 검증
    methodology/       → 런타임 주입 방법론 텍스트 — Crewdeck 소유, 직접 편집 (sync 기계장치 없음)
shared/types.ts       → 도메인 타입 (⚠ AgentRole 유니온은 실제 role 목록과 드리프트)
dashboard/            → React + Tailwind v4 + Zustand, WebSocket 실시간 (~30 message types)
templates/agents/     → 9 role presets (cto, pm, backend, frontend, ux, qa, reviewer, devops, marketer)
```

설계 문서: `docs/design/` (goal-as-unit 등 현행 설계), 실운영 검증 체크리스트: `docs/verification/goal-as-unit-e2e.md`.

## Key Design Decisions

- **SQLite** (not Postgres) — zero config, npx 친화. 런타임 데이터는 `.crewdeck/` (gitignored — DB·api-key·pid).
- **Claude Code CLI subprocess** — API 키 불필요, 사용자 구독 재사용. Paperclip `claude_local` 패턴.
- **Generator-Evaluator 분리** — 구현과 검증은 항상 다른 세션.
- **Goal-as-Unit** — goal 단위 worktree, 완료 시 1 squash commit + 사용자 승인 게이트 (`docs/design/goal-as-unit.md`).
- **동시성 = goal 간 병렬 (기본 2), goal 내부는 항상 순차 1** — goal 간은 worktree 격리로 안전, goal 내 병렬은 맥락 엇갈림 위험(품질 > wall-clock). 다음 goal spec/decompose는 lookahead 1개까지 선행. `CREWDECK_MAX_CONCURRENCY` env로 override.
- **stream-json output** — `--output-format stream-json` 구조화 파싱 (`stream-parser.ts`, 테스트 완비).
- **멀티 백엔드 (Claude / Codex)** — `AgentBackend` 추상화로 두 CLI를 같은 세션 계약으로 실행. provider 해석 = agent.provider → project.default_provider → 전역 기본(claude). **자동 failover**: 실행 세션이 rate_limit/session_exhausted/env_error로 실패하면 scheduler가 같은 태스크를 대체 백엔드로 즉시 재디스패치(쿨다운 대기 대신, 루프 가드로 왕복 차단). 수동 지정·failover는 config `codexFailover`(기본 true). 실행 중 healthy 세션은 안 죽임(provider는 spawn 시점 해석). Codex는 `codex exec --json`, 시스템프롬프트 stdin prepend, cost 미보고.

## Smart Team Suggestion (3-layer)

1. 대상 프로젝트의 `.claude/agents/*.md` — 파일 = 에이전트, **최우선**
2. 대상 프로젝트의 `CLAUDE.md` — 각 에이전트 시스템 프롬프트에 컨텍스트 주입
3. `package.json` tech stack fallback — 1이 없을 때만

## Enforcement (hard guards — 실제 동작 중)

- `.claude/settings.json` deny — `.env*`, `.crewdeck/**`, `*.db`, `*.pem` Write/Edit 차단
- `scripts/git-hooks/pre-commit` — 금지 파일 staged 차단 + TS 변경 시 typecheck 강제. `npm install` 시 `prepare`(`scripts/install-hooks.sh`)가 자동 링크
- `dashboard/eslint.config.js` — `window.confirm/alert/prompt` 사용 금지 (error 레벨)

## 경로별 규칙 (자동 로드)

- `dashboard/**` 작업 시 → `.claude/rules/dashboard-ui.md`, `.claude/rules/ux-terminology.md`
- `templates/agents/**` 작업 시 → `.claude/rules/agent-presets.md`
- 지침 파일(`CLAUDE.md`, `AGENTS.md`, `.claude/**` 등) 편집 시 → `.claude/rules/instruction-placement.md`

## Known Mistakes (재발 주의)

- **JSX 삼항 3단+ 중첩**: 괄호 불일치 빈번. 3단 이상은 IIFE `(() => { ... })()` 또는 별도 함수로 추출.
- **DB 직접 수정**: broadcast 누락으로 대시보드 미반영. 항상 API 경유 (`API_KEY=$(cat .crewdeck/api-key)`).
- **spawn 전 emit**: `session.process`가 null인 상태에서 이벤트 emit하면 리스너가 데이터를 못 잡음. spawn 후 즉시 별도 이벤트로 전달.
- **Node 메이저 업그레이드**: `better-sqlite3` 네이티브 빌드가 깨진다. 업그레이드 전 지원 범위 확인 (2026-07: Node 26 ↔ better-sqlite3 ^12.11.1).
- **`npm run build:server` 단독 실행 금지**: tsup `clean:true`가 dist 전체를 비우는데 postbuild(dashboard·methodology 복사)는 `build`에서만 실행된다 → 서빙 중인 dist/dashboard가 증발. 항상 `npm run build` 전체 실행.
- **drain 없이 서비스 재시작 금지**: 실행 중 에이전트 세션이 SIGTERM(exit 143)으로 죽는다. 절차 = 큐 정지 → activeTasks=0 대기 → 빌드 → restart → 큐 재가동. 대시보드만 변경 시 `npm run build:dashboard`(루트에서)로 무중단.
- **병렬 Claude 세션 + main 직접 작업 = 유실**: 여러 세션이 같은 main 체크아웃을 동시에 편집하면 한 세션의 `git restore`/빌드가 다른 세션의 uncommitted 변경을 덮는다(실측됨). 여러 세션 병렬 시 세션마다 `git worktree`로 격리하고, 라이브 서비스 build/restart는 한 세션만 소유한다 — 상세는 `AGENTS.md` §Parallel Git Workflow.
