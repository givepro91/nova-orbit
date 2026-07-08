# Nova Orbit — 현재 상태 & 부활 로드맵

> 이 파일이 프로젝트의 살아있는 상태 문서다 (구 `NOVA-STATE.md` 대체 — Nova Engineering 방법론 파일은 2026-07-07 폐기).
> 굵직한 세션을 마칠 때마다 갱신한다.

## 현재 상태 (2026-07-07 · 일상 도구화 완료 — 상시 기동 운영 모드)

- **일상 도구화 세션 완료**: `npm run build` → `node dist/bin/nova-orbit.js` 패키지 실행 경로 검증 (4월 이후 처음 — dashboard 빌드가 실제로 깨져 있던 것 발견·수정), launchd 상시 기동(`scripts/service-macos.sh`, label `com.nova-orbit.server`), **데이터 디렉토리 정식 위치 `~/.nova-orbit` 확정** + 오늘 dogfooding 데이터(휘발성 tmp에 있던 proof·smoke-calc DB) 이관. D-2(tech stack 감지)·D-3(한글 slug) 해소.
- 이제 로그인하면 서버가 이미 떠 있다: `http://localhost:7200` (관리: `scripts/service-macos.sh status|logs|restart`, dev 시 predev가 자동 정지).

## (기록) R1+R2+실프로젝트 dogfooding 완료 시점 상태

- **실프로젝트 dogfooding 성공** (`givepro91/proof` — Python+React 모노레포): AI 목표 추천 → "감사·원장 어휘 폐기 → 카피 통일" goal(7태스크) → Evaluator 차별 판정(pass/conditional/fail) → fail 자동수정·blocked 자동재시도 → 서버 3회 중단·복구 관통 → acceptance(pytest 146) → 승인 리뷰(스코프 이탈 검출·원복 포함) → **main 머지 `46fb88d`**, vitest 38/38·pytest 146/146 그린.
- dogfooding이 **P1 1건 발견 → 수정**: architect residue 자동커밋이 사용자의 기존 untracked 자산(목업 PNG 6개)을 "잔여물"로 오인해 **대상 레포 main에 직접 커밋**. 세션 전 dirty 스냅샷 대비 신규 항목만 스테이징·커밋하도록 수정 (사용자 main은 수동 원복 완료).
- 기타 발견: tech stack 감지 실패(`requirements-dev.txt`·중첩 `web/package.json` 미인식), 한글 goal 제목 slugify 소거(`goal-goal-xxx`), 실레포 스케일 실측(태스크당 ~7분/$1.7/116K tokens, goal 전체 ~2.5h @ concurrency 1) — 아래 Known Gaps 반영.

## (기록) R1+R2 완료 시점 상태

- **Phase R2 완료** — R1 Known Gaps의 High/Medium 전부 수술 + 크래시 복구/환경 오류 E2E 실측. 최종 관통: multiply goal이 acceptance(`npm test`) 게이트 → WIP 커밋(`chore(goal)`) → 승인 → **main 머지 `29bf871`**, npm test 3/3.
- R2 E2E가 **파이프라인 무결성 결함 3건을 추가 발견 → 즉시 수정** (아래 표). 특히 "WIP를 goal 브랜치에 커밋하는 단계가 아예 없어 에이전트의 커밋 재량에 의존"하던 설계 구멍이 핵심이었다.
- **검증 그린**: server/dashboard tsc PASS · vitest 162/162 · npm audit 11건(critical 2) → **1 low**.

## (기록) R1 완료 시점 상태

- **v0.1.0, main 단일 브랜치.** 마지막 개발 2026-05-04 → 약 2개월 방치 후 부활.
- **환경 복구 완료**: Node 26 전환으로 깨졌던 `better-sqlite3` 네이티브 빌드를 `^12.11.1`(Node 26 지원)로 해결.
- **Phase R1 스모크 완료 — 전 루프 실관통 성공**: 실제 Claude Code 서브프로세스로 goal 등록 → 기획서 → 분할(CTO/opus) → 구현(sonnet) → Evaluator 검증 → QA 회귀 자동 생성 → 승인 다이얼로그(UI) → **squash merge to main** 관통. 대상: `~/develop/swk/nova-projects/smoke-calc`, 결과 커밋 `6c2cd21`, npm test 2/2. merge 후 goal worktree/브랜치 자동 정리 확인.
- R1에서 **P0 1건(checkpoint stash가 goal WIP 파괴)·P1 1건(대시보드 백화) 발견 즉시 수정**, 나머지는 아래 Known Gaps에 승계.
- **검증 그린**: server tsc PASS · dashboard tsc PASS · vitest 157/157 (checkpoint 회귀 6건 신규 포함).

