#!/usr/bin/env bash
# uninstall-watchdog.sh — removes the launchd agent, the deployed watchdog
# script, and the deployed env file. Workspace data (logs, db, heartbeat)
# is left alone.

set -euo pipefail

LABEL="com.deepesh.resume-bot-watchdog"
DEST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DEST_SCRIPT="$HOME/bot/bin/watchdog.sh"
DEST_ENV="$HOME/bot/.watchdog.env"

echo "==> bootout"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

for f in "$DEST_PLIST" "$DEST_SCRIPT" "$DEST_ENV"; do
  if [ -f "$f" ]; then
    echo "==> removing $f"
    rm "$f"
  fi
done

echo "Watchdog uninstalled. Bot will no longer auto-restart."
