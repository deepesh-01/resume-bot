// Heartbeat writer. The bot writes the current timestamp to a file every
// HEARTBEAT_INTERVAL_MS. An external watchdog (scripts/watchdog.sh) checks
// the file's freshness; if stale beyond a threshold, it kills the process
// and restarts the bot. This catches "hung but alive" failures (e.g. a
// Telegram API call that never returns) that a simple PID check misses.

import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'

export const HEARTBEAT_INTERVAL_MS = 60_000
// WORKSPACE_ROOT is ~/bot/users; we want ~/bot/.heartbeat
export const HEARTBEAT_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.heartbeat',
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
  void tick()
  timer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS)
  // Don't pin the event loop on the heartbeat alone.
  if (typeof timer.unref === 'function') timer.unref()
  logger.info(
    { event: 'heartbeat_started', interval_ms: HEARTBEAT_INTERVAL_MS, file: HEARTBEAT_FILE },
    'heartbeat scheduled',
  )
}

export const stopHeartbeat = (): void => {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}
