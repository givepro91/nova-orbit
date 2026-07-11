---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/CLAUDE.md"
  - ".claude/rules/**"
  - ".claude/skills/**"
  - ".claude/commands/**"
  - ".claude/settings*.json"
  - "docs/operations/**"
  - "docs/guides/**"
---
# Instruction Placement Contract

지침을 추가/수정하기 전에 반드시 분류한다:

| Content | Destination |
|---------|-------------|
| Always-on 프로젝트 사실, 빌드/테스트 명령, 위험 경계 | `AGENTS.md` 또는 `CLAUDE.md` |
| 경로 한정 규칙 | `.claude/rules/*.md` with `paths` frontmatter |
| 다단계 절차 (배포/릴리스/마이그레이션) | `.claude/skills/*/SKILL.md` 또는 `.claude/commands/*.md` |
| 강제 차단/검사 | `.claude/settings.json`, hooks, CI, scripts |
| 긴 참고 문서/runbook | `docs/**` |
| 개인 경로 / 로컬 URL / 토큰 | `CLAUDE.local.md` 또는 `.claude/settings.local.json` |

> **규칙이 중요하다는 이유만으로 CLAUDE.md에 넣지 않는다.** 중요하고 반드시 지켜야 한다면 enforcement(settings/hooks/CI) 소유자를 함께 명시한다.

## 현재 enforcement 상태 (Crewdeck)

| Rule | Status | Owner |
|------|--------|-------|
| `.env`, `.crewdeck/**`, `*.db`, `*.pem` write/edit 차단 | enforced | `.claude/settings.json` deny |
| 시크릿/위험 파일 staged 시 커밋 차단 | enforced | `scripts/git-hooks/pre-commit` (`scripts/install-hooks.sh`로 자동 설치) |
| `npm run typecheck` 커밋 전 PASS (TS 변경 시) + dashboard `tsc -b` (dashboard 변경 시) | enforced | `scripts/git-hooks/pre-commit` |
| `window.confirm/alert/prompt` 및 implicit globals 금지 | enforced | `dashboard/eslint.config.js` `no-restricted-globals` + `no-restricted-properties` |
| Generator-Evaluator separation | enforced | `server/core/quality-gate/` 코드 |
| DB 직접 수정 금지 (broadcast 누락) | advisory | tribal knowledge — `CLAUDE.md` Known Mistakes 참고 |
| Production DB 쓰기 사전 승인 | advisory | 사용자 운영 룰 |

새 advisory 규칙을 추가할 때는 위 표에 한 줄을 함께 추가하고, 가능하면 enforced로 승격할 owner를 명시한다.
