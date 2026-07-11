# 웹 세션 워크스페이스 Phase 4b — 끼어들기(steer) + 코드 체크포인트

**Base:** `2456b8b` (Phase 4a 이후). 근거: `docs/design/web-session-workspace.md` §개입 모델·§상태 표면화.
**격리:** worktree `feat/web-session-workspace-phase4b` (node_modules 심링크), 검증은 별도 포트(7305)·데이터. 라이브 7200 무접촉.

## 범위 확정 (사용자 결정)

개입 모델(idle/큐/steer/중단)의 마지막 조각인 **steer**와, 안티-Bolt "되돌리기 우선"의 **코드 체크포인트**.

- **steer** — Claude/Codex 양쪽 구현.
- **체크포인트** — 사용자 지시로 **방법을 바꿈**(아래 §체크포인트). chat/소환 세션이 goal worktree가 아니라 **실제 프로젝트 레포**에서 편집한다는 사실 때문에, 계획서 초안의 `git stash push`(작업 트리를 실제로 건드림)는 사용자 미커밋 작업 유실 위험이 있어 폐기. **비파괴 스냅샷**으로 대체.

## steer (⌘⏎ 실행 중 = 끼어들기)

정직한 제약(design §개입 모델): one-shot `--print`는 mid-stream 주입 불가. steer = **현재 턴 중단 + 누적 컨텍스트로 즉시 resume**.

**구현 (별도 엔드포인트 없음 — `/chat`에 `steer` 플래그 1개 브랜치):**
- 실행 중 + `steer` → steer 메시지를 **큐 맨 앞에 unshift + 현재 턴 `session.kill()`**. 중단된 턴의 `finally`가 `drainChatQueue`를 돌려 이 메시지를 다음 턴(resume)으로 보낸다. **기존 drain 재사용 → 별도 send 경로·이중 전송 없음.**
- idle + `steer` → 플래그 무시, 일반 전송(설계 표: idle ⌘⏎ = 전송). **백엔드가 실제 세션 status로 중재**하므로 프론트 working 추측에 정확성이 의존하지 않는다.

**함정 처리 (Explore 지적):**
1. `session.kill()`(claude-code.ts / codex.ts)이 SIGTERM만·에스컬레이션 없음 → **SIGKILL 에스컬레이션** 추가(`session.process === proc`일 때만 — resume가 교체한 다음 턴 오폭 방지). process/status 정리는 close 핸들러로 이관(내부 타임아웃 수명주기와 동일).
2. close 핸들러가 SIGTERM에도 resolve → **`RunResult.interrupted` 플래그 신설** + `interrupting` 표식. 중단 턴은 "failed" status 방출을 건너뛰어(헛 실패 배지 방지) **resume용 lastSessionId를 보존**하고 `interrupted:true`로 resolve. `/chat`은 `interrupted`면 "interrupted"로 정직 보고.
3. kill은 반드시 **chatSessionKey 경유**(raw agentId kill은 chat 세션 못 죽임) — steer 브랜치가 `chatSessionKey(agentId)`로 세션 조회.

**Codex**: resume 부재라 steer 시 fresh 재주입(systemPrompt·소환 컨텍스트는 config에 유지). "코드 상태 ≠ 대화 상태"라 되돌리기와 직교. design §140 v1 한계와 일치.

**프론트 (ChatComposer):** 키 모델을 설계 표에 정렬 — ⏎ 전송/큐, ⌘⏎ steer, Shift+⏎ 개행, Esc 중단. working 시 "끼어들기"/"중단" 버튼 노출(SessionWorkspace는 store `agents[].status`로 working 구독).

## 체크포인트 (바뀐 방법 — 비파괴 스냅샷)

**왜 바꿨나:** chat/소환 세션 `workdir = project.workdir`(실제 레포). `git stash push`는 작업 트리를 비웠다 되돌리므로 사용자 미커밋 작업과 경합(유실). `restoreCheckpoint`(worktree.ts, taskId 스코프)는 이 모델에 부적합.

**바뀐 방법:**
- **캡처 = 비파괴** (`snapshotWorkdir`): 임시 인덱스(`GIT_INDEX_FILE`)에 `git add -A` → `write-tree` → `commit-tree`. 작업 트리·실제 인덱스·stash 스택을 **전혀 안 건드림**(순수 read). `{commit, tree}` 반환, `tree`로 "변경 없음" dedup. 고정 committer 신원(env)으로 config 비의존. provider 무관(순수 git).
- **되돌리기 = 안전** (`restoreWorkdirSnapshot`): `git restore --source=<snap> --worktree -- .` — (1) 작업 트리만, staged 인덱스 미접촉, (2) 스냅샷 이후 **신규 파일은 삭제 안 함**(파일 안 지움). 편집 되돌림에 강하고 신규 정리는 사용자 몫.
- **배선**: 매 턴 시작 전 `recordCheckpoint`(직전 tree와 같으면 스킵, 최대 20개). `chat:event` `kind:"checkpoint"` broadcast. `POST /chat/restore { commit }` — commit이 이 세션 목록에 있을 때만 허용(임의 ref checkout 차단).
- **프론트**: ChatThread 하단 sticky "↩ 코드 되돌리기" 스트립(턴 칩, 최근 6개) + `ConfirmDialog`(window.confirm 금지 규칙 준수).

## 검증

- `npm run typecheck` + dashboard `tsc -b` **PASS**. 신규 lint 0(api.ts 66=66, 신규 로직 파일 클린).
- **체크포인트 git 로직 단위 테스트**(`server/__tests__/workdir-snapshot.test.ts`, 4/4 PASS): 비파괴성(캡처 후 dirty 보존·stash 스택 empty), 안전 복원(편집 되돌림·신규 파일 보존), untracked 스냅샷 복원, 비-git 폴백.
- **부팅 스모크**(격리 7305): 서버 정상 기동, `/chat/restore`(404 checkpoint not found)·`/chat` steer=true(404 Agent not found, 파싱 OK)·`/chat/abort`(200)·auth(401) 라우트 배선 확인.
- **테스트 회귀 0**: 기존 실패 2건(`goal-as-unit.e2e` squash 커밋 `feat:` 프리픽스)은 base에서도 동일 — 이 변경과 무관.

## 미검증 (라이브 claude 대화 필요 — 환경상 이번 스킵)

- steer 실동작: 실행 중 턴을 ⌘⏎로 중단 → 다음 턴이 resume로 이어지고 "failed" 헛 배지 없음.
- 체크포인트 실동작: 실제 turn 편집 → 하단 되돌리기 스트립 → "↩ 턴 N" 되돌리기로 편집만 원복.
- 라이브 반영: 소유 세션이 main에서 drain 절차로 build+restart.
