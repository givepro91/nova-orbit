# Agent Prompt Optimization & Timeout Reliability

> 작성일: 2026-04-06
> 대상 버전: Crewdeck v0.3.0
> 검증 프로젝트: Pulsar (10 tasks, 40분 완료)

---

## Context

Crewdeck은 Claude Code CLI를 `--print` 모드로 subprocess 실행하여 AI 에이전트를 구동한다.
각 에이전트 실행 시 시스템 프롬프트에 다음 컨텍스트가 인라인 주입된다:

- role prompt (YAML 프리셋)
- recent tasks (결과 요약)
- tech stack (package.json 분석)
- git log (최근 커밋 히스토리)
- project docs (CLAUDE.md 등 프로젝트 문서)
- agent memory (에이전트별 학습 메모리)
- spec context (decompose 시 기획서 내용)

decompose(Goal → Task 분해) 시 CTO 에이전트가 기획서 전문을 참고하여 태스크 JSON을 생성한다.
`--add-dir` 플래그로 프로젝트 디렉토리 전체가 이미 Claude에 접근 가능하다.

---

## Problem

### P1. 프롬프트 비대화 (Token Bloat)

시스템 프롬프트에 인라인된 컨텍스트의 토큰 총량:

| 항목 | 토큰 (추정) |
|------|------------|
| project docs | ~4,000 |
| agent memory | 최대 ~38,000 (50KB 기준) |
| spec context (기획서) | ~8,000 |
| 기타 (role, tasks, stack 등) | ~2,000 |
| **합계** | **22,000+ tokens** |

`--add-dir`로 이미 접근 가능한 파일을 다시 인라인하는 것은 중복이며,
응답 품질 저하(긴 프롬프트로 인한 attention 분산)와 비용 낭비를 유발한다.

### P2. Idle Timeout 오판 (False Positive Kill)

Claude CLI는 복잡한 추론(thinking) 중 stdout에 아무것도 출력하지 않는 구간이 수십 초~수 분 발생한다.
기존 구현은 단일 idle timer를 사용했기 때문에:

- 첫 출력 전 thinking 중 → idle로 판단 → SIGTERM (exitCode=143)
- 정상 실행 중인 에이전트가 비정상 종료로 기록됨

### P3. 타이머 누수 (Timer Leak)

타이머 정리 로직이 산발적으로 분산되어 다음 상황에서 타이머가 미정리 상태로 남았다:

- `proc.on("error")` 발생 시 → idleTimer, sigkillTimer 미정리
- stdout 수신 시 → `resetIdleTimer()` 없이 기존 타이머 방치 (중복 실행)
- SIGTERM 발동 후 → idleTimer가 살아있어 재발동 가능

### P4. JSON 응답 잘림 (Truncated JSON)

비대해진 프롬프트로 인해 Claude 응답이 중간에 잘리는 현상 발생:

- decompose 결과 JSON이 `Unterminated string` 오류로 파싱 실패
- 태스크 생성 자체가 실패하여 전체 Goal 실행이 중단됨

---

## Solution

### S1. 프롬프트 경량화 원칙

**핵심 원칙: `--add-dir`로 접근 가능한 것은 시스템 프롬프트에 인라인하지 않는다.**

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| project docs | CLAUDE.md 전문 인라인 | 제거 (`--add-dir`로 대체) |
| git log | 최근 커밋 히스토리 인라인 | 제거 (`--add-dir`로 대체) |
| agent memory | 최대 50KB | 최대 3KB |
| recent tasks | result_summary 전문 | 태스크 제목만 |
| spec context (features) | 무제한 | 80자 제한 |
| spec context (user_flow, tech) | 포함 | 제거 |
| spec context (criteria) | 무제한 | 최대 8개 |
| spec 생성용 docs | 최대 16KB | 최대 6KB |

### S2. 2-Layer Timeout

