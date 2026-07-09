# Design: 대량 데이터 UX 리팩토링

> Plan: 없음 — UX 적대적 평가 결과 기반 (Critical 11 / HIGH 16 / Warning 11)
> Date: 2026-04-05

---

## Context (설계 배경)

Crewdeck 대시보드가 소량 데이터(목표 3개, 태스크 10개)에서는 잘 동작하지만, 실제 프로젝트 규모(목표 50개, 태스크 500개, 검증 100개, 에이전트 20명)에서는 UX가 완전히 붕괴한다.

**근본 원인 3가지:**
1. API가 전체 데이터를 한 번에 반환 (페이징 없음)
2. 컴포넌트가 `useMemo` 없이 렌더마다 O(n) filter/map 반복
3. DOM에 전체 항목을 한 번에 마운트 (가상화/접기 없음)

### 설계 원칙

1. **10개 이하는 전부 보여주고, 초과하면 접는다** — 접기 임계값 통일
2. **useMemo로 파생 데이터 캐싱** — filter/groupBy/map은 deps 변경 시만 실행
3. **완료/오래된 데이터는 기본 숨김** — 현재 작업에 집중
4. **검색은 도처에** — 10개 초과 섹션에는 반드시 검색 입력
5. **추가 라이브러리 최소화** — react-window 없이 접기+더보기+모달로 해결

---

## Problem (설계 과제)

### P1. 목표(Goals) 섹션 — 개요 탭

| 시나리오 | 문제 |
|---------|------|
| 목표 50개 | 전부 펼쳐져서 스크롤 지옥. 완료 목표가 현재 작업을 가림 |
| 목표당 태스크 10개 | Goal 카드 내 인라인 태스크가 카드 높이를 과도하게 팽창 |

### P2. 태스크 목록 — TaskList

| 시나리오 | 문제 |
|---------|------|
| done 200개 | "모두 보기" 클릭 시 DOM 폭발 |
| 전체 500개 | status별 filter가 렌더마다 5회 실행 |
| 검색 | done에만 검색 있고 나머지 상태에는 없음 |

### P3. 칸반 — KanbanBoard

| 시나리오 | 문제 |
|---------|------|
| 컬럼별 100개 | 세로 수천px, 컬럼 간 독립 스크롤 없음 |
| DnD 중 | filter가 DnD 이벤트마다 재실행 |

### P4. 검증 로그 — VerificationLog

| 시나리오 | 문제 |
|---------|------|
| 100개 | 전체 로드, 날짜 그룹핑 없음, 스크롤 지옥 |

### P5. 조직도 — OrgChart

| 시나리오 | 문제 |
|---------|------|
| 에이전트 20명 flat | 가로 3760px, 재귀 filter O(n²) |

### P6. 에이전트 상세 — AgentDetail

| 시나리오 | 문제 |
|---------|------|
| 태스크 250개 배정 | Task History에 전부 렌더, 페이징 없음 |

### P7. 시작 가이드 — GettingStarted

| 시나리오 | 문제 |
|---------|------|
| 화면 | Welcome 카드 + 5단계 세로 나열 → 스크롤 필요, 한 화면에 안 보임 |

---

## Solution (설계 상세)

### 패턴 1: 접기/더보기 통일 규칙

```
항목 수 ≤ THRESHOLD → 전부 표시
항목 수 > THRESHOLD → THRESHOLD개 표시 + "N개 더보기" 버튼
```

| 컴포넌트 | 대상 | THRESHOLD |
|---------|------|-----------|
| ProjectHome goals | 완료 목표 | 3 (active 목표는 전부 표시) |
| ProjectHome goal 내 태스크 | active 태스크 | 3 |
| TaskList done | done 태스크 | 5 (현행 유지) |
| AgentDetail task history | 전체 태스크 | 10 |
| VerificationLog | 전체 로그 | 20 |

### 패턴 2: useMemo 적용 대상

| 컴포넌트 | 현재 | 변경 |
|---------|------|------|
| TaskList | `tasks.filter(status)` × 5 렌더마다 | `useMemo(() => groupBy(tasks, 'status'), [tasks])` |
| KanbanBoard | `tasks.filter(status)` × 5 + DnD | 동일 useMemo 패턴 |
| OrgChart | `agents.filter(parent_id)` 재귀 | `useMemo(() => groupBy(agents, 'parent_id'), [agents])` |
| AgentDetail | `tasks.filter(assignee_id)` | `useMemo` |
| ProjectHome | `agentMap` Object.fromEntries | `useMemo` |

### 패턴 3: 전역 검색 바

TaskList 상단에 **전역 검색** 입력 추가. 모든 상태의 태스크를 제목으로 필터. 검색 중에는 접기 무시.

