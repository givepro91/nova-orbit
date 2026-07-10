# Crewdeck — 현재 상태 & Known Gaps

> 프로젝트의 살아있는 상태 문서. 굵직한 세션을 마칠 때마다 갱신한다.
> 상세 개발 이력은 git history 참조 — 이 문서는 **현재 상태**와 **열린 과제(Known Gaps)**만 담는다.
> (2026-07-09 `nova-orbit → crewdeck` 리네임 시점에 changelog를 정리하고 이 문서를 재작성했다.)

## 한 줄 정의

AI Team Orchestration + Quality Gate for Solo Founders. Claude Code CLI 세션을 goal 기반으로 오케스트레이션하고, Generator-Evaluator 분리로 모든 산출물을 검증하는 **로컬 개인 운영 도구**. launchd로 상시 기동(`~/.crewdeck`), 대시보드 `http://localhost:7200`.

## 현재 상태 (2026-07-09)

- **제품 방향**: 개인 운영 도구(givepro91)로 확정. 사내 활용 보류, 대외 제품화 중단. 상시 launchd 서비스 위에서 개인 프로젝트 dogfooding 중 발견한 결함만 수정하는 운영 모델. (배경: `docs/design/r3-product-direction.md`)
- **리브랜딩 완료 — `nova-orbit` → `crewdeck`**: 코드·설정·문서·런타임 식별자에서 `nova`/`orbit` 전량 제거.
  - `server/core/nova-rules/` 모듈 → `server/core/methodology/` (`createMethodologyEngine`), postbuild 복사 경로 정합
  - `NOVA_*` env → `CREWDECK_*` (12개), `/api/orbit-status` → `/api/crewdeck-status`, `NovaAgentError` → `AgentError`
  - 대시보드 내부 이벤트 `nova:*` → `crewdeck:*` (156개), localStorage 키 `nova-*` → `crewdeck-*`, StatusBar `OrbitStatus` → `CrewStatus`
  - 런타임 라벨: git stash(`crewdeck-checkpoint-*`·`crewdeck-squash-guard`), worktree 디렉토리(`.crewdeck-worktrees`), 커밋 스코프(`feat(crewdeck-agent)`), 임시파일(`.crewdeck-system-prompt`), 세션 이벤트(`crewdeck:error`), 요약 에이전트(`[Crewdeck] Summarizer`)
  - methodology `.md`(에이전트 주입 텍스트)·i18n·README의 사용자/에이전트 노출 "Nova" → "Crewdeck"
  - 구식 origin/plan 문서 삭제: `docs/KICKOFF.md`·`docs/PROJECT.md`·`docs/designs/`·`docs/plans/`
  - **검증**: server/dashboard typecheck PASS · vitest **281/281** · 라이브 배포 관통(drain-safe 재시작) · 부트스트랩 auth 흐름 브라우저 실검증(연결·프로젝트 로드·콘솔 에러 0)
