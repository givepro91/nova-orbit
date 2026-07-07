# Nova Orbit — 현재 상태 & 부활 로드맵

> 이 파일이 프로젝트의 살아있는 상태 문서다 (구 `NOVA-STATE.md` 대체 — Nova Engineering 방법론 파일은 2026-07-07 폐기).
> 굵직한 세션을 마칠 때마다 갱신한다.

## 현재 상태 (2026-07-07 부활 세션)

- **v0.1.0, main 단일 브랜치.** 마지막 개발 2026-05-04 → 약 2개월 방치 후 부활 착수.
- **환경 복구 완료**: Node 26 전환으로 깨졌던 `better-sqlite3` 네이티브 빌드를 `^12.11.1`(Node 26 지원)로 해결.
- **검증 그린**: server tsc PASS · dashboard tsc PASS · vitest 151/151 PASS (낡은 테스트 3건 현행화 포함).
- **완성도**: 서버 ~85-90% 완성 (전 루프 배선 완료), 대시보드 전 기능 API 연동, mock 없음. **실운영 E2E 검증 직전에 멈춘 상태** — 미완성 프로토타입이 아님.

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

### 부활 Phase에서 우선 해소

| Gap | 내용 | 우선순위 |
|-----|------|----------|
| E2E 실운영 검증 | `docs/verification/goal-as-unit-e2e.md` 체크리스트 8섹션을 실제 프로젝트로 관통한 적 없음 | **High** |
| QA 회귀 에이전트 능력 | "앱 실행 + UI 클릭" 수행이 에이전트 능력 의존 — 실측 필요 | High |
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

## 부활 로드맵 (제안)

### Phase R1 — 재가동 스모크 ✦ 다음 세션
서버 기동 → 대시보드 접속 → 프로젝트 임포트 → goal 1개로 decompose→구현→검증→squash 전 루프를 실제로 1회 관통. `scripts/smoke-goal-as-unit.sh` + 육안 확인. 여기서 나오는 이슈가 진짜 백로그다.

### Phase R2 — E2E 체크리스트 관통 + High/Medium gaps 해소
`goal-as-unit-e2e.md` 8섹션 완주, base_branch·skip_adversarial UI 추가, PR silent 실패 수정, audit 조치.

### Phase R3 — 제품 방향 재점검 (전략)
개발 중단(2026-04) 이후 Claude Code 자체가 네이티브 멀티에이전트(팀/워크플로우) 기능을 갖추며 가치제안이 일부 겹침. 부활 시점의 차별화 포인트 재정의 필요:
- Nova Orbit 고유 가치: **Quality Gate(Generator-Evaluator 분리)** + **비개발자 친화 대시보드** + **goal 단위 승인 게이트**
- 검토 질문: CLI subprocess 방식 유지 vs Agent SDK 전환 / 대시보드 단독 제품화 / 사내 도구화 범위
- README 전면 리프레시는 방향 확정 후 (현 세션에서는 사실 오류만 정정)

## 세션 로그

| 날짜 | 내용 |
|------|------|
| 2026-07-07 | 부활 세션: 환경 복구(Node 26), 테스트 현행화(151 green), NOVA-STATE/.nova 폐기, CLAUDE.md·AGENTS.md 전면 재작성, 본 로드맵 신설 |
| 2026-05-04 | (구) 에이전트 지침 재배치 + hard guard 3건 |
| 2026-04-21 | (구) Goal-as-Unit 아키텍처 전환 + Known Gaps 수습 — 상세는 git history 및 `docs/design/goal-as-unit*.md` |
