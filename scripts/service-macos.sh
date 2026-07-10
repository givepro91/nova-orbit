#!/bin/bash
# Crewdeck macOS 상시 기동 (launchd LaunchAgent) 관리 스크립트
#
# 사용법: scripts/service-macos.sh install|uninstall|start|stop|restart|status|logs
#
# - install: 현재 checkout의 dist/bin/crewdeck.js를 로그인 시 자동 기동하도록 등록
#   (실행 전 npm run build 필요 — dist가 최신이어야 함)
# - 데이터 디렉토리: ~/.crewdeck (정식 위치 — cwd와 무관)
# - 로그: ~/.crewdeck/logs/server.log, server.err.log
# - dev와의 공존: npm run dev 전에 predev.sh가 서비스를 자동 정지한다.
#   dev를 마치면 `scripts/service-macos.sh start`로 되살릴 것.
set -euo pipefail

LABEL="com.crewdeck.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.crewdeck"
LOG_DIR="$DATA_DIR/logs"
GUI_DOMAIN="gui/$(id -u)"

node_bin() {
  command -v node || { echo "node를 PATH에서 찾을 수 없습니다" >&2; exit 1; }
}

install_plist() {
  local NODE_BIN NODE_DIR
  NODE_BIN="$(node_bin)"
  NODE_DIR="$(dirname "$NODE_BIN")"

  if [ ! -f "$REPO_ROOT/dist/bin/crewdeck.js" ]; then
    echo "dist/bin/crewdeck.js가 없습니다 — 먼저 npm run build를 실행하세요" >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_ROOT/dist/bin/crewdeck.js</string>
    <string>--no-open</string>
    <string>--data-dir=$DATA_DIR</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>CREWDECK_MAX_CONCURRENCY</key>
    <string>${CREWDECK_MAX_CONCURRENCY:-3}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.err.log</string>
</dict>
</plist>
EOF

  launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
  echo "설치 완료: $PLIST"
  echo "서버: http://127.0.0.1:7200 · 데이터: $DATA_DIR · 로그: $LOG_DIR"
}

case "${1:-}" in
  install)
    install_plist
    ;;
  uninstall)
    launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "제거 완료 (데이터 디렉토리는 유지: $DATA_DIR)"
    ;;
  start)
    if [ ! -f "$PLIST" ]; then install_plist; else
      launchctl bootstrap "$GUI_DOMAIN" "$PLIST" 2>/dev/null || launchctl kickstart "$GUI_DOMAIN/$LABEL"
      echo "시작됨: $LABEL"
    fi
    ;;
  stop)
    launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
    echo "정지됨: $LABEL (로그인 자동 기동도 해제 — 다시 켜려면 start)"
    ;;
  restart)
    launchctl kickstart -k "$GUI_DOMAIN/$LABEL"
    echo "재시작됨: $LABEL"
    ;;
  status)
    if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$GUI_DOMAIN/$LABEL" | grep -E "state|pid" | head -3
      curl -sf --max-time 3 http://127.0.0.1:7200/api/health && echo "" || echo "(health 응답 없음)"
    else
      echo "미등록 상태 — scripts/service-macos.sh install"
    fi
    ;;
  logs)
    tail -n 50 "$LOG_DIR/server.log" "$LOG_DIR/server.err.log" 2>/dev/null || echo "로그 없음: $LOG_DIR"
    ;;
  *)
    echo "사용법: $0 install|uninstall|start|stop|restart|status|logs"
    exit 1
    ;;
esac
