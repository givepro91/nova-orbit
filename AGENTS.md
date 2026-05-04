# Nova Orbit

AI Team Orchestration + Quality Gate for Solo Founders.
Claude Code sessions as agents, goal-based orchestration, Nova Quality Gate verification.

## Start Here

- Current state / 진행 중 작업 / Known Gaps: `NOVA-STATE.md`
- Claude Code · Nova 운영 헌법: `CLAUDE.md`
- 아키텍처/디자인/runbook: `docs/`

## Language

- 사용자 응답은 항상 **한국어**.

## Build & Verify

```bash
npm run dev:server                  # tsx watch server (port 7200)
npm run dev:dashboard               # vite dev (port 5173 → 7200 proxy)
npm run build                       # server (tsup) + dashboard (vite)
node dist/bin/nova-orbit.js         # start built server

npm run typecheck                   # server tsc --noEmit
cd dashboard && npx tsc --noEmit    # dashboard tsc --noEmit
npm test                            # vitest run
```

## Non-Negotiables

- **Never commit**: `.env`, `.nova-orbit/**`, `*.db`, `*.pem`, access keys.
- **No production DB writes** without explicit user approval.
- **Always go through API**, not direct DB writes — broadcast 누락으로 대시보드가 미반영된다. (`API_KEY=$(cat .nova-orbit/api-key)`)
- **3+ files changed** → 변경 요약을 사용자에게 제시한 뒤 진행.
- **typecheck PASS** (`npm run typecheck` + dashboard `tsc --noEmit`) 없이는 커밋 금지.

## Git Convention

```
feat: 새 기능       | fix: 버그 수정
update: 기능 개선   | docs: 문서
refactor: 리팩토링  | chore: 설정/기타
```

- 기본 브랜치: `main`
- 영문 prefix + 한국어 본문 (예: `feat: 로그인 기능 추가`)
- 사용자 명시 요청 시에만 커밋/푸시.

## Agent Routing

- Claude Code/Nova 특화 운영 헌법: `CLAUDE.md`
- 경로 한정 규칙: `.claude/rules/`
- 워크플로우/커맨드: `.claude/skills/`, `.claude/commands/`
- 하드 가드: `.claude/settings.json`, git hooks, CI (현재 일부 미적용 — `NOVA-STATE.md` Known Gaps 참고)
- 현재 phase / 할 일 / blocker: `NOVA-STATE.md`

## Instruction Placement Contract

- Always-on 프로젝트 사실/빌드 명령/위험 경계 → `AGENTS.md` 또는 `CLAUDE.md`
- 경로 한정 규칙 → `.claude/rules/*.md` with `paths`
- 다단계 절차 → `.claude/skills/*/SKILL.md` 또는 `.claude/commands/*.md`
- 반드시 차단해야 하는 것 → `.claude/settings.json`, hooks, CI
- 긴 참고 문서 → `docs/**`
- 현재 phase/blocker → `NOVA-STATE.md`
- 개인/로컬 경로 → `CLAUDE.local.md` 또는 `.claude/settings.local.json`

자세한 분리 기준과 enforcement 상태표는 `.claude/rules/instruction-placement.md` 참고.