에이전트 실행 단계를 두 구간으로 나눠 timeout 정책을 분리 적용한다.

```
[spawn] ─────────────────────────────────────────────────────────────
         |                                    |
         ▼                                    ▼
  첫 출력 전 (TTFT 대기)              첫 출력 후 (응답 중)
  ─────────────────────              ──────────────────
  • hard timeout만 적용               • idle timeout 적용
  • TIMEOUT_MS × 3 = 30분             • 10분 동안 출력 없으면 stuck 판단
  • 30초마다 프로세스 생존 확인        • stdout/stderr 수신마다 타이머 리셋
```

`hasReceivedOutput` 플래그로 두 모드 간 전환을 제어한다.
첫 출력 수신 시 hard timeout을 해제하고 idle timeout을 시작한다.

### S3. 타이머 안전성

`clearAllTimers()` 공유 함수를 도입하여 타이머 정리를 단일 진입점으로 집중한다.

```typescript
// 모든 타이머 일괄 정리
function clearAllTimers() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
}

// stdout/stderr 수신마다 idle 타이머 재시작
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(handleIdleTimeout, IDLE_TIMEOUT_MS);
}
```

적용 지점:
- `proc.on("error")` → `clearAllTimers()` 호출
- `proc.stdout.on("data")` → `resetIdleTimer()` 호출
- SIGTERM 발동 전 → `clearAllTimers()` 선행 호출
- `proc.on("close")` → `clearAllTimers()` 호출

### S4. JSON 복구 안전망 (Truncated Recovery)

decompose 응답 파싱을 3단계 fallback으로 처리한다:

```
1단계: ```json ... ``` 코드 블록 파싱
   ↓ 실패
2단계: raw JSON 매칭 ({ ... } 패턴)
   ↓ 실패 또는 Unterminated string
3단계: 정규식으로 완성된 task 객체만 추출
       (잘린 마지막 객체는 버리고 완성된 것만 사용)
```

3단계 복구 로직은 JSON이 중간에 잘려도 완성된 태스크를 최대한 살려
Goal 실행이 중단되지 않도록 한다.

---

## 관련 파일

| 파일 | 변경 내용 |
|------|----------|
| `server/core/agent/session.ts` | project docs / git log 인라인 제거, recent tasks 제목만 축약 |
| `server/core/agent/memory.ts` | `MAX_MEMORY_SIZE` 50KB → 3KB |
| `server/core/agent/adapters/claude-code.ts` | 2-layer timeout, `clearAllTimers()`, `resetIdleTimer()` 도입 |
| `server/core/orchestration/engine.ts` | spec context 축약 (features 80자, criteria 8개), JSON 복구 로직 |
| `server/api/routes/orchestration.ts` | spec 생성 docs 16KB → 6KB |
| `server/utils/constants.ts` | `TASK_TIMEOUT_MS` 5분 → 10분 |

---

## 검증 결과

**Pulsar 프로젝트 실전 테스트**

- decompose 성공: 기획서 기반 10개 태스크 정상 생성
- Full Autopilot 실행: 10/10 태스크 완료
- 소요 시간: 40분 이내
- idle timeout 오판 없음, JSON 파싱 실패 없음

---

## 교훈 및 적용 원칙

1. **LLM 프롬프트는 파일 시스템 접근과 중복되지 않아야 한다.**
   `--add-dir`이 있으면 docs 인라인은 불필요하다.

2. **단일 idle timer는 LLM thinking 구간에서 항상 오판한다.**
   TTFT 대기와 응답 중 구간을 반드시 분리해야 한다.

3. **타이머 정리는 단일 함수(`clearAllTimers`)로 집중해야 한다.**
   분산된 `clearTimeout` 호출은 누수를 유발한다.

4. **JSON 파싱은 항상 복구 경로가 있어야 한다.**
   LLM 응답은 길이 제한, 네트워크, rate limit 등으로 언제든 잘릴 수 있다.