## 자산 인벤토리

| 자산 | 상태 |
|------|------|
| 오케스트레이션 엔진 (decompose→구현→검증→fix→git) | 완성, 배선 완료 (`engine.ts` 2.2k lines) |
| 스케줄러 (autopilot, AIMD backoff, DAG 의존성, 크래시 복구) | 완성 (`scheduler.ts` 1.4k lines) |
| Quality Gate (Generator-Evaluator 분리, 5-dimension) | 완성 (`evaluator.ts` 1k lines) |
| Claude Code CLI adapter (stream-json, resume, rate-limit 처리) | 완성 + 테스트 |
| Goal-as-Unit (goal worktree + squash 승인 파이프라인) | 백엔드/UI 완성, **실운영 미검증** |
| 대시보드 (Kanban, 실시간 WS, i18n ko/en, 다크모드, Cmd+K) | 완성, 전 기능 서버 연동 |
| 에이전트 프리셋 9종 + 4-tier 프롬프트 해석 | 완성 |
| 프로젝트 임포트 / GitHub 연동 / tech stack 분석 | 완성 (PR 경로는 gap 참고) |
| 문서 (설계 17편 + E2E 체크리스트) | 충실 — `docs/design/goal-as-unit*.md`가 최신 |

## Known Gaps

### R1 스모크가 발견 → 해소한 것 (2026-07-07)

| # | 발견 | 등급 | 조치 |
|---|------|------|------|
| R1-3 | **checkpoint stash가 goal WIP 파괴** — `stashCheckpoint`가 push만 하고 트리 미복원 → 후속 태스크 시작 시 이전 태스크의 미커밋 구현이 stash로 쓸려가고, 성공 시 dropCheckpoint가 stash 삭제 → 구현 영구 소실 + 빈 squash. 1차 스모크에서 subtract 구현 증발로 재현 | **P0** | **수정**: push `-u` + 즉시 `apply --index`로 트리 유지, restore는 discard-then-pop, no-stash 실패도 복원 성공 처리. 회귀테스트 6건 (`worktree-checkpoint.test.ts`) |
| R1-4 | **부분 WS 페이로드 → 대시보드 백화** — `task:updated`를 `{taskId,status}`로 broadcast(engine.ts:266) → 스토어가 id 없는 유령 태스크 append → `title.startsWith` TypeError → 에러 바운더리 없어 화면 전체 사망 | **P1** | **수정**: 서버 full row broadcast + 스토어 부분 페이로드 merge 가드 + TaskList/KanbanBoard 방어 렌더 |

### R2가 해소한 것 (2026-07-07)

**R1 승계분 (전부 해소):** Evaluator goal 누적 diff(+도구 상태 경로 제외, 회귀테스트 5건) · 승인 다이얼로그 프리뷰 재조회(`GET /goals/:id/squash-preview`) · acceptance_script POST/PATCH 수용 · macOS `/tmp` 임포트 · squash 대기 goal 접힘 방지 · residue 자동커밋 도구 상태 제외 · PR 생성 실패 명시화(ENOENT 구분 + error 반환) · base_branch 설정(API+설정 UI) · skip_adversarial 체크박스 · npm audit 11→1 low.

**R2 E2E(크래시 복구·환경 오류 실측)가 새로 발견 → 해소:**

| # | 발견 | 등급 | 조치 |
|---|------|------|------|
| R2-1 | **재시작 시 작업 중 goal worktree 삭제** — recovery의 보호 쿼리가 `squash_status NOT IN ('merged','none')`으로, 정작 작업 중(=none) goal을 보호에서 제외. 크래시 후 재기동하면 WIP 통째 소실 | **P0** | `!= 'merged'`로 수정 — 재기동 E2E에서 "Skipping active goal worktree" 실증 |
| R2-2 | **환경 오류 → 초 단위 가짜 done 연쇄** — env 오류(claude ENOENT) 시 retry=999로 예산을 소진시켜 auto-resolve가 태스크를 done(skipped) 위장. claude 자동 업데이트 중 일시 ENOENT만으로 goal 전체가 100ms 만에 가짜 완료 | **P0** | env 오류는 태스크 todo 유지 + 큐 60초 쿨다운/자동 재개(`handleEnvError`) — claude 없는 격리 서버로 실증 (todo 유지·paused·nextRetryAt 정확) |
| R2-3 | **WIP → goal 브랜치 커밋 단계 부재** — 파이프라인 어디도 누적 WIP를 커밋하지 않아 에이전트가 재량으로 커밋해야만 squash 성공. 안 하면 nothing-to-commit을 승인 라우트가 **성공으로 간주**하고 worktree/브랜치 삭제 → `merged|sha=NULL` + 작업물 파괴 | **P0** | acceptance PASS 후 `chore(goal): 작업물 커밋` 자동 커밋(도구 상태 제외) + nothing-to-commit을 blocked로 전환 — 최종 E2E에서 `6dff455` WIP 커밋 → `29bf871` 머지 실증 |

