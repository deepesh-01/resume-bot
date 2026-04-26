import type { BotContext } from '../bot.js'
import { db, getActiveJob, type JobRow } from '../db.js'

interface RecentRow {
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

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const fmtSubject = (j: { role: string | null; company: string | null }): string => {
  if (j.role && j.company) return `${j.role} at ${j.company}`
  return j.role ?? j.company ?? '(pasted JD)'
}

export const statusHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const active: JobRow | undefined = getActiveJob(chatId)

  const recent = db
    .prepare(
      `SELECT job_id, status, role, company, created_at, last_active_at, quality_score
       FROM jobs WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT 5`,
    )
    .all(chatId) as RecentRow[]

  const spend24 = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd), 0) AS total
       FROM usage WHERE chat_id = ?
         AND created_at >= datetime('now', '-24 hours')`,
    )
    .get(chatId) as SpendRow

  const lines: string[] = []

  if (active) {
    lines.push('<b>Active job</b>')
    lines.push(`<code>${escapeHtml(active.job_id)}</code>`)
    lines.push(`${escapeHtml(fmtSubject(active))}`)
    lines.push(`status: <i>${escapeHtml(active.status ?? '?')}</i>`)
    if (active.quality_score !== null && active.quality_score !== undefined) {
      lines.push(`quality: 🎯 <b>${active.quality_score}/100</b>`)
    }
    if (active.last_active_at) {
      lines.push(`last activity: ${escapeHtml(active.last_active_at)} UTC`)
    }
    lines.push('')
  } else {
    lines.push('<b>No active job.</b> Send a URL or paste a JD to start.')
    lines.push('')
  }

  if (recent.length > 0) {
    lines.push('<b>Recent jobs</b>')
    for (const j of recent) {
      const marker = j.status === 'ready' ? '🟢' : j.status === 'archived' ? '⚪️' : '🔴'
      const score =
        j.quality_score !== null && j.quality_score !== undefined
          ? ` · 🎯 ${j.quality_score}/100`
          : ''
      lines.push(
        `${marker} <code>${escapeHtml(j.job_id)}</code> — ${escapeHtml(fmtSubject(j))}${score}`,
      )
    }
    lines.push('')
  }

  lines.push(
    `<b>Spend last 24h:</b> $${spend24.total.toFixed(2)} (${spend24.n} runs)`,
  )

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}
