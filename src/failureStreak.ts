// Failure-streak detector. The watchdog only knows "process alive +
// heartbeat fresh". A bot can be polling Telegram fine but failing every
// single job underneath it (the spawn-claude-ENOENT incident on 2026-04-28
// was exactly this — RCA in ADR-031). This module detects that pattern
// from the DB and DMs admins so a degraded bot doesn't sit silent.
//
// Trigger: ≥3 of the last 5 jobs (across ALL chats) failed within the last
// hour. Cooldown: at most 1 alert per 30 min so we don't spam during a
// real outage. State persisted to ~/bot/.failure-streak-alert.json so a
// restart doesn't re-fire on the same window.

import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { db } from './db.js'
import { logger } from './logger.js'
import type { Bot } from 'grammy'
import type { BotContext } from './bot.js'

const STREAK_WINDOW = 5
const STREAK_THRESHOLD = 3 // ≥3 of the last 5 must be 'failed'
const RECENT_HOURS = 1
const COOLDOWN_MS = 30 * 60 * 1000

const STATE_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.failure-streak-alert.json',
)

interface AlertState {
  last_alert_ms: number
}

const readState = async (): Promise<AlertState | null> => {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8')
    const j = JSON.parse(raw) as Partial<AlertState>
    if (typeof j.last_alert_ms !== 'number') return null
    return { last_alert_ms: j.last_alert_ms }
  } catch {
    return null
  }
}

const writeState = async (s: AlertState): Promise<void> => {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(s))
  } catch (err) {
    logger.warn(
      { err: String(err), file: STATE_FILE },
      'failure-streak state write failed',
    )
  }
}

interface RecentJobRow {
  job_id: string
  chat_id: number
  status: string | null
  created_at: string | null
}

const _recentJobs = db.prepare<[number], RecentJobRow>(
  `SELECT job_id, chat_id, status, created_at
     FROM jobs
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
    ORDER BY created_at DESC
    LIMIT ${STREAK_WINDOW}`,
)

interface LastErrorRow {
  job_id: string
  chat_id: number
  status: string
  created_at: string
}
const _lastFailedJob = db.prepare<[], LastErrorRow>(
  `SELECT job_id, chat_id, status, created_at
     FROM jobs
    WHERE status = 'failed'
    ORDER BY last_active_at DESC
    LIMIT 1`,
)

// Call after every job-finalising setJobStatus(_, 'failed'). Cheap: one
// indexed query on the jobs table + a small JSON file read.
export const checkFailureStreak = async (
  bot: Bot<BotContext>,
): Promise<void> => {
  const recent = _recentJobs.all(RECENT_HOURS)
  if (recent.length < STREAK_THRESHOLD) return

  const failedCount = recent.filter((r) => r.status === 'failed').length
  if (failedCount < STREAK_THRESHOLD) return

  const state = await readState()
  if (state && Date.now() - state.last_alert_ms < COOLDOWN_MS) {
    logger.info(
      { event: 'failure_streak_suppressed_cooldown' },
      'failure-streak cooldown active, not alerting',
    )
    return
  }

  // Look up the most recent failed row's last error string is harder
  // because we don't persist error strings — but at least we can show
  // which jobs are involved. (A future improvement: write a last-error
  // column on the jobs row.)
  const lastFailed = _lastFailedJob.get()
  const sample =
    lastFailed && lastFailed.created_at
      ? `\n\nLast failed job: <code>${lastFailed.job_id}</code> (chat ${lastFailed.chat_id}) at ${lastFailed.created_at} UTC`
      : ''
  const involvedJobs = recent
    .filter((r) => r.status === 'failed')
    .map((r) => r.job_id)
    .slice(0, 3)

  const msg =
    `🚨 <b>Failure streak detected</b>\n` +
    `${failedCount}/${recent.length} of the last ${STREAK_WINDOW} jobs in the past ${RECENT_HOURS}h have failed.\n` +
    `Sample failed job_ids: <code>${involvedJobs.join(', ')}</code>${sample}\n\n` +
    `Likely causes: claude CLI auth or rate-limit (check <code>${'/sysstatus'}</code>), missing system binary on PATH, or a code regression on the last deploy.`

  for (const adminId of config.ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(adminId, msg, { parse_mode: 'HTML' })
    } catch (err) {
      logger.warn(
        { err: String(err), admin_chat_id: adminId },
        'failure-streak DM did not deliver',
      )
    }
  }
  await writeState({ last_alert_ms: Date.now() })
  logger.warn(
    { event: 'failure_streak_alert_fired', failed_count: failedCount, sample: involvedJobs },
    'failure streak crossed threshold — admins DMed',
  )
}
