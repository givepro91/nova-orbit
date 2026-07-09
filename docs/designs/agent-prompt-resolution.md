# Design: Agent Prompt Resolution — 프로젝트 에이전트 우선 전략

> Plan: 별도 Plan 없음 — 운영 중 발견된 아키텍처 갭 기반 설계
> Date: 2026-04-05

---

## Context (설계 배경)

Crewdeck은 Claude Code CLI 서브프로세스로 에이전트를 스폰한다.
현재 에이전트의 system prompt는 **Crewdeck DB/프리셋에서만** 가져온다.

```
현재 흐름:
  Nova DB (agent.system_prompt)
    → fallback: templates/agents/{role}.yaml
      → fallback: FALLBACK_PROMPTS 하드코딩
        → Claude Code 실행 (cwd: projectDir)
```

문제: 프로젝트가 이미 `.claude/agents/{role}.md` 에 고품질 에이전트 정의를 가지고 있어도 **완전히 무시**된다. Nova의 범용 10줄 프롬프트가 프로젝트의 500줄 맞춤 프롬프트를 대체하는 역전 현상이 발생한다.

### 설계 원칙

1. **프로젝트가 에이전트의 두뇌를 소유한다** — Nova는 오케스트레이션만 담당
2. **기존 설정을 절대 무시하지 않는다** — 프로젝트 임포트 시 원본 그대로 활용
3. **Nova 프리셋은 fallback이다** — 프로젝트에 정의가 없을 때만 사용
4. **투명성** — 어떤 프롬프트가 적용되었는지 사용자가 항상 알 수 있어야 한다

---

## Problem (설계 과제)

### P1. 프롬프트 해결 순서 (Resolution Order)

에이전트 스폰 시 system prompt를 어디서 가져올지 결정하는 우선순위가 필요하다.

후보 소스:
| 순위 | 소스 | 위치 | 설명 |
|------|------|------|------|
| 1 | 사용자 커스텀 | Nova DB `agent.system_prompt` | 대시보드에서 직접 편집한 프롬프트 |
| 2 | 프로젝트 에이전트 | `{workdir}/.claude/agents/{role}.md` | 프로젝트에 내장된 에이전트 정의 |
| 3 | Nova 프리셋 | `templates/agents/{role}.yaml` | Nova 기본 역할별 프롬프트 |
| 4 | 하드코딩 fallback | `FALLBACK_PROMPTS` 상수 | 최종 안전망 |

과제: 어떤 소스를 썼는지 추적 가능해야 한다 (디버깅, 투명성).

### P2. 프로젝트 에이전트 파일 탐지

- `.claude/agents/` 디렉토리 구조가 프로젝트마다 다를 수 있다
- 파일명 ↔ role 매핑 규칙 필요 (예: `backend.md` → role `backend`)
- 파일이 있지만 비어있거나 형식이 다른 경우 처리

### P3. 대시보드 편집과 프로젝트 파일의 충돌

- 사용자가 대시보드에서 프롬프트를 편집하면 → Nova DB에 저장
- 이후 프로젝트의 `.claude/agents/` 파일이 업데이트되면 → 어느 게 최신?
- **결정**: 대시보드에서 명시적으로 편집한 것이 최우선. 프로젝트 파일은 "아직 커스텀하지 않은" 에이전트에만 적용.

### P4. temp dir의 불필요한 CLAUDE.md

현재 `buildTempDir()`이 자체 CLAUDE.md를 생성하여 `--add-dir`로 주입한다.
이것이 프로젝트의 CLAUDE.md와 혼합되어 예상치 못한 동작을 유발할 수 있다.

### P5. 적대적 평가 — 이 설계 자체의 약점

