# 웹 세션 워크스페이스 Phase 4 — 개입(Nudge/Queue/Steer) + 체크포인트

**Goal:** 실행 중에도 입력창을 막지 않고 개입한다 — idle 전송 / 실행 중 큐잉·끼어들기(steer)·중단. 턴 경계 체크포인트로 "마지막 정상 상태"로 되돌린다.

**Base:** `a543379` (Phase 3, feat/web-session-workspace-phase2 워크트리). 근거: `docs/design/web-session-workspace.md` §개입 모델·§상태 표면화.

## 개입 모델 (design §개입 모델)

| 상태 | `⏎` | `⌘⏎` | `Esc` |
|---|---|---|---|
| idle | 전송 | 전송 | — |
| 실행 중 | **큐**(턴 종료 후 자동 전송, `[큐 N]` 칩) | **끼어들기(steer)**=중단+resume | 중단 |

> **제약(정직)**: one-shot `--print` 모델은 실행 중 프로세스에 mid-stream 주입 불가. steer의 실제 구현 = 현재 턴 프로세스 SIGTERM + 누적 컨텍스트 + steer 메시지로 즉시 resume. 진짜 툴-경계 인터럽트는 불가. UI 라벨 "지금 끼어들기", 내부는 중단+resume.

## 범위

**Phase 4a (이 계획 — 개입):**
- 큐잉: chat 세션이 working일 때 409 대신 세션별 큐에 쌓고, 턴 종료 시 자동 다음 턴. `[큐 N]` 칩.
- 중단(Esc): 실행 중 chat 세션 kill (기존 killSession 재사용).
- steer(⌘⏎ 실행 중): 현재 턴 kill + steer 메시지로 즉시 resume.
- 프론트 Composer: 맥락별 키 분기(idle/실행중) + 큐 칩.

**Phase 4b (후속 분리 — 체크포인트):** 턴 경계 worktree 스냅샷(git stash/ref), 되돌리기 2모드(코드만 / 코드+이후 대화), "마지막 정상 worktree 되돌리기"를 auto-fix보다 우선 노출. 복잡도·위험(실행 중 git) 높아 독립 검증 단위.

## 백엔드 (Explore 결과로 확정 — 자리표시)

- **세션 큐**: SessionManager 또는 별도 맵에 `chatQueue: Map<sessionKey, string[]>`. chat 핸들러가 working이면 큐 push + `chat:event`(kind:queue?) broadcast. 턴 종료 리스너가 큐 shift → 다음 send.
- **working 판정/전이**: resolveChatSession busy 처리 재확인. 세션 status "working" 소스.
- **steer**: 기존 killSession/cleanup(session.ts) + resume(--resume) 재사용. 현재 턴 kill 후 즉시 새 send(steer 메시지). 세션 keep-alive라 resume id 유지.
- **중단(Esc)**: /agents/:id/kill 또는 chat 전용 abort.
- 체크포인트(4b): worktree.ts checkpoint/dropCheckpoint(`crewdeck-checkpoint-*` stash) 재사용.

## 프론트 (design §개입 모델)

- `ChatComposer` 확장: 세션 working 상태 구독(agent:status 등) → idle/실행중 키 분기.
  - idle: ⏎/⌘⏎ 전송.
  - 실행중: ⏎ 큐(칩 `[큐 N]`), ⌘⏎ steer(중단+resume), Esc 중단.
- 큐 칩 스트립(Composer 상단). Shift+⏎ 개행.
- `api.sendChat`에 mode(queue/steer) 또는 별도 엔드포인트.

## 검증
1. `npm run typecheck` + dashboard `tsc -b` PASS, lint 신규 0.
2. **통합 라이브 E2E** (Phase 2·3·4, AGENTS.md §Parallel Git Workflow 규칙): 워크트리에서 별도 포트·데이터로 인스턴스 기동 `node dist/bin/crewdeck.js --port=7301 --data-dir=/tmp/crewdeck-phase-e2e --no-open` → 라이브(7200) 무중단. 소환→워크스페이스→diff/판정/출력→대화, 실행 중 큐잉/중단 관통(Playwright).

## 알려진 위험
- 실행 중 세션 중단(steer/Esc)은 SIGTERM. keep-alive resume id 보존 확인 필수. 잘못하면 컨텍스트 유실.
- Codex는 resume 없어 steer 시 컨텍스트 재주입(fresh) — v1 Claude 우선.
- 체크포인트(4b) git stash는 실행 중 worktree 상태 경합 주의.
