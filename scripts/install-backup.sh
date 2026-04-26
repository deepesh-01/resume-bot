#!/usr/bin/env bash
# install-backup.sh — install the daily-backup launchd agent.
# Mirrors the watchdog install pattern (ADR-025): copy the script out of
# ~/Documents/ to sidestep macOS TCC, then bootstrap a per-user agent.
#
# Uninstall: scripts/uninstall-backup.sh

set -euo pipefail

LABEL="com.deepesh.resume-bot-backup"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_PLIST="$SCRIPT_DIR/${LABEL}.plist"
SRC_SCRIPT="$SCRIPT_DIR/backup.sh"

DEST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DEST_SCRIPT_DIR="$HOME/bot/bin"
DEST_SCRIPT="$DEST_SCRIPT_DIR/backup.sh"

[ -f "$SRC_PLIST" ]  || { echo "source plist missing: $SRC_PLIST"  >&2; exit 1; }
[ -f "$SRC_SCRIPT" ] || { echo "source script missing: $SRC_SCRIPT" >&2; exit 1; }

echo "==> deploying backup script to $DEST_SCRIPT (outside ~/Documents to avoid TCC)"
mkdir -p "$DEST_SCRIPT_DIR"
cp "$SRC_SCRIPT" "$DEST_SCRIPT"
chmod 755 "$DEST_SCRIPT"

echo "==> copying $SRC_PLIST → $DEST_PLIST"
mkdir -p "$(dirname "$DEST_PLIST")"
cp "$SRC_PLIST" "$DEST_PLIST"

echo "==> bootstrap (load) the agent"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST_PLIST"

echo "==> kickstart immediately so the first backup happens now"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo
echo "Backup installed. It will:"
echo "  • run daily at 03:00 local time via launchd"
echo "  • write date-stamped tarballs to ~/bot/backups/"
echo "  • keep the last 14 tarballs"
echo "  • log to ~/bot/logs/backup.log"
echo
echo "Verify with:"
echo "  ls -lah ~/bot/backups/"
echo "  tail ~/bot/logs/backup.log"
echo
echo "Uninstall:"
echo "  bash scripts/uninstall-backup.sh"
