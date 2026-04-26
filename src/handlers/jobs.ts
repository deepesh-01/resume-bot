import type { BotContext } from '../bot.js'
import { db, type JobRow } from '../db.js'

const RECENT_LIMIT = 30

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const fmtSubject = (j: JobRow): string => {
  if (j.role && j.company) return `${j.role} at ${j.company}`
  return j.role ?? j.company ?? '(pasted JD)'
}

// SQLite datetime('now') is 'YYYY-MM-DD HH:MM:SS' in UTC; coerce to ISO and parse.
const fmtTimeAgo = (sqlDateTime: string | null): string => {
  if (!sqlDateTime) return ''
  const iso = sqlDateTime.replace(' ', 'T') + 'Z'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export const jobsHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE chat_id = ?
       ORDER BY last_active_at DESC, created_at DESC
       LIMIT ?`,
    )
    .all(chatId, RECENT_LIMIT) as JobRow[]

  if (rows.length === 0) {
    await ctx.reply('No jobs yet. Send a URL or paste a JD to start.')
    return
  }

  const lines: string[] = [
    `<b>Recent jobs (${rows.length}${rows.length === RECENT_LIMIT ? '+' : ''})</b>`,
    '',
  ]
  for (const j of rows) {
    const marker =
      j.status === 'ready' ? '🟢' : j.status === 'archived' ? '⚪️' : '🔴'
    const score =
      j.quality_score !== null && j.quality_score !== undefined
        ? ` · 🎯 ${j.quality_score}`
        : ''
    const ago = fmtTimeAgo(j.last_active_at)
    const time = ago ? ` · ${ago}` : ''
    lines.push(
      `${marker} <code>${escapeHtml(j.job_id)}</code> — ${escapeHtml(fmtSubject(j))}${score}${time}`,
    )
  }

  lines.push('')
  lines.push(
    'Use <code>/edit JOB_ID instruction</code> to refine an old job.',
  )
  lines.push(
    'Use <code>/reset JOB_ID</code> to wipe a specific job (destructive).',
  )

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}