| 공격 벡터 | 시나리오 | 위험도 |
|-----------|---------|--------|
| 프롬프트 인젝션 | 프로젝트 `.claude/agents/backend.md`에 악의적 지시가 포함 | Low — 사용자 본인 프로젝트 |
| 파일 경쟁 | 에이전트 실행 중 `.claude/agents/` 파일 변경 | Low — 스폰 시점에 1회 읽기 |
| 빈 파일 함정 | `.claude/agents/backend.md`가 존재하지만 빈 파일 → Nova 프리셋도 무시됨 | Medium — 빈 파일 감지 필요 |
| role 불일치 | Nova role `backend` vs 프로젝트 파일명 `server-dev.md` | Medium — 매핑 테이블 필요 |
| 프롬프트 길이 폭발 | 프로젝트 파일 10,000줄 → CLI 인자 한계 초과 | Low — 파일 기반 주입이라 OK |
| DB 편집 후 리그레션 | 대시보드에서 편집 → 프로젝트 파일 무시 → 프로젝트 업데이트 반영 안됨 | Medium — 동기화 표시 필요 |

---

## Solution (설계 상세)

### 아키텍처: Prompt Resolution Chain

```
에이전트 스폰 요청
       ↓
  ┌─ 1. Nova DB에 커스텀 프롬프트가 있는가?
  │     (agent.system_prompt !== '' && agent.prompt_source === 'custom')
  │     → YES: DB 프롬프트 사용  [source: "custom"]
  │     → NO: 다음 단계
  │
  ├─ 2. 프로젝트에 .claude/agents/{role}.md 가 있는가?
  │     → YES (& 비어있지 않음): 파일 내용 사용  [source: "project"]
  │     → NO: 다음 단계
  │
  ├─ 3. Nova 프리셋에 해당 role이 있는가?
  │     (templates/agents/{role}.yaml)
  │     → YES: 프리셋 사용  [source: "preset"]
  │     → NO: 다음 단계
  │
  └─ 4. FALLBACK_PROMPTS 하드코딩  [source: "fallback"]
```

**핵심**: 각 단계에서 `promptSource` 메타데이터를 함께 반환하여 추적 가능하게 한다.

### 데이터 모델 변경

#### agents 테이블 — 컬럼 추가

| 컬럼 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `prompt_source` | TEXT | `'auto'` | `'auto'` \| `'custom'` \| `'project'` \| `'preset'` |

- `auto`: 해결 체인을 매 스폰마다 실행 (프로젝트 파일 우선)
- `custom`: 사용자가 대시보드에서 직접 편집함 → DB 값 고정
- `project`: 프로젝트 파일에서 로드됨 (읽기 전용 표시)
- `preset`: Nova 프리셋 사용 중

#### prompt_source 전환 규칙

| 행동 | 결과 |
|------|------|
| 에이전트 생성 (프리셋) | `prompt_source = 'auto'` |
| 에이전트 생성 (커스텀) | `prompt_source = 'custom'` |
| 대시보드에서 프롬프트 편집 | `prompt_source = 'custom'` |
| "프로젝트 동기화" 버튼 클릭 | `prompt_source = 'auto'` (DB 프롬프트 클리어) |

### 데이터 계약 (Data Contract)

| 필드 | 포맷 | 비어있음 허용 | 변환 규칙 |
|------|------|-------------|----------|
| `agent.system_prompt` | UTF-8 문자열 | Yes (빈 문자열 = auto 모드에서 무시) | trim() 후 판단 |
| `agent.prompt_source` | enum 문자열 | No | `'auto'` \| `'custom'` \| `'project'` \| `'preset'` |
| 프로젝트 파일 경로 | `{workdir}/.claude/agents/{role}.md` | N/A | role은 소문자, 파일 없으면 다음 단계 |
| 프로젝트 파일 내용 | UTF-8, Markdown | 빈 파일 = 무시 | `trim().length > 0` 로 판단 |

### role ↔ 파일명 매핑

| Nova role | 프로젝트 파일명 (우선순위순) |
|-----------|---------------------------|
| backend | `backend.md`, `server.md` |
| frontend | `frontend.md`, `client.md` |
| ux | `ux.md`, `designer.md`, `design.md` |
| qa | `qa.md`, `tester.md` |
| reviewer | `reviewer.md`, `review.md` |
| cto | `cto.md`, `lead.md`, `architect.md` |
| devops | `devops.md`, `infra.md`, `ops.md` |
| marketer | `marketer.md`, `marketing.md` |
| custom | `{agent.name 소문자}.md` |

### 핵심 로직: resolvePrompt()

**위치**: `server/core/agent/prompt-resolver.ts` (신규 파일)

