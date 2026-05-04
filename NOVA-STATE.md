# Nova State

## Current
- **Goal**: 오케스트레이션 프로세스 개선 + Known Gaps 수습 (2 오케스트레이션 연속)
- **Phase**: 백엔드 + UI + 안정성 + Edge + E2E 체크리스트 완료 — 실운영 검증 대기
- **Blocker**: none

## Tasks (이번 세션 — 2026-04-21)

### 오케스트레이션 1 — 프로세스 개선 (`orch-mo7yfv1z-g3ct`)
| Phase | Status | Note |
|-------|--------|------|
| Phase 1 — 동시성 기본값 3→1 | done | wall-clock < 맥락 일관성 |
| Phase 2 — Goal-as-Unit 백엔드 | done | 설계+구현+Evaluator+Fix |
| Phase 3 — Adversarial + QA 회귀 | done | 설계+구현+Evaluator+Fix |

### 오케스트레이션 2 — Known Gaps 수습 (`orch-mo7zyif8-n8sk`)
| Phase | Status | Note |
|-------|--------|------|
| Phase 4 — Dashboard UI | done | 설계+구현+Evaluator+Fix (10파일) |
| Phase 5 — 안정성 보강 | done | baseBranch + DAG + skip + CAS + Fix |
| Phase 6 — Edge fixes | done | goalSlug uid + gh squash 주석 |
| Phase 7 — E2E 검증 | done | smoke.sh + 체크리스트 8섹션 |

## Recently Done (max 3)
| Task | Completed | Refs |
|------|-----------|------|
| 에이전트 지침 재배치 + hard guard 적용 (AGENTS.md/.claude/rules/settings/pre-commit/ESLint) | 2026-05-04 | (이번 커밋) |
| Known Gaps 수습 4 phase | 2026-04-21 | `0a01aff`, `b56764c`, `5d6583d`, `ce6a96f`, `9b305a5`, `c42b9f6`, `5f60143` |
| 오케스트레이션 프로세스 개선 3 phase | 2026-04-21 | `3698892`, `454dcfa`, `d94e325`, `92eea62`, `1984f68`, `7414d1c`, `d360a62` |

## Known Gaps
| Area | Uncovered Content | Priority |
|------|-------------------|----------|
| E2E 실운영 검증 | `docs/verification/goal-as-unit-e2e.md` 체크리스트 관통 필요 | **High** |
| QA 회귀 에이전트 능력 | 실제 "앱 실행 + UI 클릭" 수행 능력은 에이전트 의존 | High |
| concurrency>1 고부하 | CAS 락 방어했으나 race 실측 미완 | Medium |
| base_branch 설정 UI | DB 컬럼만 존재, API/UI 로 설정 경로 없음 — SQL 직접 수정 필요 | Medium |
| skip_adversarial UI 토글 | API 만 지원, goal 생성 UI 에 체크박스 없음 | Medium |
| branch_pr squash UX | `gh pr create --squash` 미존재 — 사용자가 GitHub UI 에서 선택 (주석만 명시) | Low |
| DAG 순환 edge 그래프 | 매우 깊은(100+) 태스크 그래프 성능 미측정 | Low |
| AIMD 쿨다운 resume | 장시간 운영 시 재현 테스트 필요 (이전 세션부터) | Medium |

## Key Architecture Changes (2026-04-21)

### Goal-as-Unit 아키텍처 전환
- **Before**: Task-per-worktree, 태스크 단위 commit → goal 당 N 커밋 파편화
- **After**: Goal-per-worktree, WIP 유지, goal 완료 시 **1 squash commit**
- 신규 컬럼: `goals.{goal_model, worktree_path, worktree_branch, acceptance_script, squash_commit_sha, squash_status, qa_regression_task_id, skip_adversarial}`, `projects.base_branch`, `tasks.acceptance_script`
- squash_status enum: `none | triggering | pending_approval | approved | merged | blocked`
- 호환성: `goal_model='legacy'` 기본값 — 기존 goal 그대로 동작

