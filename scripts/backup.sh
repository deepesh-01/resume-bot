#!/usr/bin/env bash
# backup.sh — date-stamped tar of the bot's stateful data, kept in
# ~/bot/backups/. The DB is the only thing that has to be consistent;
# everything else is reconstructible. We use SQLite's `.backup` to get a
# safe copy of the live db, then bundle it with users/ and archive/.
#
# Designed to run daily via launchd (see install-backup.sh). Idempotent;
# safe to run by hand any time.
#
# Retention: keep the last 14 daily tarballs. Older ones are deleted.
# Anything unusual (failure to back up, DB inconsistency) logs to
# ~/bot/logs/backup.log.

set -uo pipefail

BOT_ROOT="$HOME/bot"
DB_PATH="$BOT_ROOT/db.sqlite"
USERS_DIR="$BOT_ROOT/users"
ARCHIVE_DIR="$BOT_ROOT/archive"
BACKUPS_DIR="$BOT_ROOT/backups"
LOG_FILE="$BOT_ROOT/logs/backup.log"
KEEP_LAST=14

mkdir -p "$BACKUPS_DIR" "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"
}

DATE=$(date +'%Y%m%d_%H%M%S')
STAGE=$(mktemp -d "$BOT_ROOT/.backup-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

# 1. Snapshot the live SQLite DB safely. `.backup` works while WAL is in use.
if [ -f "$DB_PATH" ]; then
  if ! sqlite3 "$DB_PATH" ".backup '$STAGE/db.sqlite'" 2>>"$LOG_FILE"; then
    log "sqlite3 .backup failed; falling back to file copy (may be inconsistent)"
    cp "$DB_PATH" "$STAGE/db.sqlite" 2>>"$LOG_FILE" || {
      log "FATAL: cannot copy DB"
      exit 1
    }
  fi
else
  log "no DB at $DB_PATH — backing up workspace only"
fi

# 2. Bundle DB + users/ + archive/ into a single tar.gz. Skip pid/heartbeat
# transients and any tmp .backup-stage dir (in case backups overlap).
TARBALL="$BACKUPS_DIR/bot_${DATE}.tar.gz"
tar -czf "$TARBALL" \
  --exclude="${BOT_ROOT}/backups" \
  --exclude="${BOT_ROOT}/.backup-stage*" \
  --exclude="${BOT_ROOT}/.heartbeat" \
  --exclude="${BOT_ROOT}/.bot.pid" \
  --exclude="${BOT_ROOT}/.restart-reason" \
  --exclude="${BOT_ROOT}/logs" \
  -C "$STAGE" . \
  $( [ -d "$USERS_DIR" ]   && echo "-C $BOT_ROOT users" ) \
  $( [ -d "$ARCHIVE_DIR" ] && echo "-C $BOT_ROOT archive" ) \
  2>>"$LOG_FILE"

if [ ! -s "$TARBALL" ]; then
  log "FATAL: tarball missing or empty: $TARBALL"
  exit 1
fi

SIZE=$(du -h "$TARBALL" | awk '{print $1}')
log "ok tarball=$TARBALL size=$SIZE"

# 3. Retention: keep last $KEEP_LAST tarballs. Sort by mtime; delete the
# rest. macOS ships bash 3.2 by default — no `mapfile`, so use a while
# loop. Wrap the find/loop in `|| true` so an empty backups dir doesn't
# trip `set -u`.
ls -1t "$BACKUPS_DIR"/bot_*.tar.gz 2>/dev/null \
  | tail -n +$((KEEP_LAST + 1)) \
  | while read -r f; do
      [ -n "$f" ] || continue
      rm -f "$f"
      log "pruned old backup: $(basename "$f")"
    done || true
