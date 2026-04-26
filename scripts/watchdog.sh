#!/usr/bin/env bash
# watchdog.sh — periodic health check. Restarts the bot if:
#   1. the bot process is not running, OR
#   2. the heartbeat file is stale (process is alive but hung)
#
# Designed to be run by launchd every 2 minutes (see install-watchdog.sh).
# Exit codes are not meaningful for launchd's StartInterval driver.

set -uo pipefail

REPO_ROOT="$HOME/Documents/resume-builder"
HEARTBEAT_FILE="$HOME/bot/.heartbeat"
HEARTBEAT_STALE_SECONDS=180   # 3 min — heartbeat ticks every 60s
LOG_FILE="$HOME/bot/logs/watchdog.log"

# fnm's "default" alias is a stable path to whichever node version is current.
NODE_BIN_DIR="$HOME/.local/share/fnm/aliases/default/bin"
export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"
}

# notify_admin <message> — DMs every ADMIN_CHAT_IDS via the bot's own token.
# Silent on failure; this is best-effort alerting.
notify_admin() {
  local message="$1"
  local env_file="$REPO_ROOT/.env"
  [ -f "$env_file" ] || return 0

  local token
  local admin_ids
  token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$env_file" | cut -d= -f2-)
  admin_ids=$(grep -E '^ADMIN_CHAT_IDS=' "$env_file" | cut -d= -f2-)
  [ -n "$token" ] && [ -n "$admin_ids" ] || return 0

  IFS=',' read -ra ids <<< "$admin_ids"
  for id in "${ids[@]}"; do
    id_trimmed=$(echo "$id" | tr -d '[:space:]')
    [ -n "$id_trimmed" ] || continue
    curl -s -m 10 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      -d chat_id="$id_trimmed" \
      --data-urlencode "text=$message" \
      > /dev/null 2>&1 || log "notify_admin: curl failed for chat $id_trimmed"
  done
}

# Match exact "node dist/index.js" (anchored at end of cmdline) so we don't
# false-match unrelated processes. Use cwd to scope to this repo.
find_bot_pids() {
  pgrep -f "node dist/index\.js$" 2>/dev/null | while read -r pid; do
    pcwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ {print substr($0, 2)}' | head -1)
    if [ "$pcwd" = "$REPO_ROOT" ]; then
      echo "$pid"
    fi
  done
}

start_bot() {
  cd "$REPO_ROOT" || { log "cannot cd to $REPO_ROOT"; return 1; }
  # Use & + nohup so the child detaches from this script's process group.
  nohup npm start >> "$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true
  sleep 4
  log "started; new pids: $(find_bot_pids | tr '\n' ' ')"
}

kill_bot() {
  local pids="$1"
  log "stopping pids: $pids"
  echo "$pids" | xargs kill -INT 2>/dev/null || true
  sleep 5
  # Force-kill anything that didn't go down gracefully.
  for p in $pids; do
    if ps -p "$p" > /dev/null 2>&1; then
      log "force-killing $p"
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  sleep 1
}

# ----- run -----
PIDS=$(find_bot_pids | tr '\n' ' ' | xargs)

if [ -z "$PIDS" ]; then
  log "no bot process — starting"
  start_bot
  notify_admin "🔄 Bot was down (no process running). Watchdog restarted it."
  exit 0
fi

# Heartbeat freshness check.
if [ ! -f "$HEARTBEAT_FILE" ]; then
  log "heartbeat missing (pids: $PIDS) — restarting"
  kill_bot "$PIDS"
  start_bot
  notify_admin "🔄 Bot was running but heartbeat file was missing. Watchdog killed and restarted (was likely hung mid-startup)."
  exit 0
fi

HEARTBEAT_TS=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
NOW_MS=$(($(date +%s) * 1000))
AGE_MS=$((NOW_MS - HEARTBEAT_TS))
THRESHOLD_MS=$((HEARTBEAT_STALE_SECONDS * 1000))

if [ "$AGE_MS" -gt "$THRESHOLD_MS" ]; then
  AGE_S=$((AGE_MS / 1000))
  log "heartbeat stale (age=${AGE_MS}ms, threshold=${THRESHOLD_MS}ms, pids: $PIDS) — restarting"
  kill_bot "$PIDS"
  start_bot
  notify_admin "🔄 Bot was hung (heartbeat ${AGE_S}s stale, threshold ${HEARTBEAT_STALE_SECONDS}s). Watchdog killed and restarted."
  exit 0
fi

# All good — log occasionally for visibility (every ~10 runs = 20 min).
RAND=$((RANDOM % 10))
if [ "$RAND" -eq 0 ]; then
  log "ok (pids: $PIDS, heartbeat_age=${AGE_MS}ms)"
fi
