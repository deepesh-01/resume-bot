// Heartbeat writer. The bot writes the current timestamp to a file every
// HEARTBEAT_INTERVAL_MS. An external watchdog (scripts/watchdog.sh) checks
// the file's freshness; if stale beyond a threshold, it kills the process
// and restarts the bot. This catches "hung but alive" failures (e.g. a
// Telegram API call that never returns) that a simple PID check misses.

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'

export const HEARTBEAT_INTERVAL_MS = 60_000
// WORKSPACE_ROOT is ~/bot/users; we want ~/bot/.heartbeat
export const HEARTBEAT_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.heartbeat',
)

// Sibling file used to attribute a restart. The /restart HTTP handler
// writes the trigger source here before exit; the watchdog reads + deletes
// it on its next tick to attribute the DM.
export const RESTART_REASON_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.restart-reason',
)

// Authoritative pid record for the watchdog. The watchdog uses this file
// (NOT pgrep + lsof) to identify which `node dist/index.js` is the
// resume-builder bot — pgrep alone matches unrelated bots in other repos,
// and lsof-based cwd lookup is unreliable under launchd's TCC sandbox.
export const BOT_PID_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.bot.pid',
)

let timer: NodeJS.Timeout | undefined

const tick = async (): Promise<void> => {
  try {
    await fs.writeFile(HEARTBEAT_FILE, String(Date.now()))
  } catch (err) {
    // Don't spam the log; a single warn is enough to flag a real issue.
    logger.warn(
      { err: String(err), file: HEARTBEAT_FILE },
      'heartbeat write failed',
    )
  }
}

export const startHeartbeat = (): void => {
  // Write the pid file synchronously so the watchdog can identify us
  // immediately, even before the first heartbeat tick lands.
  try {
    fsSync.writeFileSync(BOT_PID_FILE, String(process.pid))
  } catch (err) {
    logger.warn({ err: String(err), file: BOT_PID_FILE }, 'pid file write failed')
  }
  void tick()
  timer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS)
  // Don't pin the event loop on the heartbeat alone.
  if (typeof timer.unref === 'function') timer.unref()
  logger.info(
    {
      event: 'heartbeat_started',
      interval_ms: HEARTBEAT_INTERVAL_MS,
      heartbeat_file: HEARTBEAT_FILE,
      pid_file: BOT_PID_FILE,
    },
    'heartbeat scheduled',
  )
}

export const stopHeartbeat = (): void => {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  // Best-effort: only remove the pid file if it still points at us. This
  // way a fast crash-and-restart won't wipe out the new process's claim.
  try {
    const recorded = fsSync.readFileSync(BOT_PID_FILE, 'utf8').trim()
    if (recorded === String(process.pid)) {
      fsSync.unlinkSync(BOT_PID_FILE)
    }
  } catch {
    // ignore — file may already be gone
  }
}
