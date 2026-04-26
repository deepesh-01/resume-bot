// /userstatus <chat_id> — admin: full picture for a single user.
// Identity, allow/block state, onboarding, recent jobs, all-time +
// rolling spend, last claude call. Same content is reachable via the
// inline button rendered in /users so admins can drill in with a tap.

import type { BotContext } from '../bot.js'
import {
  db,
  getActiveJob,
  getAllowedUser,
  getUser,
  type JobRow,
  type UserRow,
} from '../db.js'
import { isAdmin } from '../access.js'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const fmtSubject = (j: { role: string | null; company: string | null }): string => {
  if (j.role && j.company) return `${j.role} at ${j.company}`
  return j.role ?? j.company ?? '(pasted JD)'
}

interface RecentJobRow {
  job_id: string
  status: string | null
  role: string | null
  company: string | null
  created_at: string | null
  last_active_at: string | null
  quality_score: number | null
}

interface SpendRow {
  n: number
  total: number
}

interface SpendByTypeRow {
  invocation_type: string | null
  n: number
  total: number
}

interface BlockedRow {
  chat_id: number
  reason: string | null
  blocked_at: string
}

interface LastUsageRow {
  invocation_type: string | null
  total_cost_usd: number | null
  duration_ms: number | null
  created_at: string | null
}

const _spendWindow = db.prepare<
  [number, string],
  { n: number; total: number | null }
>(
  `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd), 0) AS total
     FROM usage
    WHERE chat_id = ?
      AND created_at >= datetime('now', ?)`,
)
const spendInWindow = (chatId: number, sqliteOffset: string): SpendRow => {
  const row = _spendWindow.get(chatId, sqliteOffset)
  return { n: row?.n ?? 0, total: Number(row?.total ?? 0) }
}

const _spendAllTime = db.prepare<
  [number],
  { n: number; total: number | null }
>(
  `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd), 0) AS total
     FROM usage WHERE chat_id = ?`,
)

const _spendByType7d = db.prepare<[number], SpendByTypeRow>(
  `SELECT invocation_type,
          COUNT(*) AS n,
          COALESCE(SUM(total_cost_usd), 0) AS total
     FROM usage
    WHERE chat_id = ?
      AND created_at >= datetime('now', '-7 days')
    GROUP BY invocation_type
    ORDER BY total DESC`,
)

const _jobsCount = db.prepare<[number], { n: number }>(
  `SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ?`,
)

const _recentJobs = db.prepare<[number], RecentJobRow>(
  `SELECT job_id, status, role, company, created_at, last_active_at, quality_score
     FROM jobs WHERE chat_id = ?
     ORDER BY created_at DESC LIMIT 5`,
)

const _lastUsage = db.prepare<[number], LastUsageRow>(
  `SELECT invocation_type, total_cost_usd, duration_ms, created_at
     FROM usage WHERE chat_id = ?
     ORDER BY created_at DESC LIMIT 1`,
)

const _blocked = db.prepare<[number], BlockedRow>(
  `SELECT chat_id, reason, blocked_at FROM blocked_users WHERE chat_id = ?`,
)

// Map invocation_type letter → human label. Mirrors ADR-007/009 and the
// runJob.ts call sites. Letters not listed here pass through as-is.
const INVOCATION_LABEL: Record<string, string> = {
  A: 'tailor',
  D: 'critic',
  E: 'refine',
  X: 'edit',
}

const labelFor = (t: string | null): string => {
  if (!t) return '?'
  return INVOCATION_LABEL[t] ?? t
}

