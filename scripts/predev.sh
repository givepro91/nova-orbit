#!/bin/bash
# launchd 상시 서비스가 떠 있으면 먼저 정지 — kill -9만 하면 KeepAlive가 되살려
# dev 서버와 port 7200을 두고 싸운다. dev 종료 후 scripts/service-macos.sh start로 복구.
launchctl bootout "gui/$(id -u)/com.nova-orbit.server" 2>/dev/null

# Kill any zombie processes on ports 7200 and 5173
lsof -ti :7200 | xargs kill -9 2>/dev/null
lsof -ti :5173 | xargs kill -9 2>/dev/null

exit 0
