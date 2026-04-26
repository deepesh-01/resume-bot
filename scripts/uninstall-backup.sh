#!/usr/bin/env bash
# uninstall-backup.sh — remove the launchd backup agent and the deployed
# script. Existing tarballs in ~/bot/backups/ are left in place.

set -euo pipefail

LABEL="com.deepesh.resume-bot-backup"
DEST_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DEST_SCRIPT="$HOME/bot/bin/backup.sh"

echo "==> bootout"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

for f in "$DEST_PLIST" "$DEST_SCRIPT"; do
  if [ -f "$f" ]; then
    echo "==> removing $f"
    rm "$f"
  fi
done

echo "Backup agent uninstalled. Existing tarballs in ~/bot/backups/ kept."