- **최근 기능 마일스톤** (상세는 git history):
  - **Quality Gate 탈-ceremony + 조건부 검증** — 5-dimension 채점 제거(verdict는 LLM 직신뢰), `autoDetectScope`로 UI·위험만 full(브라우저 재현) 그 외 lite, auto-fix 1 self-heal 후 goal-QA 이월로 무한검토 근본 차단. DB 70건 실측으로 게이트 유효성 입증(fail 30% — 테스트로 못 잡는 결함 차단). (`docs/design/quality-gate-deceremony.md`)
  - **작업 요약 투명성** — goal 완료 시 값싼 모델 1콜로 before/after 서사 생성(비동기·논블로킹), 워크트리에 이미 있는 스크린샷을 artifact로 수집해 승인창 썸네일. (`docs/design/work-summary-transparency.md`)
  - **goal 간 병렬 실행**(기본 동시성 2, goal 내부는 순차 1) + 검증 수렴 보장(fail 라운드 상한 → goal QA 이월) + 라이브 활동 흐름 타임라인 + 병렬 squash 충돌 integration-time 해결 파이프라인.
  - **Codex 라이브 dogfooding 수정**(crewdeck 자체 프로젝트를 codex로 운영하며 발견): ① codex 어댑터 샌드박스 전체 접근(`--dangerously-bypass-approvals-and-sandbox`) — `workspace-write`가 네트워크·외부쓰기를 막아 playwright/CodeRabbit/npm이 실패하던 근본수정(실측: E2E task가 fail→conditional로 개선). ② 라이브 활동 파서 provider-aware(codex `item.completed`/`command_execution` 인식). ③ 태스크 상세 모달 크기 축소. ④ 교차-provider self-heal(B1).
  - **검증 실패 해결 모델 재정립**("완료가 목적, 반복 실패 방치 금지" 피드백): ① **auto-fix 반복 루프** — self-heal 1회 후 이월하던 것을 `MAX_FIX_ROUNDS`(기본 6)까지 fix→재검증 반복 + 라운드마다 provider 교차. 인시던트(무한검토) 근본원인 scope-creep은 verdict 범위 정책+실패이력 주입으로 이미 차단돼 수렴. ② **"이슈 이월" 정직 표시(B2)** — done+fail을 빨강 FAIL이 아닌 호박색 "이슈 이월"로. ③ **"↻ 다시 해결" 버튼** — 이월 태스크 원클릭 재작업. 실측: 전투 계산(critical 세이브키 버그) 재작업으로 fail→PASS. ⚠ **미검증**: auto-fix 루프가 최난도 케이스(세이브 v3 partySynergy 버그)를 실제 수렴시키는지는 관찰 중 — 추측 아닌 실측 필요(사용자 지적). 6라운드 다 쓰고도 실패하면 "재시도만으로 안 되는 버그 존재" 결론 → 정직한 사람 개입 backstop.
  - **dogfooding 자기사살(self-kill) 근본 차단**(2026-07-10, 라이브 인시던트): crewdeck이 자기 자신을 autopilot으로 dogfooding 중, QA 회귀 태스크 **"[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰"**가 crewdeck 레포에서 앱을 "실행"하려고 `npm run dev` 실행 → `predev.sh`의 `launchctl bootout com.crewdeck.server` + `kill -9 :7200`가 **라이브 launchd 서비스를 종료·등록해제** → 서버 다운(bootout이 launchd에서 제거해 KeepAlive도 못 살림). 로그상 어제부터 반복돼온 패턴(QA "앱 실행" 태스크 9개). **수정**: ① `engine.ts` QA 회귀 태스크 설명에서 `npm run dev` 지시 제거 + "상시/production 서비스 내리는 명령 금지, 임시 포트/기존 인스턴스/build+test로 대체" 가드 인라인, ② methodology `rules.md §10`(상시 서비스 자기종료 금지) 신설 — `getAutoApplyRules()`로 **모든 태스크 실행 프롬프트에 주입**(dist에서 로드 → 기존 워크트리 에이전트에도 도달). 복구=안전 drain 없이 `CREWDECK_NO_AUTO_QUEUE=true`로 큐 held 부팅 후 수정 배포. **검증(실측)**: 큐 재개 후 killer QA 태스크가 in_progress→in_review→done 완주하는 동안 health 계속 ok·graceful-shutdown 증가 0 = 자기사살 재발 없음. ⚠ 잔여: `predev.sh` 자체는 여전히 bootout+kill(다른 kill 경로는 열림) — 필요 시 predev에 라이브-서비스 감지 가드 추가(option D) 검토.
  - **Scope Anchor 완화 — scope-drift false FAIL 근본 차단**(2026-07-10, 검토 FAIL 과다 진단): dogfooding 중 검토 단계 FAIL이 과다(DB 실측 fail 40%)하던 것을 진단 → 대부분은 evaluator가 실제 실행으로 잡은 **진짜 결함**(테스트 갭·구조화 계약 미강제·healthy-session-kill race)이었으나, 한 축은 **false FAIL**로 확인. 원인: decompose LLM이 추측으로 박는 `target_files`(Scope Anchor)를 구현 프롬프트(`Modify ONLY these files`)와 검증 프롬프트(`expected file missing → fail`) **양쪽에서 절대 계약으로 강제** → 추측 경로가 실제 아키텍처와 어긋나면(예: `stream-parser.ts` vs `adapters/stream-parser.ts`) 올바른 구현도 scope mismatch FAIL, Generator를 틀린 경로로 오도. **수정**: `target_files`를 계약→안내로 격하 — ① evaluator: 같은 기능의 다른 경로는 CORRECT, path drift·파일 부재만으로 fail 금지(무관 기능/wrong-stack 이탈만 fail), ② engine 구현 프롬프트: 실제 아키텍처가 다르면 올바른 경로 우선, ③ engine decompose 프롬프트: 존재 파일 위주 추측, 자신 없으면 `[]`. wrong-stack·무관 기능 이탈 등 진짜 drift 방어력은 유지. **부수**: `evaluator-diff.test.ts`가 실행 환경의 global gitignore(`~/.gitignore_global`의 `.omc` 등)에 오염돼 `git add .omc`가 거부되며 실패하던 환경 취약성도 `core.excludesFile=/dev/null`로 차단(코드 무버그). 검증: typecheck PASS·evaluator-scope 5/5·evaluator-diff 5/5·drain-safe 라이브 배포(자연 drain 불가로 restart 처리, 큐 자동 running).
  - **LLM JSON-배열 파싱 하드닝**(2026-07-10, 라이브 dogfooding 크래시): 목표 제안("목표 추가" 모달)이 `SyntaxError: Unexpected token '증', "[증거→주장, ver"...`로 죽던 버그. 원인은 greedy 폴백 정규식 `/(\[[\s\S]*\])/`이 모델 산문 속 대괄호 평문(`[증거→주장, ...]`)을 통째로 붙잡아 `JSON.parse`에 넘긴 것. 문자열 인식 balanced 스캔으로 "실제 배열로 파싱되는 첫 후보"만 채택하는 `server/utils/llm-json.ts#extractJsonArray` 신설 → `goals.ts`(suggest)·`team-designer.ts` 두 호출부 교체(동일 취약 패턴). 실패 시 raw SyntaxError 대신 깨끗한 에러로 degrade(프론트 "다시 시도/바로 생성" fallback UI와 정합). 검증: 유닛 9(정확한 회귀 케이스 포함)·전체 314 PASS·drain-safe 라이브 배포·suggest 엔드포인트 HTTP 200 실측.