### 실프로젝트 dogfooding 발견 (2026-07-07 — proof)

| # | 발견 | 등급 | 조치 |
|---|------|------|------|
| D-1 | **architect residue 커밋이 사용자 main 오염** — pre-existing untracked 자산을 잔여물로 오인해 대상 레포 main에 커밋 | **P1** | **수정**: 세션 전 dirty 스냅샷 기준선 + 신규 경로만 `git add` (add -A . 제거) |
| D-2 | tech stack 감지 실패 — `requirements-dev.txt`(접미사)·중첩 `web/package.json`(모노레포) 미인식 → 팀 제안 fallback | Medium | **해소 (07-07)**: analyzer가 루트+1-depth 하위 디렉토리 순회, `requirements*.txt` 변형 인식 — proof 실물로 검증(Python+TS+React+pytest 감지), 회귀테스트 4건. 단, 기존 등록 프로젝트의 저장된 tech_stack은 소급 안 됨(재분석 endpoint 없음 — 아래 표) |
| D-3 | 한글 goal 제목이 slugify에서 통째로 소거 → `goal-goal-xxx` 무의미 worktree/브랜치명 | Low | **해소 (07-07)**: worktree·github 브랜치 slug 한글 보존(NFC), 빈 slug 시 `agent/x/` 잘못된 ref 방지 fallback — 회귀테스트 5건 (`worktree-slug.test.ts`) |
| D-4 | (관찰) 실레포 스케일: 태스크 ~7분/$1.7/116K tokens, 7태스크 goal ~2.5h @ concurrency 1 — 야간 autopilot 전제로는 적정, 대화형 UX로는 김 | — | 참고 데이터 |
| D-5 | (긍정 실증) Evaluator 차별 판정·fail→자동수정·blocked→백오프 재시도·restoreCheckpoint 부분 롤백·3회 중단-복구·에이전트의 worktree npm install 적응 — 전부 설계대로 동작 | — | — |

### 일상 도구화 세션 발견 (2026-07-07)

| # | 발견 | 등급 | 조치 |
|---|------|------|------|
| T-1 | **dashboard 빌드가 4월부터 깨져 있었음** — `tsc -b` 에러 2건(ActivityFeed 타입, ProjectHome null 가드). 그동안의 "dashboard tsc PASS"는 `npx tsc --noEmit`이 files:[]+references 구조에서 **아무것도 검사하지 않는 no-op**이었던 착시 | P1 | **수정**: 에러 2건 해소 + 검증 명령을 `tsc -b`로 정정 (AGENTS.md·pre-commit hook) |
| T-2 | health API의 package.json 경로가 dist 구조에서 미해석 → version "unknown" | Low | **수정**: dev/dist 양쪽 후보 경로 탐색 |
| T-3 | 대시보드 API key가 최초 1회만 브라우저에 발급(`.key-issued`) — 낡은 키가 localStorage에 있으면 `initAuth`가 재발급 시도조차 안 해 401 무한 반복 (데이터 디렉토리 이관 직후 실제 발생) | Medium | **부분 해소 (07-08)**: 401 시 키 폐기→재발급 1회 자동 시도→성공 시 리로드 (`api.ts tryReauth`, Playwright 검증). 잔여: 마커가 살아 있는 상태의 다른 브라우저는 여전히 잠김 — key 수동 입력 UI 필요 |
| T-4 | 기존 등록 프로젝트의 tech_stack 재분석 endpoint 부재 — D-2 수정이 신규 임포트에만 적용 | Low | 미해소 |
| T-5 | **번들 실행 시 role preset 전멸** — `roles.ts`가 `__dirname` 고정 3-up으로 templates를 찾는데, dist 루트 chunk 기준으로는 레포 밖을 가리켜 ENOENT → 9종 preset 전부 fallback 프롬프트로 강등 (dev tsx에서는 재현 안 됨, 서비스 첫 spec spawn 로그에서 발견) | P2 | **수정**: dev/dist 깊이별 후보 경로 순회 + cwd fallback |
| T-6 | **스케줄러 reviewer-gate 데드락** — "reviewer 태스크는 sibling 완료까지 연기" 휴리스틱이 DAG를 무시. decompose가 감사/분석 태스크(DAG 루트)를 reviewer 역할에 배정하자 루트는 gate에 연기, siblings는 루트 의존 대기 → 순환 대기로 큐 영구 정지 (proof goal 2호 "목업 정합 감사 매트릭스"에서 실측, stuck 경고만 반복) | **P1** | **수정**: 미완료 dependent가 있는 reviewer 태스크는 gate 면제 — DAG가 순서를 이미 보장 |

