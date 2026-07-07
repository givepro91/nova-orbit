# Goal-as-Unit E2E 검증 체크리스트

작성일: 2026-04-21
대상: Goal-as-Unit 아키텍처 (커밋 `3698892` ~ `c42b9f6`)

자동 smoke: `bash scripts/smoke-goal-as-unit.sh` — schema + 이상 상태만 확인.
이 문서: **실제 사용자가 1회 관통해야 하는** 시나리오.

---

## 전제 조건

- Nova Orbit 서버 기동 (`npm run dev:server` 또는 `node dist/bin/nova-orbit.js`)
- Dashboard 접속 (http://localhost:5173 또는 서버 embedded)
- 테스트용 프로젝트 1개 등록됨 (import 또는 GitHub connect)
- 프로젝트에 `qa` 또는 `reviewer` 역할 에이전트 1명 이상 존재 (QA 회귀 태스크 할당용)

---

## ① 기본 흐름 — 신규 goal Full Auto 관통

### 시나리오
사용자가 신규 goal 을 추가 → Full Auto 모드로 실행 → 태스크 순차 실행 → QA 회귀 태스크 생성 → 완료 시 `pending_approval` → 승인 → `merged`.

### 체크
- [ ] 신규 goal 생성 시 DB 의 `goals.goal_model` = `goal_as_unit` 인가?
  ```bash
  sqlite3 ~/.nova-orbit/nova-orbit.db "SELECT id, title, goal_model FROM goals ORDER BY created_at DESC LIMIT 1"
  ```
- [ ] decompose 완료 후 태스크 목록에 **`[사전 조사] 실세계 실패 패턴 10가지 수집`** 태스크가 있는가 (adversarial 주입)?
  - 단, goal title/description 에 `감지/분석/추출/파싱/detect/parse/extract/analyze` 등 키워드 포함 + 50자 이상 일 때만.
- [ ] 첫 태스크 시작 시 goal 전용 worktree 가 생성되는가?
  ```bash
  ls ~/.nova-orbit/projects/<project_id>/.nova-worktrees/
  # goal-{slug}-xxxx 형태 디렉토리 존재
  ```
- [ ] 태스크 완료 시마다 `git log` 에 **개별 커밋이 쌓이지 않는가**? (legacy 와 다름)
- [ ] 모든 구현 태스크 완료 시 **QA 회귀 태스크** 가 자동 생성되는가?
  - 제목: `[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰`
  - 담당자: qa 또는 reviewer 에이전트
- [ ] QA 회귀 태스크 완료 후 Goal 카드에 **"목표 반영 대기 중"** 배지 + **[목표 반영]** 버튼이 노출되는가?
- [ ] [목표 반영] 클릭 시 `GoalSquashApprovalDialog` 가 열리고:
  - [ ] 목표 제목
  - [ ] 반영 브랜치
  - [ ] 커밋 메시지 프리뷰
  - [ ] 변경 파일 목록 (0 아니어야 함)
  - [ ] (있을 경우) 검증 스크립트 결과
- [ ] [목표 반영 확정] 클릭 → `main` 에 **1 개의 squash 커밋** 만 추가되는가?
  ```bash
  git log --oneline | head -5
  ```
- [ ] Goal 카드가 **"반영 완료 {7자 sha}"** 로 전환되는가?
- [ ] worktree 디렉토리가 정리되는가?

---

## ② acceptance_script 게이트

### 시나리오
goal 생성 시 acceptance_script 지정 → 모든 태스크 완료 → acceptance 실행 → PASS/FAIL 에 따라 분기.

### 체크
- [ ] Goal 생성 모달에 "완료 검증 스크립트" textarea 가 있는가?
- [ ] 생성 후 DB `goals.acceptance_script` 에 저장되는가?
- [ ] 모든 태스크 완료 → QA 완료 → squash 직전에 `acceptance_script` 가 실행되는가? (activity 로그에서 확인)
- [ ] 실패(종료 코드 ≠ 0) 시 `goals.squash_status` = `blocked` 로 전환되고 Goal 카드에 "반영 차단" 배지가 뜨는가?
- [ ] 성공 시 정상적으로 `pending_approval` 로 전환되는가?

---

## ③ legacy 호환

### 시나리오
이번 업그레이드 이전에 생성된 goal (`goal_model='legacy'`) 이 있을 때 신기능이 영향 안 주는지.

### 체크
- [ ] 기존 legacy goal 에는 squash 배지/버튼이 **표시되지 않는가**?
- [ ] 기존 legacy goal 의 태스크 실행 시 **task-per-worktree + 개별 commit** 동작이 유지되는가?
- [ ] DB `SELECT goal_model, COUNT(*) FROM goals GROUP BY goal_model` 에서 legacy 가 보존되는가?

---

## ④ 실패/복구 흐름

### 태스크 중간 실패 → 체크포인트 복원
- [ ] 구현 태스크 1개가 QG FAIL → worktree 에 해당 태스크 변경만 롤백됐는가?
  - stash 목록: `git -C <worktree> stash list` 에 `nova-checkpoint-*` 확인
- [ ] 재시도 후 성공 시 정상 진행되는가?

### 서버 재시작 시 `pending_approval` 복구
- [ ] `pending_approval` 상태에서 서버 재시작 → 재시작 후 Dashboard 에 다시 [목표 반영] 버튼이 노출되는가?
  - 배경: `recovery.ts rebroadcastPendingApprovals()` 가 동작해야 함
- [ ] worktree 가 없는 경우 `blocked` 로 전환되는가?

### 서버 재시작 시 `triggering` 고착 복구
- [ ] 서버 로그에 `Recovered N goals from 'triggering' state` 가 뜨는가?
- [ ] DB 에 `squash_status='triggering'` goal 이 없는가 (재시작 후)?

---

## ⑤ 설정/override

### baseBranch
- [ ] `projects.base_branch` 를 `develop` 으로 설정한 프로젝트에서 squash 가 develop 으로 merge 되는가?
  ```sql
  UPDATE projects SET base_branch='develop' WHERE id='...';
  ```
  - `git diff --name-only develop...HEAD` 에 변경 파일이 정확히 표시되는가?
  - `git log` 에서 develop 브랜치에 1 커밋이 추가되는가?

### skip_adversarial
- [ ] `POST /goals` 에서 `skip_adversarial: true` 로 생성한 goal 은 adversarial 태스크가 **안 주입되는가**?

### concurrency
- [ ] `NOVA_MAX_CONCURRENCY=3` 로 override 후 Goal-as-Unit goal 실행 시에도 정상 동작하는가?
  - 주의: concurrency>1 은 현재 Goal-per-worktree 와 충돌 가능성 — race 확인

---

## ⑥ UI 세부

- [ ] 다크모드에서 모든 배지/다이얼로그 색상 정상?
- [ ] EN 언어 전환 시 `goal-as-unit` 관련 i18n 문자열이 영문으로 나오는가? ("Goal Merge", "Pending Approval", 등)
- [ ] Escape 키로 `GoalSquashApprovalDialog` 닫히는가?
- [ ] 승인 진행 중 버튼 비활성 + 스피너?
- [ ] `[사전 조사]` 태스크에 violet 배지 ("사전 조사") 가 붙는가?

---

## ⑦ 측정 지표

goal 완료 후 수집:

| 지표 | 목표 |
|------|------|
| goal 당 커밋 수 | **1** |
| false-positive / 오탐 (drift 재현 시) | 10 미만 |
| `pending_approval` 대기 시간 (사용자가 보고 승인하기까지) | 참고용 |
| QA 회귀 태스크 완료율 | 90%+ |
| squash 실패율 | < 5% |

---

## ⑧ 알려진 비검증 항목

다음은 현재 환경에서 실측 불가, 사용자 실운영 중 관찰 필요:

- concurrency>1 실제 race (CAS 락으로 방어했으나 고부하 미검증)
- QA 에이전트의 실제 "앱 실행 + UI 클릭" 능력 (에이전트 성능 의존)
- branch_pr 모드에서 GitHub UI squash-merge 선택 경로
- base_branch='develop' 에서 `gh pr create` 타겟 (GitHub 기본 브랜치가 develop 으로 설정된 프로젝트)

이슈 발견 시 `docs/ROADMAP.md` Known Gaps 에 추가 후 세션 재개.