## 아키텍처 자산

| 자산 | 상태 |
|------|------|
| 오케스트레이션 엔진 (decompose→구현→검증→fix→git) | 완성 (`engine.ts`) |
| 스케줄러 (autopilot, AIMD backoff, DAG 의존성, 크래시 복구, goal 간 병렬) | 완성 (`scheduler.ts`) |
| Quality Gate (Generator-Evaluator 분리, 조건부 검증, issues/repro) | 완성 (`evaluator.ts` + `verification-policy.ts`) |
| Claude Code CLI adapter (stream-json, resume, rate-limit 분류) | 완성 + 테스트 |
| **멀티 백엔드 (Claude / Codex) + 자동 failover** | 완성 + 유닛/스모크. 실 라이브 failover 관통은 Gap 참고 (`adapters/backend.ts`·`codex.ts`·`provider.ts`·`failover.ts`) |
| Goal-as-Unit (goal worktree + squash 승인 게이트 + 충돌 해결) | 완성, 실운영 검증됨 |
| 대시보드 (Kanban, 실시간 WS, i18n ko/en, 다크모드, Cmd+K, 라이브 활동 흐름) | 완성 |
| 에이전트 프리셋 9종 + 4-tier 프롬프트 해석 + AI 팀 설계자 | 완성 |
| 프로젝트 임포트 / GitHub 연동 / tech stack 분석 | 완성 (PR 경로는 Gap 참고) |
| 방법론 주입 (`methodology/` — orchestrator/evaluator/rules) | 완성, Crewdeck 소유·직접 편집 |

## Known Gaps (열린 것만)