### 유지보수성 / 부채

| Gap | 내용 | 우선순위 |
|-----|------|----------|
| `AgentRole` 타입 드리프트 | `shared/types.ts`의 유니온(coder/reviewer/…)이 실제 9 role과 불일치. DB는 CHECK 제거로 임의 role 허용 — 타입만 낡음 | Medium |
| 통합 테스트 부재 | 유닛 테스트만 존재 — spawn→verify→git 루프 회귀를 못 잡음 | Medium |
| ~~nova-rules sibling 의존~~ | **해소 (07-07)**: Orbit 독립 결정 — sync 기계장치 전부 제거(`sync:nova`·predev 자동sync·version API·대시보드 위젯), rules .md는 Orbit 소유로 고정·직접 편집 | — |
| rules 내 NOVA-STATE.md 언급 잔존 | 폐기된 NOVA-STATE 컨벤션 언급 10곳 (`rules.md`·`orchestrator-protocol.md`·`evaluator-protocol.md`) — 이제 Orbit 소유라 직접 정리 가능 | Low |
| `engine-logic.test.ts`의 `pending_fix` | schema CHECK에 없는 status를 테스트가 참조 | Low |
| docs 디렉토리 중복 | `docs/design/` vs `docs/designs/`, `docs/verification/` vs `docs/verifications/` 통합 | Low |
| concurrency>1 race 실측 | CAS 락 방어는 했으나 고부하 미검증 (기본 1이라 시급도 낮음) | Low |
| AIMD 쿨다운 resume | 장시간 운영 재현 테스트 필요 | Low |
| branch_pr squash UX | `gh pr create --squash` 미존재 — GitHub UI 선택에 의존 | Low |
| DAG 100+ 태스크 성능 | 미측정 | Low |

## 부활 로드맵

### ~~Phase R1 — 재가동 스모크~~ ✅ 완료 (2026-07-07)
전 루프 1회 실관통 성공. 발견 이슈 9건 → P0/P1 2건 즉시 수정, 7건 승계.

### ~~Phase R2 — gaps 해소 + 크래시/환경 오류 E2E~~ ✅ 완료 (2026-07-07)
R1 승계 gap 전부 해소 + 크래시 복구(SIGKILL 2회)·환경 오류(claude-less 격리 서버) E2E 실측으로 P0 3건 추가 발견·수정. 최종 관통: acceptance 게이트 포함 goal이 main 머지(`29bf871`)까지 완주.
미완주 잔여: PR 모드 실검증(원격 저장소 필요), concurrency>1 고부하 — 아래 유지보수 표 참고.

### ~~Phase R3 — 제품 방향 재점검~~ ✅ 결정 완료 (2026-07-07)
**결정: 개인 운영 도구(givepro91)로 확정, 사내 활용 보류, 대외 제품화 중단.** 분석·결정 상세: `docs/design/r3-product-direction.md`. 이후 운영 모델: 개인 프로젝트 dogfooding 중 발견 결함만 수정. C(Quality Gate의 CC 생태계 이식)는 CC Agent Teams 안정화 시 재판단.

#### (기록) R3 원래 프레임
개발 중단(2026-04) 이후 Claude Code 자체가 네이티브 멀티에이전트(팀/워크플로우) 기능을 갖추며 가치제안이 일부 겹침. 부활 시점의 차별화 포인트 재정의 필요:
- Nova Orbit 고유 가치: **Quality Gate(Generator-Evaluator 분리)** + **비개발자 친화 대시보드** + **goal 단위 승인 게이트**
- 검토 질문: CLI subprocess 방식 유지 vs Agent SDK 전환 / 대시보드 단독 제품화 / 사내 도구화 범위
- README 전면 리프레시는 방향 확정 후 (현 세션에서는 사실 오류만 정정)

## 세션 로그

