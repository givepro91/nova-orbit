# R3 — 제품 방향 재점검 (2026-07-07)

부활 로드맵의 마지막 단계. R1·R2·실프로젝트 dogfooding으로 "파이프라인이 실레포에서 돈다"가 실증된 시점에서, 이 제품을 어디로 끌고 갈지 정한다.

## 1. 환경 변화 — 개발 중단(2026-04) 이후 무엇이 바뀌었나

Claude Code 네이티브가 Crewdeck의 오케스트레이션 코어와 정면으로 겹치는 기능을 갖췄다:

| 영역 | Claude Code 네이티브 (2026-07 현재) | Crewdeck 해당 기능 |
|------|-------------------------------------|---------------------|
| 멀티에이전트 팀 | **Agent Teams** (experimental) — 리드 세션 + 팀메이트, 공유 태스크 리스트, 에이전트 간 메시징 | 세션 매니저 + 역할 프리셋 + 태스크 큐 |
| 결정적 오케스트레이션 | **Workflows** — JS 스크립트로 서브에이전트 파이프라인/팬아웃 제어 | orchestration engine (decompose→구현→검증) |
| 스케줄/자율 실행 | cron 기반 scheduled cloud agents, 백그라운드 태스크, 원격 에이전트 | autopilot 큐 + 스케줄러 |
| 에이전트 UI | FleetView, claude.ai/code 웹 | 대시보드 (React) |
| 코드 리뷰 | /code-review (multi-agent cloud 리뷰 포함) | Evaluator (부분 겹침) |

**시사점**: "Claude Code 세션을 에이전트 팀으로 묶는다"는 것 자체는 더 이상 제품이 아니다. Anthropic 자체 로드맵과 정면 충돌 코스이며, 이 축에서의 대외 경쟁은 승산이 없다.

## 2. Crewdeck의 고유 자산 — 네이티브가 갖지 않은 것

이번 부활 과정(R1·R2·dogfooding)에서 실증된, 겹치지 않는 가치:

1. **Quality Gate (의견 있는 품질 파이프라인)** — Generator-Evaluator 강제 분리, 5차원 검증 + task_type별 임계값, adversarial 사전조사·QA 회귀 태스크 자동 주입, goal 누적 diff 검증. 네이티브의 리뷰 도구는 "시키면 리뷰"지, "구현과 검증을 구조적으로 분리 강제"하는 파이프라인이 아니다. proof dogfooding에서 Evaluator가 fail을 내고 자동 수정 루프가 돈 것이 실증.
2. **Goal-as-Unit + 인간 승인 게이트** — goal 단위 worktree, 1 squash commit, 승인 다이얼로그(커밋 메시지·파일 프리뷰). dogfooding에서 승인 전 리뷰가 P1 오염을 잡아냄 — 게이트의 가치 실증.
3. **비개발자 친화 대시보드** — 한국어/영어, 용어 순화(Decompose→작업 분할, Worktree→독립 작업 공간), 칸반, 실시간 활동 피드. CC 생태계는 철저히 개발자 터미널 중심.
4. **영속 큐 + 자율 운영 인프라** — crash recovery(3회 실측), env 오류 쿨다운, AIMD rate-limit 자활, acceptance script 게이트. 야간 무인 autopilot 전제의 견고함.
5. **실패 가드 자산** — Pulsar 시대 P0~P5 + 이번 R1/R2/dogfooding에서 잡은 결함·수정 이력 전체가 회귀 테스트로 코드화되어 있음.

## 3. 옵션

### A. 대외 제품 지속 (npx 배포, 외부 사용자 획득)
- Anthropic 네이티브 로드맵과 충돌 코스. 오케스트레이션 코어의 유지 비용(CLI 플래그 드리프트, Node/의존성 드리프트 — 이번에 실측)이 계속 발생.
- **비추천.**

### B. 사내/개인 운영 도구로 확정 (추천 기본값)
- jay의 프로젝트 포트폴리오(proof, pulsar 등)에 야간 autopilot + 품질 게이트로 상시 운용. 이번 dogfooding이 곧 운영 모델의 실증.
- 유지 범위를 "내가 쓰는 만큼"으로 한정 — 신규 기능보다 운용 중 발견되는 결함 수정 위주.
- 비용 최소, 가치 즉시. AX 리드 관점에서 "human-in-the-loop 에이전트 운영"의 살아있는 레퍼런스.

### C. Quality Gate 추출 → Claude Code 생태계 컴포넌트 (탐색 과제)
- Generator-Evaluator 분리·acceptance 게이트·승인 파이프라인을 CC 네이티브(Agent Teams/Workflows/plugin) 위에 얹는 재구축. 오케스트레이션은 네이티브에 맡기고 **품질 계층만 소유**.
- 방향은 유망하나 재작업 비용이 있고, 네이티브 Teams가 아직 experimental — 안정화 후 PoC가 적기.

### D. 동결
- 지금 상태(전 루프 실증 + 문서화 완료)로 보존. 재개 비용은 낮게 유지됨.

## 4. 추천

**B를 기본으로 확정하고, C를 다음 분기 탐색 과제로 등록.**

- B: proof·pulsar 등에서 실사용을 계속하며 발견 결함만 수정 (dogfooding = 유지보수 신호).
- C: CC Agent Teams 안정화(experimental 해제) 시점에 "Crewdeck Quality Gate as CC Workflow/plugin" PoC 1회 — Evaluator 프롬프트·verdict 스키마·acceptance 게이트는 그대로 이식 가능한 자산.
- A 포기에 따른 정리: README의 대외 제품 포지셔닝(vs Paperclip 비교표 등)은 방향 확정 후 사내 도구 톤으로 조정.

## 5. 결정 (2026-07-07 확정)

**개인 운영 도구(givepro91)로 확정. 사내(SPWK) 활용은 보류.**

- 대외 제품화(A)는 추진하지 않는다 — npm publish 없음, 외부 사용자 획득 없음.
- givepro91 개인 프로젝트(proof 등)의 야간 autopilot + 품질 게이트로 상시 운용하며, 운용 중 발견되는 결함만 수정한다 (dogfooding = 유지보수 신호).
- 사내 확산은 보류 — 필요가 생기면 그때 재검토.
- C(Quality Gate의 CC 생태계 이식)는 이번에 확정하지 않음 — CC Agent Teams 안정화 시점에 재판단.
- 후속 정리 후보(비긴급): 레포 위치(TeamSPWK → 개인 계정) 재검토, README의 대외 제품 포지셔닝 완화(이번에 상태 표기 추가).
