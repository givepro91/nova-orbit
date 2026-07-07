# Nova Orbit — 현재 상태 & 부활 로드맵

> 이 파일이 프로젝트의 살아있는 상태 문서다 (구 `NOVA-STATE.md` 대체 — Nova Engineering 방법론 파일은 2026-07-07 폐기).
> 굵직한 세션을 마칠 때마다 갱신한다.

## 현재 상태 (2026-07-07 · R1+R2+실프로젝트 dogfooding 완료)

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
| D-2 | tech stack 감지 실패 — `requirements-dev.txt`(접미사)·중첩 `web/package.json`(모노레포) 미인식 → 팀 제안 fallback | Medium | 미해소 — analyzer 확장 필요 |
| D-3 | 한글 goal 제목이 slugify에서 통째로 소거 → `goal-goal-xxx` 무의미 worktree/브랜치명 | Low | 미해소 — 유니코드 slug 또는 goal id 사용 |
| D-4 | (관찰) 실레포 스케일: 태스크 ~7분/$1.7/116K tokens, 7태스크 goal ~2.5h @ concurrency 1 — 야간 autopilot 전제로는 적정, 대화형 UX로는 김 | — | 참고 데이터 |
| D-5 | (긍정 실증) Evaluator 차별 판정·fail→자동수정·blocked→백오프 재시도·restoreCheckpoint 부분 롤백·3회 중단-복구·에이전트의 worktree npm install 적응 — 전부 설계대로 동작 | — | — |

### 유지보수성 / 부채

| Gap | 내용 | 우선순위 |
|-----|------|----------|
| `AgentRole` 타입 드리프트 | `shared/types.ts`의 유니온(coder/reviewer/…)이 실제 9 role과 불일치. DB는 CHECK 제거로 임의 role 허용 — 타입만 낡음 | Medium |
| 통합 테스트 부재 | 유닛 테스트만 존재 — spawn→verify→git 루프 회귀를 못 잡음 | Medium |
| nova-rules sibling 의존 | `server/core/nova-rules/`는 `../nova` 레포에서 sync — 배포/협업 시 재현성 문제. 번들 고정 or 서브모듈 검토. 내부에 NOVA-STATE.md 언급 잔존 (sync 원본에서 고쳐야 함) | Medium |
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

### Phase R3 — 제품 방향 재점검 (전략)
개발 중단(2026-04) 이후 Claude Code 자체가 네이티브 멀티에이전트(팀/워크플로우) 기능을 갖추며 가치제안이 일부 겹침. 부활 시점의 차별화 포인트 재정의 필요:
- Nova Orbit 고유 가치: **Quality Gate(Generator-Evaluator 분리)** + **비개발자 친화 대시보드** + **goal 단위 승인 게이트**
- 검토 질문: CLI subprocess 방식 유지 vs Agent SDK 전환 / 대시보드 단독 제품화 / 사내 도구화 범위
- README 전면 리프레시는 방향 확정 후 (현 세션에서는 사실 오류만 정정)

## 세션 로그

| 날짜 | 내용 |
|------|------|
| 2026-07-07 (4) | 실프로젝트 dogfooding (proof): AI 추천 goal 완주 → main 머지 `46fb88d`. P1(architect residue의 사용자 자산 오커밋) 발견·수정, D-2~D-5 기록. 검증: tsc×2 PASS, vitest 162/162, proof 양 스택 테스트 그린 |
| 2026-07-07 (3) | Phase R2: R1 gaps 10건 해소 + 크래시/환경 오류 E2E로 P0 3건(worktree 삭제·env 가짜 done·WIP 커밋 부재) 발견·수정. 최종 관통 `29bf871` (acceptance 게이트 포함). audit 11→1. 검증: tsc×2 PASS, vitest 162/162 |
| 2026-07-07 (2) | Phase R1 스모크: smoke-calc 대상 전 루프 실관통 성공 (`6c2cd21` squash merge). P0 checkpoint stash WIP 파괴 + P1 대시보드 백화 발견·수정, 회귀테스트 6건 추가, 발견 이슈 7건 Known Gaps 승계. 검증: tsc×2 PASS, vitest 157/157 |
| 2026-07-07 (1) | 부활 세션: 환경 복구(Node 26), 테스트 현행화(151 green), NOVA-STATE/.nova 폐기, CLAUDE.md·AGENTS.md 전면 재작성, 본 로드맵 신설 |
| 2026-05-04 | (구) 에이전트 지침 재배치 + hard guard 3건 |
| 2026-04-21 | (구) Goal-as-Unit 아키텍처 전환 + Known Gaps 수습 — 상세는 git history 및 `docs/design/goal-as-unit*.md` |