| 날짜 | 내용 |
|------|------|
| 2026-07-08 (2) | **AI 팀 설계자** — 스마트 팀 구성이 규칙표(고정 preset 매핑)만 쓰던 것을, 프로젝트를 실제로 읽는(mission·docs·구조·스택) Claude 세션 1개가 도메인 특화 팀(name·reason·system_prompt)을 설계하도록 확장 (`team-designer.ts`). role은 VALID_ROLES 안에서 유지(라우팅 배관), 특화는 name+prompt가 담당. `.claude/agents/` 사용자 정의 최우선·LLM 실패 시 규칙표 fallback 유지. AI 프롬프트는 `prompt_source='custom'`으로 저장돼 주입 1순위. 실사용 피드백 2건 반영: **cto/pm 조정자 보장**(없으면 분할 sonnet 강등·architect 스킵 — reviewer 보장과 같은 패턴), **조직 트리 자동 구성**(조정자를 루트로 parent_id 연결 — dialog·suggest-and-create 양 경로), **설계 캐시(10분)+인플라이트 공유**(모달 이탈·새로고침 시 opus 세션 낭비/중복 방지, "다시 설계" 버튼으로 명시 재설계). 유닛 18건 |
| 2026-07-08 | **proof goal 2호 완주** — "6개 목업 정합 감사 → 화면별 갭 클로징" (8태스크 + QA 회귀, ~2.5h): 시각 검증 게이트(Author≠Verify) 포함 전 구간 무인 완주 → 승인 → main 머지 `cd71c4f`. **launchd 상시 서비스 위에서의 첫 실전 goal** — 이 과정에서 T-6(스케줄러 데드락)·T-5(preset 강등)·T-3(401 잠금) 실측 발견·수정. D-1 수정 검증: 사용자 untracked 목업 PNG는 오커밋되지 않음 |
| 2026-07-07 (8) | **Nova 의존 절단 — Orbit 독립 선언**: sync 기계장치 전부 제거 (`sync:nova` 스크립트·predev 자동sync·`/api/nova-rules/version·sync` endpoint·대시보드 Nova 버전 위젯·version.json). rules .md 3종은 Orbit 소유 콘텐츠로 고정, 직접 편집 가능 |
| 2026-07-07 (7) | 레포 이관: `TeamSPWK/nova-orbit` → **`givepro91/nova-orbit`** (신규 생성+전체 push, 원본은 archive+이전 안내 표기 — 이슈/PR 0이라 메타 손실 없음). package.json repository/homepage/author 갱신. R3 후속 정리 완료 |
| 2026-07-07 (6) | 일상 도구화: dist 실행 경로 검증(T-1 dashboard 빌드 파손 발견·수정), 데이터 디렉토리 `~/.nova-orbit` 확정+이관(휘발성 tmp에서 구조), launchd 상시 기동(`service-macos.sh`), D-2·D-3 해소(회귀테스트 9건), typecheck 명령 정정. 검증: tsc×2 PASS, vitest 171/171, 산출물 서버 curl+Playwright 관통 |
| 2026-07-07 (5) | R3 결정: **개인 운영 도구(givepro91) 확정, 사내 보류, 대외 제품화 중단** — 분석 `docs/design/r3-product-direction.md`, README 상태 표기. 부활 로드맵(R1·R2·dogfooding·R3) 전체 완료 |
| 2026-07-07 (4) | 실프로젝트 dogfooding (proof): AI 추천 goal 완주 → main 머지 `46fb88d`. P1(architect residue의 사용자 자산 오커밋) 발견·수정, D-2~D-5 기록. 검증: tsc×2 PASS, vitest 162/162, proof 양 스택 테스트 그린 |
| 2026-07-07 (3) | Phase R2: R1 gaps 10건 해소 + 크래시/환경 오류 E2E로 P0 3건(worktree 삭제·env 가짜 done·WIP 커밋 부재) 발견·수정. 최종 관통 `29bf871` (acceptance 게이트 포함). audit 11→1. 검증: tsc×2 PASS, vitest 162/162 |
| 2026-07-07 (2) | Phase R1 스모크: smoke-calc 대상 전 루프 실관통 성공 (`6c2cd21` squash merge). P0 checkpoint stash WIP 파괴 + P1 대시보드 백화 발견·수정, 회귀테스트 6건 추가, 발견 이슈 7건 Known Gaps 승계. 검증: tsc×2 PASS, vitest 157/157 |
| 2026-07-07 (1) | 부활 세션: 환경 복구(Node 26), 테스트 현행화(151 green), NOVA-STATE/.nova 폐기, CLAUDE.md·AGENTS.md 전면 재작성, 본 로드맵 신설 |
| 2026-05-04 | (구) 에이전트 지침 재배치 + hard guard 3건 |
| 2026-04-21 | (구) Goal-as-Unit 아키텍처 전환 + Known Gaps 수습 — 상세는 git history 및 `docs/design/goal-as-unit*.md` |
