#!/usr/bin/env bash
# install-watchdog.sh — installs the launchd agent so the bot is auto-restarted
# when it crashes or hangs. Idempotent: re-running just reloads.
#
# Uninstall: scripts/uninstall-watchdog.sh

set -euo pipefail

LABEL="com.deepesh.resume-bot-watchdog"
SRC="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

[ -f "$SRC" ] || { echo "source plist missing: $SRC" >&2; exit 1; }

echo "==> copying $SRC → $DEST"
mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"

echo "==> bootstrap (load) the agent"
# 'bootout' first to make this idempotent if already loaded.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "==> kickstart immediately (don't wait for first 2-min interval)"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "==> status"
launchctl print "gui/$(id -u)/${LABEL}" | grep -E "(state|last exit|program)" | head -10 || true

echo
echo "Watchdog installed. It will:"
echo "  • run every 2 min via launchd"
echo "  • restart the bot if process is down OR heartbeat is stale (>3 min)"
echo "  • log to ~/bot/logs/watchdog.log"
echo
echo "Tail watchdog activity:"
echo "  tail -f ~/bot/logs/watchdog.log"
echo
echo "Uninstall:"
echo "  bash scripts/uninstall-watchdog.sh"
