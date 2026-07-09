# Quality Gate 탈-ceremony + 조건부 검증 (설계)

> 상태: 설계 승인됨 (2026-07-09). 근거: `project_quality_gate_verdict` 메모리 — DB 70건 실측으로 게이트는 유효(fail 30%, 테스트로 못 잡는 soft-lock·무한보상 등). 낭비는 게이트가 아니라 **주변 의식(ceremony)**.

## 목표

품질 게이트의 가치(실행/재현으로 테스트가 못 잡는 결함 차단)는 유지하되, ROI 낮은 의식을 제거한다:
- 5-dimension 채점 장식 제거 (verdict 결정에 실제로 안 쓰임 — evaluator.ts:1054 "verdict 직신뢰").
- 다회 auto-fix 루프 제거 → **1회 자가치유 후 goal-QA 이월**.
- **조건부 검증**: 항상 경량, UI/위험만 풀, acceptance script 통과 시 진짜 skip.

**재작성이 아니라 벗겨내기** — "본질(실행/재현)"은 이미 P3/P4/P5(evaluator.ts:602-744) + `review` task_type 프롬프트(870-913)로 존재. 이를 code 기본형으로 승격.

## A. 판정 단순화 (evaluator.ts)

- `buildEvaluationPrompt`의 `code` 분기(evaluator.ts:917-998): 5차원 채점표(933-939)·dimensions JSON 스키마(964-986) 제거. `review`형(870-913)처럼 **실행/재현 + AC 대조 → `{verdict: "pass"|"fail", issues:[{severity,file,line,message,repro?}], knownGaps?:[] }`**.
- **P3/P4/P5(602-744) 유지·승격** — code 기본형의 실행/재현 몸통.
- `parseVerificationResult`(1001-1132): verdict 직신뢰 유지. `dimensions`는 없으면 `{}` 기본(파싱 관대화). content/config 임계값(1065-1083) **유지**(독립).
- **all-zero→conditional 꼼수(146-168) 제거** → "리뷰할 변경 없음"은 `diff.fileCount===0`(evaluator.ts:486) 신호로 **auto-pass**(verdict=pass, issues=[], note=no-changes). 파싱 실패는 명시적 재시도 1회 후 fail 유지(강등 금지).
- code 경로에서 `conditional` verdict 은퇴. content/config는 그대로 사용 가능(CHECK 안 건드림).

## B. 조건부 검증 게이트 (engine.ts, verify 직전)

`transitionTask(in_review)` 후 `qualityGate.verify` 호출(engine.ts:901) **직전**에 게이트 삽입 (선례: 서브태스크 skip engine.ts:891-895):

1. **서브태스크**(parent_task_id) → skip (기존 유지).
2. **`task.acceptance_script` 있음** → `runAcceptanceScript`(engine.ts:2291, export됨) 실행.
   - PASS → LLM verify **skip**. `verifications`에 `{verdict:'pass', scope:'lite', issues:[], dimensions:{}, severity:'auto-resolve'}` 기록(가시성) + 통과 처리.
   - FAIL → 그 출력을 이슈로 담아 **fail 경로**로(auto-fix 진입).
   - (task-level acceptance_script는 현재 컬럼만 있고 verify 경로 미실행 — 이 훅이 공백을 메움)
3. **acceptance_script 없음** → scope 결정(`autoDetectScope` 확장):
   - `task.target_files`에 `.tsx/.jsx/.css` **또는** gated 키워드(auth/db/payment/migration) **또는** fullstack **또는** 실행패턴 → **full**.
   - 그 외 → **lite**.
   - scope 결정에 `task.target_files` 확장자를 실제로 반영(현재 changedFileCount=undefined라 키워드만 작동).

## C. auto-fix 루프 축소 (engine.ts verify-fail 분기)

- in-cycle fix **1회 유지**(engine.ts:924-1053, maxFixRetries=1).
- re-verify도 fail → **`escalateVerificationCap`(verification-policy.ts:44) 즉시 호출**(goal-QA carryover + done + autopilot_warning). `transitionTask(blocked)`(1123) **안 씀** → scheduler cross-cycle 재픽 루프(blocked→retry→reassign) 차단.
- 첫 verify fail이 autoFix 비활성(maxFixRetries=0)인 경우에도 blocked 대신 escalate.
- **circuit breaker(scheduler.ts:340-374)·env오류/rate-limit blocked 경로는 유지** (verify-fail만 escalate로 우회).
- `MAX_VERIFY_FAIL_ROUNDS` 카운터 기반 escalation(engine.ts:911)은 "1 self-heal 후 escalate"로 대체되므로 단순화(카운터 대신 명시적 흐름).

## D. 대시보드 (VerificationLog.tsx + TaskDetail.tsx + i18n)

- VerificationLog.tsx:179-206 (5-dim 점수 막대) 제거 → issues + `repro` 표시로 교체.
- all-zero 배너(132,136-142) 제거. `DIM_LABEL_KEYS`(40-46)·`dimensions` 필드(13) 제거.
- TaskDetail.tsx:28-29,387 (동일 5-dim 표시) 제거.
- i18n `dimensionScore`·`dim*`(ko/en:191-194) 정리. verdict/severity 색상·issues 렌더는 유지.

## E. 마이그레이션 안전 (비용 0)

- `dimensions`/`severity` 컬럼·`verdict` CHECK **안 건드림**(과거 row 표시 호환 + SQLite 테이블 재생성 회피). 신규 code verify는 `dimensions={}` 저장.

## 범위 밖 (안 함)

- severity 3분류(hard/soft/auto) 제거 — 재생성 비용 > 이득.
- content/config task_type 임계값 로직 — 독립, 유지.
- typecheck/build 프로그램 캡처 — full 검증은 기존대로 프롬프트가 Evaluator에게 실행 지시.

## 오류/degrade

- acceptance script 실행 실패(타임아웃 등) → LLM verify로 폴백(skip 안 함).
- 조건부 게이트 예외 → 안전한 기본값(full 아님, lite)으로 verify 진행(게이트가 verify를 막지 않음).
- escalate 경로 실패 → 최후 blocked (기존 안전망).

## 테스트

- `parseVerificationResult`: dimensions 없는 응답 → verdict 직신뢰, `{}` 기본. content/config 임계값 여전히 작동. 파싱 실패 → fail(강등 안 함).
- 조건부 scope 결정(순수 함수): UI(.tsx)→full, 로직→lite, gated→full.
- fileCount===0 → auto-pass.
- (engine escalate/skip 경로는 통합 성격 — 가능한 범위서 순수부분 단위 테스트 + typecheck)