### S1. ProjectHome 목표 섹션 개편

```
[목표]                                          [+ 목표 추가]

  Active 목표 (접히지 않음, 전부 표시)
  ┌─ 로그인 기능 구현  3/5 (60%)  [분해] [+ 태스크]
  │  ● API 엔드포인트 구현   Backend Dev
  │  ● 로그인 폼 UI         Frontend Dev
  │  + 2개 더
  └─
  ┌─ 대시보드 개편  0/3 (0%)  [분해] [+ 태스크]
  │  ...
  └─

  완료 목표 (2)                                 [접기/펼치기]
  ┌─ ✓ 초기 설정  5/5 (100%)  [삭제]
  └─ ✓ MVP 출시  10/10 (100%)  [삭제]
```

변경:
- 목표를 **active/완료**로 분리. 완료 목표는 기본 접힘
- goal 카드 내 active 태스크 최대 3개 + "+ N개 더" 링크
- 완료 목표 3개 초과 시 "N개 더보기"

### S2. TaskList 개편

```
[전체 태스크 검색...]

할 일 (15)
  ┌─ 항목 1   Backend Dev
  │  ...
  └─

진행 중 (3)
  ...

완료 (200)                              [접기]
  항목 1 ~ 5 표시
  [완료 195개 더보기]
```

변경:
- 상단 전역 검색 바 (모든 상태 대상, 300ms debounce)
- `useMemo`로 status별 그룹화 1회
- done은 기존 5개 접기 유지

### S3. KanbanBoard 개편

변경:
- `useMemo`로 컬럼별 태스크 사전 그룹화
- 각 컬럼에 `max-h-[calc(100vh-280px)] overflow-y-auto` → 독립 스크롤
- done 컬럼 5개 제한 유지 (현행)

### S4. VerificationLog 개편

```
[전체 | 통과 | 조건부 | 실패]    (현행 필터 유지)

오늘 (3)
  ┌─ PASS  standard  ...
  └─

어제 (5)
  ...

이전 (92)                               [접기]
  항목 1~10 표시
  [82개 더보기]
```

변경:
- **날짜별 그룹핑** (오늘/어제/이번주/이전)
- "이전" 그룹은 기본 접힘, 10개씩 더보기
- 현행 verdict 필터 유지

### S5. OrgChart 개편

변경:
- `useMemo`로 `parentId → children[]` 맵 1회 생성, OrgNode에 prop 전달
- `getDescendantIds`도 dragStart 시 1회 계산 후 ref 저장

### S6. AgentDetail 태스크 히스토리

변경:
- 기본 10개 표시 + "N개 더보기" 토글
- `useMemo`로 agentTasks, passCount, failCount 캐싱

### S7. GettingStarted 레이아웃 개편

현재: Welcome 카드 → 5단계 세로 나열 → 팁 → 길어서 스크롤 필요

변경: **한 화면 그리드 레이아웃**

```
┌─────────────────────────────────────────────────┐
│  ← 프로젝트로 돌아가기                            │
│                                                  │
│  Crewdeck 사용법                               │
│  아래 단계를 따라 AI 팀을 편성하세요.              │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ 1 프로젝트 │ │ 2 에이전트│ │ 3 목표    │         │
│  │ 생성      │ │ 추가     │ │ & 태스크  │         │
│  │ 설명...   │ │ 설명...  │ │ 설명...   │         │
│  └──────────┘ └──────────┘ └──────────┘          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ 4 실행    │ │ 5 검토   │ │ 💡 팁            │  │
│  │          │ │ & 검증   │ │ Cmd+K / ? / 칸반 │  │
│  └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────┘
```

- 3열 그리드 (lg 이상), 2열 (md), 1열 (sm)
- 각 카드는 compact: 번호 + 제목 + 1~2줄 요약
- WelcomeGuide embed 제거 (가이드 페이지 자체가 이미 충분)
- 팁은 마지막 카드에 통합

### 데이터 계약

| 필드 | 포맷 | 변환 규칙 |
|------|------|----------|
| THRESHOLD 상수 | number | 컴포넌트별 상단에 `const THRESHOLD = N` 으로 선언 |
| groupBy 결과 | `Record<string, T[]>` | 키가 없으면 빈 배열 반환 |
| 검색어 | string | `trim().toLowerCase()` 후 `title.toLowerCase().includes()` |
| 날짜 그룹 | "today" \| "yesterday" \| "thisWeek" \| "older" | `new Date()` 기준 UTC 비교 |

### 에러 처리

