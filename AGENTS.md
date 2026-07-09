# Crewdeck

AI Team Orchestration + Quality Gate for Solo Founders.
Claude Code CLI 세션을 에이전트 팀으로 묶어, goal 기반 오케스트레이션과 Generator-Evaluator 분리 검증(Quality Gate)을 제공하는 로컬 도구. `npx crewdeck` 단일 명령 실행이 목표.

## Start Here

- 현재 상태 / Known Gaps / 부활 로드맵: `docs/ROADMAP.md`
- Claude Code 특화 운영 지침: `CLAUDE.md`
- 아키텍처/설계/검증 문서: `docs/`

## Language

- 사용자 응답은 항상 **한국어**. 코드·경로·식별자·기술 용어는 원문 유지.

## Build & Verify

```bash
npm run dev                         # server(7200) + dashboard(5173) 동시 기동
npm run dev:server                  # tsx watch server (port 7200)
npm run dev:dashboard               # vite dev (port 5173 → 7200 proxy)
npm run build                       # server (tsup) + dashboard (vite)
npm start                           # 빌드 산출물 실행 (dist/bin/crewdeck.js)

npm run typecheck                   # server tsc --noEmit
cd dashboard && npx tsc -b          # dashboard typecheck — ⚠ `tsc --noEmit`은 files:[]+references 구조라 no-op
npm test                            # vitest run (unit only — 통합/E2E 없음)

# 상시 기동 (macOS launchd — 로그인 자동 시작, 개인 도구 운영 모드)
scripts/service-macos.sh install|start|stop|restart|status|logs
```

- Node >= 20. `better-sqlite3`는 네이티브 모듈 — Node 메이저 변경 시 재설치/`npm rebuild better-sqlite3` 필요.
- 런타임 전제: `claude` CLI가 PATH에 있고 인증된 상태여야 오케스트레이션이 동작한다.
- **데이터 디렉토리 정식 위치 = `~/.crewdeck`** (bin 해석 순서: `--data-dir=` > `CREWDECK_DATA_DIR` > cwd `.crewdeck`(DB 있을 때만, 레거시) > `~/.crewdeck`). dev(`npm run dev`)는 레포 로컬 `.crewdeck` 사용 — 상시 서비스와 데이터가 분리된다. `npm run dev`는 predev가 launchd 서비스를 자동 정지하므로, dev 종료 후 `scripts/service-macos.sh start`로 복구.

## Non-Negotiables

- **Never commit**: `.env`, `.crewdeck/**`, `*.db`, `*.pem`, access keys — pre-commit hook이 차단.
- **typecheck PASS 없이 커밋 금지** — TS 변경 시 pre-commit hook이 자동 실행.
- **DB 직접 수정 금지, 항상 API 경유** — 직접 수정하면 WebSocket broadcast가 누락돼 대시보드에 반영되지 않는다. (`API_KEY=$(cat .crewdeck/api-key)`)
- **No production DB writes** without explicit user approval.
- 사용자 명시 요청 시에만 커밋/푸시.

## Git Convention

```
feat: 새 기능       | fix: 버그 수정
update: 기능 개선   | docs: 문서
refactor: 리팩토링  | chore: 설정/기타
test: 테스트
```

- 기본 브랜치: `main` — 영문 prefix + 한국어 본문 (예: `feat: 로그인 기능 추가`)

## Instruction Placement

지침의 위치는 `.claude/rules/instruction-placement.md` 계약을 따른다. 요약: always-on 사실/빌드/위험 경계 → `AGENTS.md`·`CLAUDE.md`, 경로 한정 규칙 → `.claude/rules/`, 강제 차단 → `.claude/settings.json`·hooks, 현재 상태·로드맵 → `docs/ROADMAP.md`, 긴 참고 문서 → `docs/**`.
