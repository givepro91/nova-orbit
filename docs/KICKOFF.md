# NOVA-ORBIT-KICKOFF.md

# Nova 에이전트용 프로젝트 킥오프 프롬프트

---

## 프로젝트 컨텍스트

Crewdeck은 기존 Nova(Claude Code Quality Gate 플러그인)를 확장하여,
"1인 창업자를 위한 AI 팀 오케스트레이션 + Quality Gate" 도구를 만드는 프로젝트다.

**레퍼런스:**

- Paperclip (https://github.com/paperclipai/paperclip) — 오케스트레이션 구조 참조
- Nova (https://github.com/TeamSPWK/nova) — Quality Gate 엔진, 우리의 기존 코드
- Notion — UX/UI 디자인 방향

**핵심 원칙:**

1. 사용자는 Claude Pro/Team 구독자. API 키가 아닌 Claude Code CLI 세션을 활용.
2. `npx crewdeck` 한 줄로 설치+실행. Postgres 없이 SQLite 내장.
3. 대시보드는 Notion처럼 직관적. 기술 배경 없는 1인 창업자도 사용 가능해야 함.
4. Nova의 Generator-Evaluator 분리가 핵심 차별점. 모든 결과물은 독립 검증 통과.

---

## Phase 1 태스크 목록

Phase 1의 목표: **동작하는 MVP**. 프로젝트 생성 → 에이전트 편성 → 태스크 실행 → 검증까지의 전체 루프가 한 번 돌아가는 것.

### Sprint 1: 프로젝트 부트스트랩 (3-4일)

```
Task 1.1: 프로젝트 초기화
- 모노레포 구성 (server/ + dashboard/)
- TypeScript 설정
- package.json의 bin 필드 설정 (npx 실행 가능하도록)
- 참조: Paperclip의 package.json bin 필드와 onboard 스크립트 분석

Task 1.2: SQLite 스키마 설계
- Paperclip의 Postgres 스키마를 분석하고 SQLite로 변환
- 핵심 테이블: projects, agents, goals, tasks, verification_logs, sessions
- projects 테이블에 source('new'|'local_import'|'github'), workdir, github_config 컬럼 포함
- better-sqlite3 사용
- 마이그레이션 시스템 (간단한 버전 기반)

Task 1.3: 서버 기본 골격
- Express 또는 Fastify 서버
- REST API 라우트 기본 구조
- WebSocket 서버 셋업
- 프로젝트 CRUD API (생성 + 로컬 임포트 + GitHub 연결)
```

### Sprint 1.5: 프로젝트 임포트 + GitHub 연결 (3-4일)

```
Task 1.5.1: 로컬 프로젝트 임포트
- 디렉토리 경로 입력 → 유효성 검사
- 코드베이스 자동 분석 모듈:
  - package.json → Node/TypeScript/React 등 감지
  - build.gradle/pom.xml → Java/Kotlin 감지
  - requirements.txt/pyproject.toml → Python 감지
  - 디렉토리 구조 (src/, tests/, docs/) 분석
- 분석 결과 기반 에이전트 자동 제안:
  - 예: TypeScript + React 감지 → Coder(Frontend) + Coder(Backend) + Reviewer 제안
- 제안을 대시보드에서 사용자에게 보여주고 승인/수정 받음

Task 1.5.2: GitHub 레포 연결
- GitHub repo URL 입력 → git clone 실행
- clone 후 Task 1.5.1과 동일한 분석 파이프라인 실행
- GitHub 관련 추가 설정:
  - 에이전트별 브랜치 전략 (feature 브랜치 자동 생성)
  - auto-push 옵션 (on/off)
  - PR 생성 모드 (에이전트 작업 완료 시 PR 자동 생성)
- git 인증: 사용자 로컬 git config 활용 (별도 토큰 불필요)

Task 1.5.3: 멀티 프로젝트 관리
- 사이드바에 프로젝트 리스트 표시
- 프로젝트 간 전환 (에이전트 세션 독립)
- 각 프로젝트별 독립 SQLite 테이블 또는 project_id 필터
```

### Sprint 2: Claude Code 세션 관리 (4-5일)

```
Task 2.1: Paperclip 에이전트 어댑터 분석
- https://github.com/paperclipai/paperclip 클론
- 핵심 분석 대상 (검증된 패턴):
  - packages/adapters/ — claude_local 어댑터 구현
    → Claude Code를 child_process.spawn으로 서브프로세스 실행
    → stdin/stdout(stdio) 파이프 통신
    → --add-dir 플래그로 스킬 디렉토리 주입 (임시 디렉토리 + 심볼릭 링크)
    → sessionBehavior: "resume-or-new" 세션 영속성
  - packages/adapter-utils/ — 세션 관리, 에러 핸들링 공통 로직
  - packages/db/ — Drizzle 스키마 (PGlite 내장 DB 패턴)
  - packages/shared/ — 공유 타입, API 경로 상수
  - server/ — Express REST API + 오케스트레이션 서비스 구조
- 분석 결과를 docs/paperclip-reference.md에 정리
- 특히 claude_local 어댑터의 spawn 옵션, stdio 파싱, 에러 핸들링을 상세 기록

Task 2.2: Claude Code CLI 어댑터 구현 (Paperclip 패턴 기반)
- Paperclip의 claude_local 어댑터를 참조하되, Crewdeck에 맞게 재구현
- Claude Code CLI를 child_process.spawn으로 실행
- stdin/stdout 파이프 통신 구현
- --add-dir 플래그로 Nova Quality Gate 규칙을 스킬 파일로 주입
- sessionBehavior: "resume-or-new" 구현 (세션 영속성)
- 세션 상태 DB 영속화 (재시작 시 복원)
- Generator와 Evaluator는 반드시 별도 세션으로 spawn (Nova 핵심 원칙)

Task 2.3: 에이전트 역할 프리셋 시스템
- YAML 기반 에이전트 템플릿 로더
- 기본 4개 역할: coder, reviewer, marketer, designer
- 각 역할에 맞는 스킬 파일 세트 (--add-dir로 주입될 파일들)
- 커스텀 역할 생성 지원
```

### Sprint 3: 오케스트레이션 엔진 (4-5일)

```
Task 3.1: 목표 → 태스크 분해 엔진
- Goal을 입력받아 Task 리스트로 분해
- 분해 시 Claude를 활용 (메타 에이전트)
- 각 Task에 적합한 에이전트 자동 할당 로직
- 참조: Paperclip의 orchestration/engine 분석

Task 3.2: 태스크 실행 파이프라인
- Task Queue (우선순위 기반)
- 에이전트에 Task 전달 → 실행 → 결과 수신
- 실행 상태 변경: todo → in_progress → in_review → done
- WebSocket으로 대시보드에 실시간 상태 전달

Task 3.3: 거버넌스 (승인 게이트)
- 에이전트 결과물에 대한 사용자 승인/거부 플로우
- Hard-Block 시 자동 중단
- 승인 후 다음 태스크 자동 시작
```

### Sprint 4: Nova Quality Gate 통합 (3-4일)

```
Task 4.1: Nova 검증 로직 포팅
- 기존 Nova의 Generator-Evaluator 분리 로직을 Nova Next 모듈로 포팅
- 5차원 검증 (기능, 데이터관통, 설계정합성, 크래프트, 경계값)
- Evaluator는 별도 Claude Code 세션으로 실행 (Generator와 분리)

Task 4.2: 검증 파이프라인 연결
- Task 완료 시 자동으로 Quality Gate 실행
- 검증 결과를 VerificationResult로 구조화
- PASS → done, SOFT-BLOCK → 사용자 판단, HARD-BLOCK → 자동 중단
- 검증 로그 SQLite 저장 + 대시보드 표시
```

### Sprint 5: 대시보드 UI (5-7일)

```
Task 5.1: 대시보드 기본 레이아웃
- React + TailwindCSS
- Notion 스타일 사이드바 (프로젝트 트리)
- 라우팅: 프로젝트 홈 / 에이전트 / 태스크 보드 / 검증 로그
- 다크 모드 / 라이트 모드
- Zustand 상태 관리

Task 5.2: 프로젝트 홈 페이지
- 미션 표시 (인라인 편집 가능)
- 에이전트 카드 그리드 (이름, 역할, 상태 표시)
- 목표별 진행률 프로그레스 바
- 최근 활동 피드 (타임라인)

Task 5.3: 태스크 보드 (Kanban)
- Todo | In Progress | In Review | Done | Blocked 컬럼
- 드래그 앤 드롭 (@dnd-kit)
- 카드에 에이전트 아바타 + 검증 상태 배지
- 카드 클릭 → 상세 모달 (대화 로그, 검증 결과)

Task 5.4: 에이전트 상태 실시간 표시
- WebSocket 연결
- 에이전트 세션 출력 실시간 스트리밍
- 터미널 미리보기 컴포넌트 (xterm.js)
- 에이전트 일시정지/재개 버튼

Task 5.5: 검증 로그 페이지
- 타임라인 뷰
- 5차원 스코어 시각화 (레이더 차트 또는 바 차트)
- HARD-BLOCK 이슈 강조 표시
- "Fix" 버튼 → 수정 태스크 자동 생성
```

### Sprint 6: 통합 테스트 + npx 배포 (2-3일)

```
Task 6.1: E2E 시나리오 테스트
- npx nova-next → 초기 설정 → 프로젝트 생성 → 에이전트 편성
  → 태스크 할당 → 실행 → 검증 → 결과 확인
- 전체 루프가 한 번 완료되는 것을 확인

Task 6.2: npx 배포 설정
- npm 패키지로 publish
- npx nova-next 실행 시:
  1. 의존성 자동 설치
  2. SQLite DB 생성
  3. 대시보드 빌드 (또는 프리빌드)
  4. 서버 시작
  5. 브라우저 자동 오픈 (localhost:3000)

Task 6.3: README.md 작성
- 영문 기본 (글로벌 타겟)
- 설치 가이드
- 스크린샷/GIF
- Paperclip 대비 차별점 명시
- MIT 라이선스
```

---

## 에이전트별 작업 지시

### /nova:orchestrate 실행 시 사용할 프롬프트

```
Sprint 1-2를 시작합니다.

프로젝트: Crewdeck
목표: 1인 창업자를 위한 AI 팀 오케스트레이션 도구 MVP

첫 번째 작업:
1. 먼저 https://github.com/paperclipai/paperclip 을 클론하고 분석하세요.
   핵심 분석 대상:
   - packages/adapters/ → claude_local 어댑터 (Claude Code spawn 방식)
     → child_process.spawn + stdio 통신이 핵심
     → --add-dir 플래그로 스킬 주입하는 방식
     → sessionBehavior: "resume-or-new" 세션 영속성 구현
   - packages/adapter-utils/ → 세션 관리 공통 로직
   - packages/db/ → Drizzle 스키마, PGlite 내장 DB 패턴
   - packages/shared/ → 공유 타입, 상수
   - server/ → Express REST API 구조
   - package.json의 bin 필드, onboarding 스크립트
   분석 결과를 docs/paperclip-reference.md에 정리하세요.

2. 분석 완료 후, NOVA-NEXT-PROJECT.md의 디렉토리 구조를 기반으로
   프로젝트를 초기화하세요.
   - TypeScript monorepo (server/ + dashboard/)
   - SQLite 스키마 설계 (Paperclip 참조하되 단순화)
   - projects 테이블: source(new/local_import/github), workdir, github_config 포함
   - Express 서버 + WebSocket 기본 골격
   - npx 실행 가능한 bin 설정
   - 프로젝트 CRUD: 새로 생성 / 로컬 임포트 / GitHub 연결 3가지 모드

3. Claude Code CLI를 서브프로세스로 spawn하는 어댑터를 구현하세요.
   - Paperclip의 어댑터 패턴 참조
   - 우리는 Claude Code 전용이므로 대폭 단순화
   - stdin/stdout 통신, 세션 상태 관리

프로젝트 정의서: NOVA-ORBIT-PROJECT.md를 반드시 참조하세요.
Nova Quality Gate: 모든 구현은 /nova:review를 통과해야 합니다.
```

---

## 주의사항

1. **Paperclip 코드를 그대로 복사하지 않는다.** 참조하되, Crewdeck의 아키텍처에 맞게 재설계한다.
2. **SQLite를 사용한다.** Postgres 의존성은 Phase 1에서 절대 도입하지 않는다.
3. **Claude Code 세션 관리가 가장 핵심이자 가장 어려운 부분이다.** Sprint 2에서 충분히 시간을 투자한다.
4. **대시보드 UX는 Notion을 따른다.** 복잡한 기능보다 직관적 인터랙션이 우선이다.
5. **영문 우선이다.** 모든 코드 주석, README, UI 텍스트는 영어 기본 + i18n 확장 가능하게.
6. **MIT 라이선스.** Paperclip도 MIT이므로 참조 시 Attribution만 포함하면 된다.
