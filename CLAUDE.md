@AGENTS.md

# Nova Orbit — Claude Code 운영 지침

공통 계약(언어/빌드/시크릿/Git)은 `AGENTS.md`에 있다. 이 파일은 Claude Code로 이 레포를 다룰 때의 라우팅 지도와 함정만 담는다.

## Architecture (라우팅용 진입점)

```
bin/nova-orbit.ts     → CLI entry (기본 127.0.0.1:7200, --port= / --no-open)
server/
  index.ts            → Express 5 + WebSocket, PID lock, bearer key 인증
  db/schema.ts        → SQLite 8 tables + 인라인 마이그레이션 (migrate() — 별도 migrate 파일 없음)
  api/routes/         → projects, agents, goals, tasks, sessions, verification, orchestration, activities
  core/
    agent/adapters/   → Claude Code CLI subprocess (stdin, --output-format stream-json, session resume)
    agent/session.ts  → spawn/kill/pause/resume + 컨텍스트 체인 주입
    agent/prompt-resolver.ts → 4-tier: custom → 대상 프로젝트 .claude/agents/*.md → templates preset → fallback
    orchestration/    → engine.ts (decompose→구현→검증→fix→git), scheduler.ts (autopilot, 기본 동시성 1)
    project/          → import/tech stack 분석, worktree 격리, git-workflow, GitHub 연동
    quality-gate/     → evaluator.ts — Generator-Evaluator 분리, 5-dimension 검증
    nova-rules/       → 런타임 주입 방법론 텍스트. sibling 레포 ../nova에서 `npm run sync:nova`로 복사 — 여기서 직접 편집 금지 (sync 시 덮어써짐)
shared/types.ts       → 도메인 타입 (⚠ AgentRole 유니온은 실제 role 목록과 드리프트 — docs/ROADMAP.md 참고)
dashboard/            → React + Tailwind v4 + Zustand, WebSocket 실시간 (~30 message types)
templates/agents/     → 9 role presets (cto, pm, backend, frontend, ux, qa, reviewer, devops, marketer)
```

설계 문서: `docs/design/` (최신 — goal-as-unit), `docs/designs/`·`docs/plans/` (초기), 실운영 검증 체크리스트: `docs/verification/goal-as-unit-e2e.md`.

## Key Design Decisions

- **SQLite** (not Postgres) — zero config, npx 친화. 런타임 데이터는 `.nova-orbit/` (gitignored — DB·api-key·pid).
- **Claude Code CLI subprocess** — API 키 불필요, 사용자 구독 재사용. Paperclip `claude_local` 패턴.
- **Generator-Evaluator 분리** — 구현과 검증은 항상 다른 세션.
- **Goal-as-Unit** — goal 단위 worktree, 완료 시 1 squash commit + 사용자 승인 게이트 (`docs/design/goal-as-unit.md`).
- **동시성 기본 1** — 품질 > wall-clock. `NOVA_MAX_CONCURRENCY` env로 override.
- **stream-json output** — `--output-format stream-json` 구조화 파싱 (`stream-parser.ts`, 테스트 완비).

## Smart Team Suggestion (3-layer)

1. 대상 프로젝트의 `.claude/agents/*.md` — 파일 = 에이전트, **최우선**
2. 대상 프로젝트의 `CLAUDE.md` — 각 에이전트 시스템 프롬프트에 컨텍스트 주입
3. `package.json` tech stack fallback — 1이 없을 때만

## Enforcement (hard guards — 실제 동작 중)

- `.claude/settings.json` deny — `.env*`, `.nova-orbit/**`, `*.db`, `*.pem` Write/Edit 차단
- `scripts/git-hooks/pre-commit` — 금지 파일 staged 차단 + TS 변경 시 typecheck 강제. `npm install` 시 `prepare`(`scripts/install-hooks.sh`)가 자동 링크
- `dashboard/eslint.config.js` — `window.confirm/alert/prompt` 사용 금지 (error 레벨)

## 경로별 규칙 (자동 로드)

- `dashboard/**` 작업 시 → `.claude/rules/dashboard-ui.md`, `.claude/rules/ux-terminology.md`
- `templates/agents/**` 작업 시 → `.claude/rules/agent-presets.md`
- 지침 파일(`CLAUDE.md`, `AGENTS.md`, `.claude/**` 등) 편집 시 → `.claude/rules/instruction-placement.md`

## Known Mistakes (재발 주의)

- **JSX 삼항 3단+ 중첩**: 괄호 불일치 빈번. 3단 이상은 IIFE `(() => { ... })()` 또는 별도 함수로 추출.
- **DB 직접 수정**: broadcast 누락으로 대시보드 미반영. 항상 API 경유 (`API_KEY=$(cat .nova-orbit/api-key)`).
- **spawn 전 emit**: `session.process`가 null인 상태에서 이벤트 emit하면 리스너가 데이터를 못 잡음. spawn 후 즉시 별도 이벤트로 전달.
- **Node 메이저 업그레이드**: `better-sqlite3` 네이티브 빌드가 깨진다. 업그레이드 전 지원 범위 확인 (2026-07: Node 26 ↔ better-sqlite3 ^12.11.1).

## 세션 마무리

굵직한 작업 세션을 마치면 `docs/ROADMAP.md`의 현재 상태·Known Gaps를 갱신한다 (사용자가 요청하기 전에 먼저 제안).