| Gap | 내용 | 우선순위 |
|-----|------|----------|
| `AgentRole` 타입 드리프트 | `shared/types.ts` 유니온이 실제 9 role과 불일치. DB는 CHECK 제거로 임의 role 허용 — 타입만 낡음 | Medium |
| 통합 테스트 부재 | 유닛 테스트만 존재(281건) — spawn→verify→git 루프 회귀를 못 잡음 | Medium |
| 대시보드 API key 재발급 UX | 최초 1회만 브라우저 발급(`.key-issued`). 401 시 1회 자동 재발급 시도는 있으나, 마커가 살아 있는 상태의 다른 브라우저/데이터디렉토리 이관·키 회전 후에는 여전히 잠김 — 수동 key 입력 UI 필요. (현 완화: `.key-issued` 수동 삭제 시 localhost 1회 재부트스트랩) | Medium |
| 기존 프로젝트 tech_stack 재분석 endpoint 부재 | analyzer 개선이 신규 임포트에만 적용 — 재분석 경로 없음 | Low |
| methodology `.md` 내 CREWDECK-STATE 언급 잔존 | 폐기된 상태파일 컨벤션 언급이 `rules.md`·`orchestrator-protocol.md`·`evaluator-protocol.md`에 남음 — 직접 정리 가능 | Low |
| `docs/verification/` vs `docs/verifications/` 중복 | 디렉토리 통합 필요 (`docs/designs`·`docs/plans`는 07-09 삭제로 해소) | Low |
| `engine-logic.test.ts`의 `pending_fix` | schema CHECK에 없는 status를 테스트가 참조 | Low |
| 고부하 concurrency race 미검증 | goal 2개 병렬 완주는 실측. 3+ goal·동시 squash 경합은 미검증 | Low |
| 큐 정지 중 위임 부모 교착 | stop-queue 상태에서 위임 부모는 서브태스크 실행 불가로 영구 in_progress — drain 판정에 activeTasks로 우회 | Low |
| QG 조건부검증 B2 미구현 | task-level acceptance_script 통과 시 LLM verify 진짜 skip — fragile 구역 넓어 이연. `runAcceptanceScript` 재사용 가능 | Low |
| delegation 부모 verify lane 분기 | engine은 "1 self-heal→이월", delegation 부모는 cap-gated(최대 3라운드) — 둘 다 loop-safe이나 aggressiveness 불일치 (`delegation.ts:335`) | Low |
| `saveDiscardedDiff` dead | QG 탈-ceremony로 호출부 소멸, 정의만 잔존 — 제거 cleanup | Low |
| 고아 i18n 키 | 5-dim 제거 후 `dimensionScore`·`dim*`·`evaluationFailed` 등 미참조 잔존 (무해) | Low |
| work_report 아티팩트 디스크 정리 부재 | `~/.crewdeck/artifacts/goals/<id>/` 스크린샷이 goal 삭제/merge 후에도 잔존 — 정리 훅 고려 | Low |
| 구 포맷 result_summary 표시 | `extractWrapUp` 이전 저장 태스크는 구 500자 mid-sentence 절단본을 verbatim 노출 (코스메틱) | Low |
| 관리 프로젝트의 빈 `.nova-worktrees` 잔존 | 리네임 전 생성된 빈 디렉토리가 proof·Tower-Roguelike·smoke-calc에 남음(활성 worktree 없음, 무해). 신규는 `.crewdeck-worktrees` 사용 | Low |
| DB 내 `[Nova] Summarizer` 과거 레코드 | 코드 변경 전 생성된 요약 에이전트/세션 행이 DB에 남음(과거 로그, 무해). 신규는 `[Crewdeck] Summarizer` | Low |
| AIMD 쿨다운 resume / DAG 100+ 성능 / branch_pr squash UX | 장시간 운영 재현·성능 측정·`gh pr create --squash` 부재 — 각 미측정/미검증 | Low |
| **Codex failover 라이브 관통 미검증** | 유닛(decideFailover)·스모크(codex 실행)·분류는 검증. 실제 Claude 한도를 유발해 goal이 Codex로 인계·완주하는 라이브 관통은 미실측(한도 인위 유발 어려움) — 실사용/강제 트리거로 확인 필요 | Medium |
| 전역 failover 토글 config API/UI 부재 | `codexFailover`(기본 true)·`codexModelMap`은 `~/.crewdeck/config.json` 수동 편집만 — `/api/config` endpoint + 토글 UI 후속 | Low |
| Codex resume/skills 미구현 | failover 시 Codex는 fresh 세션(Claude resume 컨텍스트 미승계, Smart Resume 실패이력으로 보완). Codex `thread_id` resume·skills 주입은 후속 | Low |
| Codex 비용 미집계 | Codex `--json`은 cost 미보고 → `sessions.cost_usd`는 codex 세션에서 0, token만 집계 | Low |
| architect/fix 세션 failover 미커버 | failover override는 sessionKey=agentId(impl/fix) 기준. architect(별도 sessionKey)의 한도 실패는 override 미적용 | Low |
| ~~B2 "완료+FAIL" 혼란~~ | **표시 해소**: done+fail은 "이슈 이월"(호박색)로 정직 표시 + "최종 QA로 이월된 이슈:" + 툴팁 (TaskList·Kanban·TaskDetail). status 미변경(표시만)이라 저위험. 잔여(선택): 미해결 이월 태스크를 "완료" 그룹에서 아예 분리하는 상태 재구조화는 goal 완료 계산 의미론을 건드려 별도 판단 | — |
| 미해결 이월 태스크의 "완료" 그룹 소속 | done+fail이 status=done이라 "완료" 그룹에 남음(표시는 이제 정직). 별도 "이월/검토대기" 그룹 분리는 goal 완료율 계산 영향 검토 후 | Low |

## 운영 메모

- **데이터 위치**: 정식 `~/.crewdeck` (DB·api-key·pid·artifacts). dev(`npm run dev`)는 레포 로컬 `.crewdeck` 사용 — predev가 launchd 서비스 자동 정지, dev 종료 후 `scripts/service-macos.sh start`로 복구.
- **서버 재배포 절차 (drain 필수)**: 큐 정지 → `activeTasks=0` drain → `npm run build`(전체) → `scripts/service-macos.sh restart` → 큐 재가동. drain 없이 재시작하면 실행 중 에이전트 세션이 SIGTERM(exit 143)으로 죽는다. 대시보드만 변경 시 `npm run build:dashboard`로 무중단.
- **서비스 관리**: `scripts/service-macos.sh status|logs|restart|start|stop`.