export const formatUserStatus = (targetChatId: number): string => {
  const user: UserRow | undefined = getUser(targetChatId)
  const allowed = getAllowedUser(targetChatId)
  const blockedRow = _blocked.get(targetChatId)
  const active: JobRow | undefined = getActiveJob(targetChatId)
  const totalJobs = _jobsCount.get(targetChatId)?.n ?? 0
  const recent = _recentJobs.all(targetChatId)
  const spend24 = spendInWindow(targetChatId, '-24 hours')
  const spend7d = spendInWindow(targetChatId, '-7 days')
  const spendAll = (() => {
    const row = _spendAllTime.get(targetChatId)
    return { n: row?.n ?? 0, total: Number(row?.total ?? 0) }
  })()
  const byType7d = _spendByType7d.all(targetChatId)
  const lastInv = _lastUsage.get(targetChatId)

  if (!user && !allowed && !blockedRow && spendAll.n === 0) {
    return `No user with chat_id <code>${targetChatId}</code> in db.`
  }

  const lines: string[] = []

  // ---- Identity ----
  const handle = user?.username
    ? `@${escapeHtml(user.username)}`
    : escapeHtml(user?.display_name ?? '—')
  lines.push(`<b>${handle}</b> · <code>${targetChatId}</code>`)
  if (user?.display_name && user.username && user.display_name !== user.username) {
    lines.push(`<i>${escapeHtml(user.display_name)}</i>`)
  }

  // ---- Status (allow / block / onboarding) ----
  if (blockedRow) {
    const reason = blockedRow.reason ? ` · "${escapeHtml(blockedRow.reason)}"` : ''
    lines.push(
      `🚫 <b>blocked</b> ${escapeHtml(blockedRow.blocked_at)} UTC${reason}`,
    )
  } else if (allowed) {
    const expiry = allowed.expires_at
      ? `expires ${escapeHtml(allowed.expires_at)} UTC`
      : '<i>permanent</i>'
    lines.push(
      `✅ allowed ${escapeHtml(allowed.added_at)} UTC · ${expiry}`,
    )
  } else if (user) {
    lines.push(`⚠️ in users table but NOT on the allowlist`)
  } else {
    lines.push(`(no users-table row, but found in usage history)`)
  }
  if (user) {
    lines.push(
      `onboarded: ${user.onboarded ? '✓' : '✗'} · joined ${escapeHtml(user.created_at ?? '?')} UTC`,
    )
  }
  lines.push('')

  // ---- Activity ----
  lines.push(`<b>Activity</b>`)
  lines.push(`jobs total: ${totalJobs}`)
  if (active) {
    const score =
      active.quality_score !== null && active.quality_score !== undefined
        ? ` · 🎯 ${active.quality_score}/100`
        : ''
    lines.push(
      `active: <code>${escapeHtml(active.job_id)}</code> — ${escapeHtml(fmtSubject(active))} (${escapeHtml(active.status ?? '?')})${score}`,
    )
    if (active.last_active_at) {
      lines.push(`last activity: ${escapeHtml(active.last_active_at)} UTC`)
    }
  } else {
    lines.push(`active: <i>none</i>`)
  }
  if (lastInv?.created_at) {
    const cost =
      lastInv.total_cost_usd !== null && lastInv.total_cost_usd !== undefined
        ? `$${Number(lastInv.total_cost_usd).toFixed(4)}`
        : '$?'
    lines.push(
      `last claude call: ${escapeHtml(labelFor(lastInv.invocation_type))} · ${cost} · ${escapeHtml(lastInv.created_at)} UTC`,
    )
  }
  lines.push('')

  // ---- Spend ----
  lines.push(`<b>Spend</b>`)
  lines.push(
    `last 24h: $${spend24.total.toFixed(2)} (${spend24.n} runs)`,
  )
  lines.push(
    `last 7d:  $${spend7d.total.toFixed(2)} (${spend7d.n} runs)`,
  )
  lines.push(
    `all-time: $${spendAll.total.toFixed(2)} (${spendAll.n} runs)`,
  )
  if (byType7d.length > 0) {
    lines.push('')
    lines.push(`<b>7d breakdown by call type</b>`)
    for (const r of byType7d) {
      lines.push(
        `${escapeHtml(labelFor(r.invocation_type))} (${escapeHtml(r.invocation_type ?? '?')}): $${Number(r.total).toFixed(2)} · ${r.n} runs`,
      )
    }
  }
  lines.push('')

  // ---- Recent jobs ----
  if (recent.length > 0) {
    lines.push(`<b>Recent jobs</b>`)
    for (const j of recent) {
      const marker =
        j.status === 'ready'
          ? '🟢'
          : j.status === 'archived'
            ? '⚪️'
            : j.status === 'failed'
              ? '🔴'
              : '🟡'
      const score =
        j.quality_score !== null && j.quality_score !== undefined
          ? ` · 🎯 ${j.quality_score}/100`
          : ''
      lines.push(
        `${marker} <code>${escapeHtml(j.job_id)}</code> — ${escapeHtml(fmtSubject(j))}${score}`,
      )
    }
  }

  return lines.join('\n')
}

const parseChatIdArg = (raw: string | undefined): number | null => {
  const m = (raw ?? '').trim()
  if (m === '') return null
  const n = Number(m)
  return Number.isFinite(n) ? n : null
}

// /userstatus <chat_id>
export const userStatusHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const chatId = parseChatIdArg(ctx.match as string | undefined)
  if (chatId === null) {
    await ctx.reply(
      'Usage: <code>/userstatus &lt;chat_id&gt;</code>',
      { parse_mode: 'HTML' },
    )
    return
  }

  const body = formatUserStatus(chatId)
  await ctx.reply(body, { parse_mode: 'HTML' })
}

// userstatus:<chat_id> callback (fired from the /users inline keyboard).
export const userStatusCallback = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) {
    await ctx.answerCallbackQuery({ text: 'admin only' }).catch(() => undefined)
    return
  }

  const data = ctx.callbackQuery?.data ?? ''
  const idStr = data.slice('userstatus:'.length)
  const chatId = Number(idStr)
  if (!Number.isFinite(chatId)) {
    await ctx.answerCallbackQuery({ text: 'bad chat_id' }).catch(() => undefined)
    return
  }

  await ctx.answerCallbackQuery({ text: '📊 fetching…' }).catch(() => undefined)
  const body = formatUserStatus(chatId)
  await ctx.reply(body, { parse_mode: 'HTML' })
}