```typescript
interface PromptResolution {
  prompt: string;
  source: 'custom' | 'project' | 'preset' | 'fallback';
  filePath?: string;  // source === 'project'일 때 실제 파일 경로
}

function resolvePrompt(
  agent: { role: string; name: string; system_prompt: string; prompt_source: string },
  projectWorkdir: string,
): PromptResolution
```

**로직**:
1. `agent.prompt_source === 'custom'` && `agent.system_prompt.trim()` → DB 값 반환
2. `findProjectAgentFile(projectWorkdir, agent.role, agent.name)` → 파일 읽기
3. `getPreset(agent.role)?.systemPrompt` → 프리셋 반환
4. `FALLBACK_PROMPTS[agent.role]` → 최종 fallback

### session.ts 변경

```diff
- systemPrompt: agent.system_prompt || getDefaultPrompt(agent.role),
+ const resolution = resolvePrompt(agent, projectWorkdir);
+ systemPrompt: resolution.prompt,
```

스폰 로그에 `resolution.source` 기록:
```
[session-manager] Spawned agent backend (source: project, file: .claude/agents/backend.md)
```

### buildTempDir 변경

```diff
- // Write a CLAUDE.md for the agent context
- writeFileSync(
-   join(tempDir, "CLAUDE.md"),
-   `# Crewdeck Agent\n\n...`,
- );
```

**자체 CLAUDE.md 생성 제거**. 프로젝트의 CLAUDE.md가 cwd를 통해 자동으로 읽히므로 불필요.

### API 변경

#### PATCH /agents/:id — prompt_source 자동 전환

```typescript
// 사용자가 system_prompt를 편집하면 → prompt_source를 'custom'으로 전환
if (system_prompt != null && system_prompt.trim() !== '') {
  updates.push("prompt_source = 'custom'");
}
```

#### GET /agents/:id — 현재 적용 프롬프트 정보 포함

응답에 `resolved_prompt_source` 필드 추가:
```json
{
  "id": "abc123",
  "role": "backend",
  "prompt_source": "auto",
  "resolved_prompt_source": "project",
  "resolved_prompt_file": ".claude/agents/backend.md",
  "system_prompt": ""
}
```

#### POST /agents/scan-project — 프로젝트 에이전트 파일 스캔 (신규)

```
POST /api/agents/scan-project
Body: { "project_id": "xxx" }
Response: {
  "found": [
    { "role": "backend", "file": "backend.md", "lines": 142, "preview": "You are a..." },
    { "role": "frontend", "file": "frontend.md", "lines": 87, "preview": "You are a..." }
  ],
  "matched": [  // 이미 매칭된 에이전트
    { "agentId": "abc", "role": "backend", "currentSource": "preset", "projectFile": "backend.md" }
  ],
  "unmatched": [  // 프로젝트에는 있지만 Nova 에이전트 없음
    { "file": "data-engineer.md", "suggestedRole": "custom" }
  ]
}
```

### 대시보드 UI 변경

#### AgentDetail — 프롬프트 소스 표시

```
시스템 프롬프트  [프로젝트 파일 사용 중]  편집
                 ↑ 배지: green=project, blue=custom, gray=preset

프롬프트 소스: .claude/agents/backend.md (142줄)
[프로젝트 동기화 해제 — 직접 편집으로 전환]
```

- `source: project` → 읽기 전용 표시 + "편집으로 전환" 버튼
- `source: custom` → 편집 가능 + "프로젝트 동기화로 복원" 버튼
- `source: preset` → 편집 가능 + "프로젝트에 에이전트 파일 없음" 안내

#### 에이전트 추가 다이얼로그 — 프로젝트 파일 감지

```
에이전트 추가

[프로젝트 에이전트 발견]
  backend.md (142줄) → Backend Developer로 추가
  frontend.md (87줄) → Frontend Developer로 추가
  [모두 추가]

---
역할 프리셋 선택
  CTO / Backend / Frontend / ...
