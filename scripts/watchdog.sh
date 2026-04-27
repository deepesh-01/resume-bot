#!/usr/bin/env bash
# watchdog.sh — periodic health check. Restarts the bot if:
#   1. the bot process is not running, OR
#   2. the heartbeat file is stale (process is alive but hung)
#
# Designed to be run by launchd every 2 minutes (see install-watchdog.sh).
# Exit codes are not meaningful for launchd's StartInterval driver.
#
# Deployment notes (ADR-025):
#   - This script is COPIED to ~/bot/bin/watchdog.sh by install-watchdog.sh
#     and launchd executes that copy. The repo copy here is the source of
#     truth; reinstall after editing it.
#   - The copy lives outside ~/Documents to sidestep macOS TCC, which
#     blocks launchd-spawned bash from reading scripts under ~/Documents.
#   - Config (token + admin chat ids) is read from ~/bot/.watchdog.env,
#     also written by install-watchdog.sh, so the script never has to
#     touch ~/Documents at runtime.
#   - Detection is heartbeat-first: if ~/bot/.heartbeat is fresh, the bot
#     is alive — we don't run pgrep/lsof at all. lsof-on-other-processes
#     is unreliable under launchd's sandbox; relying on it produced
#     false-positive "no bot process" restarts.

set -uo pipefail

REPO_ROOT="$HOME/Documents/resume-builder"   # used only for `cd && npm start`
BOT_ROOT="$HOME/bot"
HEARTBEAT_FILE="$BOT_ROOT/.heartbeat"
BOT_PID_FILE="$BOT_ROOT/.bot.pid"
RESTART_REASON_FILE="$BOT_ROOT/.restart-reason"
WATCHDOG_ENV_FILE="$BOT_ROOT/.watchdog.env"
HEARTBEAT_STALE_SECONDS=180   # 3 min — heartbeat ticks every 60s
LOG_FILE="$BOT_ROOT/logs/watchdog.log"
WATCHDOG_NAME="resume-builder watchdog"

# fnm's "default" alias is a stable path to whichever node version is current.
NODE_BIN_DIR="$HOME/.local/share/fnm/aliases/default/bin"
export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"
}

# notify_admin <message> — DMs every ADMIN_CHAT_IDS via the bot's own token.
# Silent on failure; this is best-effort alerting. Token + chat ids are read
# from ~/bot/.watchdog.env (written by install-watchdog.sh), so the watchdog
# never has to read the repo's .env at runtime.
notify_admin() {
  local message="$1"
  [ -f "$WATCHDOG_ENV_FILE" ] || { log "notify_admin: $WATCHDOG_ENV_FILE missing"; return 0; }

  local token admin_ids
  # shellcheck disable=SC1090
  . "$WATCHDOG_ENV_FILE"
  token="${TELEGRAM_BOT_TOKEN:-}"
  admin_ids="${ADMIN_CHAT_IDS:-}"
  [ -n "$token" ] && [ -n "$admin_ids" ] || { log "notify_admin: token or admin_ids empty"; return 0; }

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

# Authoritative pid lookup. The bot writes its pid to $BOT_PID_FILE on
# startup; we trust that file. We DO NOT fall back to "all pgrep matches"
# — that path got us into trouble before, killing an unrelated `node
# dist/index.js` from a sibling project.
find_bot_pid() {
  if [ -f "$BOT_PID_FILE" ]; then
    local pid
    pid=$(cat "$BOT_PID_FILE" 2>/dev/null | tr -dc '0-9')
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

start_bot() {
  cd "$REPO_ROOT" || { log "cannot cd to $REPO_ROOT"; return 1; }
  # Use & + nohup so the child detaches from this script's process group.
  nohup npm start >> "$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true
  sleep 5
  log "started; new pid: $(find_bot_pid 2>/dev/null || echo unknown)"
}

kill_bot() {
  local pid="$1"
  log "stopping pid: $pid"
  kill -INT "$pid" 2>/dev/null || true
  sleep 5
  if ps -p "$pid" > /dev/null 2>&1; then
    log "force-killing $pid"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  sleep 1
  # Wipe the stale pid file so the next find_bot_pid reflects reality.
  rm -f "$BOT_PID_FILE"
}

# ----- run -----
# Heartbeat-first: if the heartbeat file is fresh, the bot is alive. Don't
# touch lsof, don't restart. This is the path that fires 99% of the time.
if [ -f "$HEARTBEAT_FILE" ]; then
  HEARTBEAT_TS=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
  NOW_MS=$(($(date +%s) * 1000))
  AGE_MS=$((NOW_MS - HEARTBEAT_TS))
  THRESHOLD_MS=$((HEARTBEAT_STALE_SECONDS * 1000))

  if [ "$AGE_MS" -ge 0 ] && [ "$AGE_MS" -le "$THRESHOLD_MS" ]; then
    # Healthy. We deliberately do NOT touch $RESTART_REASON_FILE here — the
    # bot itself reads + deletes it on boot (see src/index.ts
    # announceRestartAfterRespawn). A previous version cleaned it up as
    # "race-cleanup" if it found one alongside a healthy bot, but that
    # silently dropped the post-restart DM whenever a sibling supervisor
    # (e.g. job-intake's web.server) beat the watchdog to spawn a new bot.
    # Log occasionally for visibility (every ~10 runs = 20 min).
    RAND=$((RANDOM % 10))
    if [ "$RAND" -eq 0 ]; then
      log "ok (heartbeat_age=${AGE_MS}ms)"
    fi
    exit 0
  fi
fi

# Either heartbeat missing (first boot / wiped) or stale (process hung,
# crashed, or never wrote). Time to act.
BOT_PID=$(find_bot_pid 2>/dev/null || true)

if [ -z "$BOT_PID" ]; then
  log "no bot pid (file missing or pid dead) — starting"
  start_bot
  # If the bot left a $RESTART_REASON_FILE (e.g. /restart in Telegram or
  # POST /restart from an external monitor), the new bot will DM admins
  # itself once it boots. We stay silent in that case to avoid double-DMs.
  # Only DM ourselves when the bot crashed without leaving a reason.
  if [ ! -f "$RESTART_REASON_FILE" ]; then
    notify_admin "⚠️ Bot crashed (no process running) · respawned by ${WATCHDOG_NAME} · $(date '+%H:%M %Z')"
  fi
  exit 0
fi

# Bot pid is alive but heartbeat is stale or missing — bot is hung.
if [ ! -f "$HEARTBEAT_FILE" ]; then
  log "heartbeat missing (pid: $BOT_PID) — restarting"
  kill_bot "$BOT_PID"
  start_bot
  if [ ! -f "$RESTART_REASON_FILE" ]; then
    notify_admin "🔄 Bot was running but heartbeat file was missing (likely hung mid-startup) · killed + restarted by ${WATCHDOG_NAME} · $(date '+%H:%M %Z')"
  fi
  exit 0
fi

AGE_S=$((AGE_MS / 1000))
log "heartbeat stale (age=${AGE_MS}ms, threshold=${THRESHOLD_MS}ms, pid: $BOT_PID) — restarting"
kill_bot "$BOT_PID"
start_bot
if [ ! -f "$RESTART_REASON_FILE" ]; then
  notify_admin "🔄 Bot was hung (heartbeat ${AGE_S}s stale, threshold ${HEARTBEAT_STALE_SECONDS}s) · killed + restarted by ${WATCHDOG_NAME} · $(date '+%H:%M %Z')"
fi
