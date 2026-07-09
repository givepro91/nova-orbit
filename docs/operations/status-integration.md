# Claude Status Integration

대시보드 상단 `StatusBar`는 `~/.claude/tmux-status` 파일을 **10초 폴링**하여 다음 정보를 표시한다:

- Context window 사용률 (%)
- 현재 세션 토큰 사용량
- 비용 ($)
- 5시간 rate limit 사용률 (%)

## 동작 흐름

1. Claude Code CLI 또는 외부 데몬이 `~/.claude/tmux-status`에 상태를 기록한다.
2. Crewdeck 서버가 10초 주기로 파일을 읽고 변경을 감지한다.
3. WebSocket broadcast로 대시보드 `StatusBar`를 갱신한다.

## 관련 위치

- UI: `dashboard/src/components/StatusBar.tsx`
- 서버 폴링 로직: `server/` (tmux-status reader)

## 주의

- 파일이 없으면 StatusBar는 빈 상태로 표시 (에러로 처리하지 않음).
- 이 파일은 사용자 환경의 tmux 또는 외부 데몬이 작성한다. Crewdeck 레포가 직접 생성하지 않는다.
