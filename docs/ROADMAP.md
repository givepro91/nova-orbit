# Nova Orbit — 현재 상태 & 부활 로드맵

> 이 파일이 프로젝트의 살아있는 상태 문서다 (구 `NOVA-STATE.md` 대체 — Nova Engineering 방법론 파일은 2026-07-07 폐기).
> 굵직한 세션을 마칠 때마다 갱신한다.

## 현재 상태 (2026-07-07 부활 세션 · R1 완료)

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

### 부활 Phase에서 우선 해소 (R2)

| Gap | 내용 | 우선순위 |
|-----|------|----------|
| E2E 체크리스트 완주 | R1은 핵심 루프 1회 관통. `docs/verification/goal-as-unit-e2e.md` 8섹션(재시작 복구·blocked 경로·PR 모드 등)은 미완주 | **High** |
| Evaluator "no reviewable changes" auto-pass | 리뷰/QA 태스크가 자기 diff가 없다는 이유로 conditional 자동 통과 — R1에서 WIP 소실 신호를 삼킨 전례. 리뷰/검증형 태스크에는 goal 누적 diff를 평가 대상으로 줘야 함 | High |
| 승인 다이얼로그 프리뷰 상실 | 페이지 리로드 후 커밋 메시지/변경 파일/acceptance 결과 프리뷰가 사라짐 (WS 페이로드에만 의존, 재조회 API 없음) — 사용자가 내용을 못 보고 확정 | Medium |
| acceptance_script 설정 경로 없음 | UI(AddGoal/EditGoal)는 보내지만 goals POST/PATCH가 필드를 받지 않아 조용히 유실. engine은 읽음 | Medium |
| macOS `/tmp` 임포트 불가 | `validate-path.ts:12` — realpath가 `/private/tmp`로 풀린 뒤 `/tmp` prefix 검사라 dead code | Low-Med |
| squash 대기 goal이 접힘 | progress 100%가 되면 "완료 목표"로 접혀 승인 배지/버튼이 숨겨짐 — 승인 대기 goal은 접지 말아야 | Low-Med |
| 에이전트 세션 잔여물 오염 | 서브프로세스 세션이 대상 레포에 `.omc/` 등 도구 상태를 남기고, architect residue 자동커밋이 이를 커밋함 — ignore 필터 필요 | Low-Med |
| PR 생성 silent 실패 | `gh` CLI 부재 시 `github.ts:createPullRequest`가 조용히 넘어감 — 사용자 의도와 발산 | Medium |
| base_branch 설정 경로 없음 | DB 컬럼만 존재, API/UI 없음 (SQL 직접 수정 필요) | Medium |
| skip_adversarial UI 토글 없음 | API만 지원, goal 생성 UI에 체크박스 없음 | Medium |
| npm audit 11건 (critical 2) | 2026-07-07 install 시 보고 — 내역 확인 + `npm audit fix` 검토 | Medium |

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
전 루프 1회 실관통 성공 (위 현재 상태 참고). 발견 이슈 9건 → P0/P1 2건 즉시 수정, 7건 Known Gaps 승계.

### Phase R2 — E2E 체크리스트 관통 + High/Medium gaps 해소 ✦ 다음 세션
`goal-as-unit-e2e.md` 8섹션 완주(재시작 복구·blocked 롤백·PR 모드), Evaluator 리뷰형 태스크에 goal diff 제공, 승인 다이얼로그 프리뷰 재조회, acceptance_script API 수용, base_branch·skip_adversarial UI, PR silent 실패 수정, audit 조치.

### Phase R3 — 제품 방향 재점검 (전략)
개발 중단(2026-04) 이후 Claude Code 자체가 네이티브 멀티에이전트(팀/워크플로우) 기능을 갖추며 가치제안이 일부 겹침. 부활 시점의 차별화 포인트 재정의 필요:
- Nova Orbit 고유 가치: **Quality Gate(Generator-Evaluator 분리)** + **비개발자 친화 대시보드** + **goal 단위 승인 게이트**
- 검토 질문: CLI subprocess 방식 유지 vs Agent SDK 전환 / 대시보드 단독 제품화 / 사내 도구화 범위
- README 전면 리프레시는 방향 확정 후 (현 세션에서는 사실 오류만 정정)

## 세션 로그

| 날짜 | 내용 |
|------|------|
| 2026-07-07 (2) | Phase R1 스모크: smoke-calc 대상 전 루프 실관통 성공 (`6c2cd21` squash merge). P0 checkpoint stash WIP 파괴 + P1 대시보드 백화 발견·수정, 회귀테스트 6건 추가, 발견 이슈 7건 Known Gaps 승계. 검증: tsc×2 PASS, vitest 157/157 |
| 2026-07-07 (1) | 부활 세션: 환경 복구(Node 26), 테스트 현행화(151 green), NOVA-STATE/.nova 폐기, CLAUDE.md·AGENTS.md 전면 재작성, 본 로드맵 신설 |
| 2026-05-04 | (구) 에이전트 지침 재배치 + hard guard 3건 |
| 2026-04-21 | (구) Goal-as-Unit 아키텍처 전환 + Known Gaps 수습 — 상세는 git history 및 `docs/design/goal-as-unit*.md` |
