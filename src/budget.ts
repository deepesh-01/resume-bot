// Weekly Claude spend tracker. Surface a one-shot DM to admins when
// rolling-7-day cost crosses 80% of CLAUDE_WEEKLY_BUDGET_USD, so the
// user can pace work BEFORE Claude itself starts returning rate-limit
// errors mid-job. Empty/0 budget disables the check entirely.
//
// Persistence: the timestamp of the last alert is stored in
// ~/bot/.budget-alert.json so a bot restart doesn't re-fire on the
// same window.

import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { db } from './db.js'
import { logger } from './logger.js'
import type { Bot } from 'grammy'
import type { BotContext } from './bot.js'

const ALERT_THRESHOLD = 0.8
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // re-alert at most once a day
const STATE_FILE = path.join(
  path.dirname(config.WORKSPACE_ROOT),
  '.budget-alert.json',
)

interface AlertState {
  last_alert_ms: number
  last_pct: number
}

const readState = async (): Promise<AlertState | null> => {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8')
    const j = JSON.parse(raw) as Partial<AlertState>
    if (typeof j.last_alert_ms !== 'number') return null
    return {
      last_alert_ms: j.last_alert_ms,
      last_pct: typeof j.last_pct === 'number' ? j.last_pct : 0,
    }
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
      'budget-alert state write failed',
    )
  }
}

const _spend7d = db.prepare<[], { total: number | null }>(
  `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
     FROM usage
    WHERE created_at >= datetime('now', '-7 days')`,
)
export const getWeeklySpendUsd = (): number => {
  const row = _spend7d.get()
  return Number(row?.total ?? 0)
}

// Call this AFTER logUsage for any Claude invocation. Cheap (one indexed
// SUM on the usage table) so calling per-invocation is fine.
export const checkAndAlertIfOver80 = async (
  bot: Bot<BotContext>,
): Promise<void> => {
  const cap = config.CLAUDE_WEEKLY_BUDGET_USD
  if (cap <= 0) return // budget tracking disabled

  const spend = getWeeklySpendUsd()
  const pct = spend / cap
  if (pct < ALERT_THRESHOLD) return

  const state = await readState()
  if (state && Date.now() - state.last_alert_ms < ALERT_COOLDOWN_MS) {
    return // already alerted within cooldown
  }

  const pctRounded = Math.round(pct * 100)
  const msg =
    `⚠️ Claude weekly spend at ${pctRounded}% of cap` +
    ` ($${spend.toFixed(2)} / $${cap.toFixed(2)}, rolling 7 days).` +
    ` Pace work or expect CLAUDE_RATE_LIMIT errors mid-run.`

  for (const adminId of config.ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(adminId, msg)
    } catch (err) {
      logger.warn(
        { err: String(err), admin_chat_id: adminId },
        'budget-alert DM failed',
      )
    }
  }
  await writeState({ last_alert_ms: Date.now(), last_pct: pct })
  logger.warn(
    { event: 'budget_alert_fired', spend_usd: spend, cap_usd: cap, pct },
    'weekly spend crossed 80% — admins DMed',
  )
}