### 태스크 체크포인트 (stash 기반)
- 태스크 시작 전 `git stash push -m "nova-checkpoint-{taskId}"`
- 실패 시 restoreCheckpoint — 해당 태스크만 롤백, goal 전체 보존
- 충돌 시 `checkout -- .` + `stash drop` + blocked 전환

### Squash Merge + 사용자 승인 파이프라인
- 모든 태스크 완료 + QA 회귀 태스크 완료 → `acceptance_script` 실행 → `pending_approval`
- CAS 락 (`UPDATE ... WHERE squash_status='none'`) 로 동시 진입 차단
- 서버 재시작 시 `pending_approval` 재broadcast + `triggering` 고착 복구
- 모드별: `local_only` / `main_direct` / `pr` — `projects.base_branch` 전파

### Adversarial Task 자동 주입
- Goal title/desc 에 감지/분석/추출/파싱/detect/parse/... 키워드 포함 + 50자 이상 시
- `[사전 조사] 실세계 실패 패턴 10가지 수집` 태스크 order=1 prepend
- `goals.skip_adversarial=1` 로 끄기 가능 (POST /goals body)
- MAX 꽉 찬 경우 low-priority 드롭 후 depends_on 정리

### QA 회귀 태스크 자동 생성
- Goal 모든 태스크 완료 → triggerGoalSquash 첫 호출 → QA 회귀 태스크 1개 생성 (idempotent)
- assignee fallback: qa → reviewer → qa*/test* → coder → non-cto → any
- QA done 후에야 실제 squash 진입

### DAG 순환 감지
- decomposeGoal Phase 2 직후 Tarjan-esque DFS 로 순환 탐지
- 발견 시 해당 태스크 `depends_on = []` 리셋 + activity 기록

### Dashboard UI
- `GoalSquashApprovalDialog` — 커밋 메시지/파일/acceptance 결과 프리뷰
- Goal 카드 squash 배지 5상태 (pending_approval/approved/merged/blocked/triggering 숨김)
- QA 회귀 대기 배지
- AddGoalDialog/EditGoalDialog acceptance_script 필드 (AI 추천 경로도 지원)
- WebSocket 핸들러 5종 (squash_ready, merged, blocked, failed, qa_regression_created)
- merged/approved 상태 퇴행 가드
- i18n: ko.ts + en.ts, "목표 반영 / 완료 검증 스크립트 / 실전 QA 회귀" 용어
- Adversarial 태스크 violet 배지 (`[사전 조사]` prefix)

### 동시 실행 기본값 3→1
- Solo founder 워크플로우 — 품질 > wall-clock
- 병렬 실행이 선행 태스크 output 못 받아 false-positive 파생 (drift 사례)
- `NOVA_MAX_CONCURRENCY` env 로 override 가능

### 검증 인프라
- `scripts/smoke-goal-as-unit.sh`: schema 컬럼 + 이상 상태 자동 감지
- `docs/verification/goal-as-unit-e2e.md`: 실사용 체크리스트 8섹션

## 이전 세션 아키텍처 (유지)

### delegation 중복 방지 가드 (2026-04-14)
- delegation.ts `SELECT COUNT(*) FROM tasks WHERE parent_task_id = ?` 가드

### 오케스트레이션 3대 개선 (2026-04-12)
1. task_type 컬럼 + evaluator 4분기 검증
2. 적응형 동시성 AIMD
3. 태스크 의존성 그래프 (depends_on)

## Last Activity
- /nova:claude-md → APPLIED — AGENTS.md 분리·CLAUDE.md condense·.claude/rules×4·hard guard 3건(settings deny+pre-commit+ESLint) | 2026-05-04
- /nova:orchestrator → PASS — Known Gaps 수습 4 phase 완료 (7 커밋) | 2026-04-21T02:58+09:00
- /nova:orchestrator → PASS — 오케스트레이션 프로세스 개선 3 phase 완료 (6 커밋) | 2026-04-21T02:17+09:00
- context compacted | 2026-04-21T01:21:19Z