```

### 에러 처리

| 상황 | 처리 |
|------|------|
| `.claude/agents/` 디렉토리 없음 | 정상 — 다음 단계(프리셋)로 진행 |
| 파일 읽기 권한 없음 | warn 로그 + 다음 단계로 진행 |
| 파일 인코딩 깨짐 | warn 로그 + 다음 단계로 진행 |
| 빈 파일 (0 bytes 또는 whitespace only) | 무시 — 다음 단계로 진행 |
| 매우 큰 파일 (>100KB) | warn 로그 + 그래도 사용 (CLI는 파일 기반이라 OK) |

---

## Sprint Contract (스프린트별 검증 계약)

### Sprint 1: Prompt Resolution Chain (핵심 엔진)

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 1-1 | `resolvePrompt()`가 4단계 우선순위를 정확히 따른다 | 단위 테스트 4케이스 | `npm test -- prompt-resolver` | Critical |
| 1-2 | 프로젝트에 `.claude/agents/backend.md`가 있으면 Nova 프리셋 대신 파일 내용을 사용한다 | 테스트 프로젝트 생성 + API 호출 | `curl -s localhost:3000/api/agents/{id} \| jq .resolved_prompt_source` → `"project"` | Critical |
| 1-3 | 빈 파일은 무시하고 다음 단계(프리셋)로 진행한다 | 빈 .md 파일 생성 후 검증 | `touch .claude/agents/backend.md && curl ...` → `"preset"` | Critical |
| 1-4 | temp dir에서 자체 CLAUDE.md 생성이 제거된다 | 코드 확인 + 빌드 | `grep -r "Crewdeck Agent" server/` → 결과 없음 | Critical |
| 1-5 | 에이전트 스폰 로그에 prompt source가 기록된다 | 서버 로그 확인 | 에이전트 프롬프트 전송 후 로그에 `source: project` 출력 확인 | Nice-to-have |

### Sprint 2: DB 스키마 + API 변경

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 2-1 | `agents` 테이블에 `prompt_source` 컬럼 추가 (기본값 `'auto'`) | DB 마이그레이션 확인 | `sqlite3 .crewdeck/crewdeck.db "PRAGMA table_info(agents)" \| grep prompt_source` | Critical |
| 2-2 | 대시보드에서 프롬프트 편집 시 `prompt_source`가 `'custom'`으로 전환 | PATCH API 호출 후 확인 | `curl -X PATCH ... -d '{"system_prompt":"test"}' \| jq .prompt_source` → `"custom"` | Critical |
| 2-3 | GET /agents/:id 응답에 `resolved_prompt_source` 포함 | API 응답 확인 | `curl -s localhost:3000/api/agents/{id} \| jq .resolved_prompt_source` | Critical |
| 2-4 | POST /agents/scan-project가 프로젝트 에이전트 파일을 탐지한다 | 테스트 프로젝트에 .claude/agents/ 생성 후 호출 | `curl -X POST ... -d '{"project_id":"xxx"}' \| jq .found[].role` | Nice-to-have |

### Sprint 3: 대시보드 UI

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 3-1 | AgentDetail에 프롬프트 소스 배지 표시 | Playwright 스크린샷 | 에이전트 상세 열고 소스 배지 확인 | Critical |
| 3-2 | source=project일 때 "편집으로 전환" 버튼 작동 | 클릭 후 prompt_source 변경 확인 | Playwright click + API 확인 | Critical |
| 3-3 | source=custom일 때 "프로젝트 동기화 복원" 버튼 작동 | 클릭 후 prompt_source가 auto로 변경 | Playwright click + API 확인 | Critical |
| 3-4 | 에이전트 추가 시 프로젝트 파일 감지 표시 | AddAgentDialog 진입 시 프로젝트 파일 감지 | Playwright 스크린샷 | Nice-to-have |

---

## 관통 검증 조건 (End-to-End)

| # | 시작점 (사용자 행동) | 종착점 (결과 확인) | 우선순위 |
|---|---------------------|-------------------|---------|
| 1 | 기존 프로젝트 임포트 (`.claude/agents/backend.md` 포함) → 에이전트 추가 → 프롬프트 전송 | 에이전트가 프로젝트 파일의 프롬프트로 작업 (서버 로그에서 `source: project` 확인) | Critical |
| 2 | 에이전트 상세에서 프롬프트 편집 → 저장 → 프롬프트 전송 | 편집된 프롬프트로 작업 (source: custom), 프로젝트 파일 무시 | Critical |
| 3 | "프로젝트 동기화 복원" 클릭 → 프롬프트 전송 | 다시 프로젝트 파일의 프롬프트로 작업 (source: project) | Critical |
| 4 | 프로젝트에 `.claude/agents/` 없는 상태 → 에이전트 추가 → 프롬프트 전송 | Nova 프리셋으로 작업 (source: preset), 정상 동작 | Critical |

---

## 평가 기준 (Evaluation Criteria)

### 기능
- 4단계 프롬프트 해결 체인이 정확히 동작하는가?
- 프로젝트 파일 변경이 즉시 반영되는가? (auto 모드)
- 대시보드 편집이 프로젝트 파일을 덮는가? (custom 모드)

### 설계 품질
- 기존 세션 관리 코드에 최소한의 변경으로 구현 가능한가?
- prompt-resolver가 독립 모듈로 테스트 가능한가?
- 향후 새로운 프롬프트 소스 추가가 쉬운가?

### 단순성
- 사용자가 "왜 이 프롬프트가 적용됐는지" 즉시 이해할 수 있는가?
- 동기화 충돌이 발생하지 않는 단순한 우선순위 규칙인가?

---

## 적대적 평가 (Adversarial Review)

### 공격 1: "프로젝트 파일이 있는데 무시됨" 시나리오

**검증**: auto 모드에서 `.claude/agents/backend.md` 존재 시 반드시 사용되는지.
**방어**: resolvePrompt()의 단위 테스트에서 file exists → source=project 보장.

### 공격 2: "대시보드 편집 후 프로젝트 업데이트 반영 안됨"

**시나리오**: 사용자가 대시보드에서 한 글자만 고침 → custom 고정 → 프로젝트 팀원이 `.claude/agents/backend.md`를 대폭 개선 → Nova 에이전트에 반영 안됨.
**방어**: AgentDetail에 "프로젝트 파일과 다릅니다. 동기화하시겠습니까?" 경고 표시. 프로젝트 파일의 mtime과 DB 수정 시간 비교.

### 공격 3: "role 이름 불일치"

**시나리오**: 프로젝트 파일명이 `server-engineer.md`인데 Nova role은 `backend`.
**방어**: role 매핑 테이블 + 매칭 안 되면 agent.name 기반 fallback 검색.

### 공격 4: "scan-project가 거대 프로젝트에서 느림"

**시나리오**: monorepo에서 수백 개 `.claude/agents/` 파일.
**방어**: readdir만 사용 (내용 읽기 X), preview는 첫 200자만.

### 공격 5: "에이전트 실행 중 프로젝트 파일 삭제/변경"

**시나리오**: 에이전트 작업 중 git pull로 `.claude/agents/backend.md` 변경.
**방어**: 스폰 시점에 1회 읽기 → 실행 중 변경은 다음 스폰에 반영. 실행 중 영향 없음.

### 공격 6: "temp dir CLAUDE.md 제거 시 부작용"

**시나리오**: 일부 로직이 temp dir의 CLAUDE.md 존재에 의존.
**방어**: `--add-dir`는 skills 주입용으로만 사용. CLAUDE.md는 프로젝트 cwd에서 자동 읽힘.

---

## 역방향 검증 체크리스트

- [x] 프로젝트 에이전트 파일 우선 사용 → Solution의 Resolution Chain 단계 2
- [x] 대시보드 편집이 프로젝트 파일을 override → prompt_source='custom' 전환 규칙
- [x] 투명성 (어떤 소스가 적용됐는지 표시) → resolved_prompt_source API + 배지 UI
- [x] 빈 파일/없는 파일 안전 처리 → 에러 처리 테이블
- [x] temp dir CLAUDE.md 제거 → buildTempDir 변경
- [x] 적대적 시나리오 6개 방어 → 적대적 평가 섹션
- [x] role 매핑 불일치 처리 → role ↔ 파일명 매핑 테이블
- [x] 기존 코드 최소 변경 → session.ts 1줄, prompt-resolver.ts 신규