| 상황 | 처리 |
|------|------|
| 검색 결과 0건 | "검색 결과 없음" 안내 텍스트 |
| 접기 토글 중 데이터 변경 | WebSocket 갱신 시 접기 상태 유지 |
| done 0건일 때 "더보기" | 섹션 자체 숨김 |

---

## Sprint Contract

### Sprint 1: useMemo + 접기 강화 (성능 + 기본 UX)

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 1-1 | TaskList에서 `useMemo`로 status별 그룹화 | 코드 리뷰 — `useMemo` + `groupBy` 패턴 확인 | `grep "useMemo" dashboard/src/components/TaskList.tsx` | Critical |
| 1-2 | KanbanBoard에서 `useMemo`로 컬럼별 그룹화 + 컬럼 독립 스크롤 | 코드 리뷰 + Playwright | Playwright에서 칸반 컬럼 스크롤 확인 | Critical |
| 1-3 | OrgChart에서 `useMemo`로 parentId→children 맵 | 코드 리뷰 | `grep "useMemo" dashboard/src/components/OrgChart.tsx` | Critical |
| 1-4 | AgentDetail에서 task history 10개 제한 + 더보기 | Playwright 스크린샷 | 에이전트 상세 열고 "더보기" 버튼 확인 | Critical |
| 1-5 | ProjectHome agentMap useMemo 캐싱 | 코드 리뷰 | `grep "useMemo" dashboard/src/components/ProjectHome.tsx` | HIGH |

### Sprint 2: 목표 섹션 + 검증 로그 개편

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 2-1 | 목표 active/완료 분리, 완료 기본 접힘 | Playwright 스크린샷 | 완료 목표가 접힌 상태로 표시 확인 | Critical |
| 2-2 | goal 카드 내 active 태스크 3개 제한 | Playwright 스크린샷 | 4개+ 태스크 시 "N개 더" 표시 확인 | Critical |
| 2-3 | 검증 로그 날짜별 그룹핑 + "이전" 접힘 | Playwright 스크린샷 | "오늘/어제/이전" 그룹 헤더 확인 | Critical |
| 2-4 | TaskList 전역 검색 바 | 검색어 입력 후 필터 동작 | Playwright 검색 입력 → 결과 확인 | HIGH |

### Sprint 3: 시작 가이드 그리드 레이아웃

| # | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|---|----------|----------|----------|---------|
| 3-1 | GettingStarted가 3열 그리드로 렌더 (스크롤 없이 한 화면) | Playwright fullPage 스크린샷 | 1280px 뷰포트에서 스크롤 불필요 확인 | Critical |
| 3-2 | WelcomeGuide embed 제거, 가이드 자체가 완결 | 코드 리뷰 | GettingStarted에서 WelcomeGuide import 제거 확인 | Critical |
| 3-3 | 팁이 마지막 그리드 카드로 통합 | Playwright 스크린샷 | 별도 섹션 아닌 카드로 표시 | HIGH |

---

## 관통 검증 조건 (End-to-End)

| # | 시작점 | 종착점 | 우선순위 |
|---|-------|-------|---------|
| 1 | 목표 10개(완료 7 + active 3) 상태에서 개요 탭 진입 | 완료 목표 접혀있고, active 3개만 펼쳐 표시. 스크롤 최소 | Critical |
| 2 | TaskList에서 검색어 입력 | 모든 상태에서 일치하는 태스크만 표시, 접기 무시 | Critical |
| 3 | 시작 가이드 페이지 진입 | 1280px 뷰포트에서 스크롤 없이 전체 내용 가시 | Critical |
| 4 | 칸반에서 done 100개 컬럼 | 컬럼 내 독립 스크롤, 페이지 전체 스크롤 안 발생 | Critical |

---

## 평가 기준

### 기능
- 접기/더보기가 모든 대상 컴포넌트에서 정확히 동작하는가?
- 검색이 모든 상태의 태스크를 필터하는가?
- 날짜별 그룹핑이 정확한가?

### 설계 품질
- useMemo가 올바른 deps로 적용되었는가?
- groupBy 유틸이 재사용 가능한가?

### 단순성
- 추가 라이브러리(react-window 등) 없이 해결했는가?
- THRESHOLD 상수가 한 곳에서 관리되는가?

---

## 역방향 검증 체크리스트

- [x] TaskList useMemo 그룹화 → S2 패턴
- [x] KanbanBoard 컬럼 독립 스크롤 → S3
- [x] OrgChart children 맵 캐싱 → S5
- [x] ProjectHome 목표 active/완료 분리 → S1
- [x] VerificationLog 날짜 그룹핑 → S4
- [x] AgentDetail 태스크 히스토리 제한 → S6
- [x] GettingStarted 그리드 → S7
- [x] 전역 검색 바 → S2 패턴 3
