# X-Verification: AI 에이전트 격리 전략 — git worktree vs branch-only checkout

> 날짜: 2026-04-05
> 합의 수준: Partial Consensus (2:1 Worktree 우세)
> AI: Claude (Anthropic), GPT-4o (OpenAI), Gemini (Google) — Mode A

## 질문
AI 에이전트 오케스트레이션 도구에서 에이전트 격리 전략으로 git worktree vs branch-only checkout 중 어떤 것이 적합한가?

## Claude (Anthropic)
**Git worktree 권장.** worktree는 물리적으로 분리된 작업 디렉토리를 제공하여 파일 충돌이 원천 차단됨. Claude Code CLI `--add-dir`은 특정 디렉토리를 컨텍스트로 참조하므로, worktree의 독립된 디렉토리 구조가 더 안정적. 디스크 사용량 증가(프로젝트 크기 x3)는 최대 3개 에이전트에서 미미.

## GPT-4o (OpenAI)
**Git worktree 권장.** 파일 충돌을 효과적으로 방지하며, 동일 저장소 파일을 공유하므로 디스크 사용량 최소화. 초기 설정이 약간 복잡하지만 장기적으로 관리 용이. 각 에이전트가 독립적으로 작업 수행하고 결과를 병합하는 것을 쉽게 관리 가능.

## Gemini (Google)
**Branch-only checkout 권장.** worktree보다 가볍고 단순하여 자원 소모 적음. Branch 생성/전환은 구현이 간단하고 유지보수 용이. Solo 환경에서 worktree는 불필요한 오버헤드.

## 합의 분석
- **합의 수준**: Partial Consensus (2:1 Worktree 우세)
- **요약**: Claude+GPT는 worktree의 물리적 격리 안전성을 우선, Gemini는 solo 환경의 단순성을 우선

### 공통점
- 에이전트 작업 격리가 핵심 요구사항
- 두 방식 모두 PR 워크플로우에 적합
- 동시 작업 안전성이 가장 중요한 기준

### 차이점
- **안전성 vs 단순성**: worktree는 파일 충돌 원천 차단, branch-only는 구현이 간단
- **오버헤드**: Gemini는 worktree가 불필요한 복잡도라고 주장, Claude/GPT는 3개 에이전트 수준에서 미미하다고 판단
- **장기 관리**: Claude/GPT는 worktree가 장기적으로 유리, Gemini는 branch-only가 유지보수 용이

### 결정
**Worktree 채택** — 동시 작업 안전성이 Crewdeck의 핵심 요구사항이며, 최대 3개 에이전트 수준에서 오버헤드는 수용 가능. 단, Gemini의 지적을 반영하여 GitHub 미연결 프로젝트(로컬 전용)에서는 branch-only fallback 옵션 제공.
