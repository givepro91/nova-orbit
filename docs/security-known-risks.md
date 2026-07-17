# Security known-risks — 외부 노출 전 필수 수리 목록

> 상태: 알려진 위험 수용(2026-07-17, 신뢰 복원 스프린트 W3에서 기록). Crewdeck 은 현재
> **localhost(127.0.0.1) 전용 개인 도구**로 운영되며, 아래 항목들은 그 전제 위에서만
> 안전하다. **어떤 형태로든 외부(다른 사용자·공용 네트워크·리버스 프록시)에 노출하기
> 전에는 이 목록을 먼저 수리해야 한다.** 터미널 브리지의 세션 스코프 경계는 별도 문서
> (`docs/terminal-security-boundary.md`) 참고 — 여기서 다루는 것은 전역 경계다.

## 1. loopback 무인증 API key 발급 (`server/api/middleware/auth.ts`)

`GET /api/auth/key?init=true` 는 요청 IP 가 loopback 이면 전역 API key 를 그대로
내려준다(다중 기기 지원을 위해 one-shot `.key-issued` 잠금도 제거된 상태).
문제는 **Tailscale serve 등 로컬 리버스 프록시가 앞에 서면 모든 요청이 loopback 에서
재접속**하므로, tailnet(또는 프록시가 닿는 네트워크)의 모든 기기가 이 엔드포인트로
관리자 key 를 획득할 수 있다 — 실질 무인증.

- 현재 수용 근거: localhost 직접 접속 + 개인 tailnet(단일 사용자) 전제.
- 노출 전 수리: 프록시 뒤에서는 이 엔드포인트를 비활성화하거나(env 게이트),
  `X-Forwarded-For` 신뢰 체인 검증 + 별도 부트스트랩 인증(초대 토큰 등)으로 교체.

## 2. 에이전트 CLI 의 승인·샌드박스 상시 우회 (`server/core/agent/adapters/codex.ts`)

Codex 세션은 항상 `--dangerously-bypass-approvals-and-sandbox` 로 실행된다
(`buildCodexArgs`). Claude 어댑터의 `--dangerously-skip-permissions` 와 대칭 —
비대화(TTY 없음) 자율 실행 + build/test/playwright/패키지 설치에 전체 접근이
필요하다는 실측 근거가 있다. 그러나 **goal worktree 는 파일 격리일 뿐 보안 경계가
아니다**: 프로세스는 워크트리 밖 파일시스템·네트워크·시크릿(`~/.ssh` 등)에
그대로 접근할 수 있다. 에이전트가 악성 프롬프트/의존성에 오염되면 호스트 전체가
영향 범위다.

- 현재 수용 근거: 신뢰된 사용자 1인이 자기 머신에서 자기 레포를 돌리는 구조 —
  에이전트 권한 = 사용자 권한.
- 노출 전 수리: 멀티테넌트/서버 운영 시 컨테이너·VM 급 격리로 이전하고, 네트워크
  egress 정책과 시크릿 마운트 최소화를 도입한 뒤에만 bypass 플래그를 유지.

## 3. `uncaughtException` 이후 계속 운영 (`server/index.ts`)

전역 `uncaughtException`/`unhandledRejection` 핸들러가 로그만 남기고 프로세스를
살려둔다. 개인 도구에서는 "오케스트레이션 도중 서버가 통째로 죽는 것"보다 낫지만,
예외 이후의 프로세스는 **정의되지 않은 상태**(잠금·트랜잭션·세션 맵이 어긋난 채)로
계속 요청을 받는다. 외부 사용자가 있다면 데이터 정합성·보안 가정이 깨진 상태로
서비스가 지속될 수 있다.

- 현재 수용 근거: launchd 상시 기동 + 단일 사용자 — 이상 징후는 로그로 관찰,
  세션/goal 재개 내성이 재시작 비용을 낮춘다.
- 노출 전 수리: fail-fast(로그 후 종료) + 프로세스 매니저 재기동으로 전환하거나,
  최소한 예외 발생 시 신규 요청 차단(draining) 후 재시작.
