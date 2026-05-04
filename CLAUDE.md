@AGENTS.md

# Nova Orbit — Claude Code 운영 헌법

이 파일은 Claude Code · Nova 특화 지침이다. 공통 계약(언어/빌드/시크릿/Git)은 `AGENTS.md`에 있다.

## Architecture (라우팅용 진입점)

```
bin/nova-orbit.ts     → CLI entry point (npx nova-orbit)
server/
  index.ts            → Express + WebSocket
  db/schema.ts        → SQLite (7 tables, better-sqlite3)
  api/routes/         → projects, agents, goals, tasks, verification, orchestration, activities
  core/
    agent/adapters/   → Claude Code CLI adapter (stdin, stream-json, --add-dir)
    agent/session.ts  → Session manager (spawn/kill/resume)
    agent/roles.ts    → YAML template loader
    orchestration/    → Goal → Task decomposition, execution pipeline
    project/          → Import, GitHub connect, tech stack
    quality-gate/     → Nova 5-dimension verification (Generator-Evaluator separation)
shared/types.ts
dashboard/            → React + TailwindCSS + Zustand
templates/agents/     → YAML role presets (cto, pm, backend, frontend, ux, qa, reviewer, devops, marketer)
```

자세한 설계 문서는 `docs/design/`, `docs/designs/`, `docs/plans/` 참고.

## Key Design Decisions

- **SQLite** (not Postgres) — zero config, 단일 파일, npx 친화
- **Claude Code CLI subprocess** — Paperclip `claude_local` 패턴 (stdin/stdout, `--add-dir`, session resume)
- **Generator-Evaluator separation** — 구현/검증은 항상 다른 세션
- **stream-json output** — `--output-format stream-json`으로 구조화 응답 파싱

## Smart Team Suggestion (3-layer)

1. `.claude/agents/*.md` — 프로젝트 소유자 정의 에이전트. 파일 = 에이전트. **최우선**.
2. `CLAUDE.md` — 각 에이전트 시스템 프롬프트 앞에 컨텍스트로 주입.
3. `package.json` — `.claude/agents/`가 없을 때만 tech stack fallback.

## Nova Engineering 체크포인트

이 프로젝트는 Nova Engineering을 사용한다. **AI는 아래 시점에서 반드시 해당 동작을 수행한다.**

### 커밋 전 (필수)
- `npm run typecheck` + `cd dashboard && npx tsc --noEmit` — 둘 다 PASS 필수.
- 3파일 이상 변경 시: 변경 요약을 사용자에게 제시한 뒤 진행.
- ⚠️ **현재 advisory only — pre-commit hook 미설치** (Known Gap, `.claude/rules/instruction-placement.md` 참고).

### 사이드이펙트 체크 (필수)
- UI 버튼/상태 변경 시: 같은 영역의 모든 인터랙션 요소 (버튼·드롭다운·입력) 스캔.
- "이 변경이 영향을 주는 다른 요소: [목록]" 형태로 사용자에게 보고 후 구현.

### 동일 영역 재수정 감지
- 같은 파일/기능을 2회 이상 수정하게 되면: 근본 원인 분석을 먼저 수행.
- "이 영역을 다시 수정합니다. 근본 원인을 먼저 분석할까요?" 사용자 확인.

### 세션 마무리 (필수)
- `NOVA-STATE.md` 갱신 — 사용자가 요청하기 전에 AI가 먼저 제안 (커밋 수, 주요 변경, Known Gaps).

## 경로별 규칙 (자동 로드)

- `dashboard/**` 작업 시 → `.claude/rules/dashboard-ui.md`, `.claude/rules/ux-terminology.md`
- `templates/agents/**` 작업 시 → `.claude/rules/agent-presets.md`
- 지침 파일(`CLAUDE.md`, `AGENTS.md`, `.claude/**` 등) 편집 시 → `.claude/rules/instruction-placement.md`

## Known Mistakes

- **JSX 삼항 3단+ 중첩**: 괄호 불일치 빈번. 3단 이상은 IIFE `(() => { ... })()` 또는 별도 함수로 추출할 것.
- **DB 직접 수정**: broadcast 누락으로 대시보드 미반영. 항상 API 경유 (`API_KEY=$(cat .nova-orbit/api-key)`).
- **spawn 전 emit**: `session.process`가 null인 상태에서 이벤트 emit하면 리스너가 데이터를 못 잡음. spawn 후 즉시 별도 이벤트로 전달.

## Claude Code 통합

- `/memory`로 로드된 지침 파일 확인.
- 운영 상태/할 일은 `NOVA-STATE.md`에서 관리.
- 자주 쓰는 Nova 커맨드: `/nova:next`, `/nova:plan`, `/nova:check`, `/nova:review`, `/nova:claude-md`.
