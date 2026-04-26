#!/usr/bin/env bash
# uninstall-watchdog.sh — removes the launchd agent.

set -euo pipefail

LABEL="com.deepesh.resume-bot-watchdog"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "==> bootout"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

if [ -f "$DEST" ]; then
  echo "==> removing $DEST"
  rm "$DEST"
fi

echo "Watchdog uninstalled. Bot will no longer auto-restart."
