// /sysstatus — admin: at-a-glance system health snapshot. Designed to be
// the answer to "is the bot actually doing real work, or is it just
// alive?" — the question /healthz can't answer because the watchdog only
// checks heartbeat freshness. Dimensions covered:
//   • runtime: pid, uptime, NODE_ENV, daily log file present + size
//   • binaries: claude / pandoc / typst resolved paths and versions
//   • workers: watchdog last-tick + interval, backup last-tick + count
//   • DB activity: jobs in last 24h by status, recent error sample
//   • disk: workspace + logs + backups footprint

import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import type { BotContext } from '../bot.js'
import { isAdmin } from '../access.js'
import { config } from '../config.js'
import { db } from '../db.js'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const which = (cmd: string): string | undefined => {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], {
    encoding: 'utf8',
  })
  if (r.status !== 0) return undefined
  return r.stdout.trim() || undefined
}

const versionLine = (cmd: string): string | undefined => {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) return undefined
  const out = r.stdout.trim() || r.stderr.trim()
  return out.split('\n')[0]
}

const fmtUptime = (sec: number): string => {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  if (sec < 86400)
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`
  return `${(n / 1024 ** 3).toFixed(2)}GB`
}

const dirSize = async (dir: string): Promise<number> => {
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' })
  if (r.status !== 0) return 0
  const kb = Number(r.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(kb) ? kb * 1024 : 0
}

const lastMtime = async (file: string): Promise<Date | null> => {
  try {
    const st = await fs.stat(file)
    return st.mtime
  } catch {
    return null
  }
}

const fmtAgo = (d: Date | null): string => {
  if (!d) return 'never'
  const sec = (Date.now() - d.getTime()) / 1000
  return `${fmtUptime(sec)} ago`
}

interface JobsByStatusRow {
  status: string | null
  n: number
}
interface RecentFailedRow {
  job_id: string
  chat_id: number
  created_at: string | null
}

const _jobsByStatus24h = db.prepare<[], JobsByStatusRow>(
  `SELECT status, COUNT(*) AS n FROM jobs
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY status ORDER BY n DESC`,
)
const _recentFailed = db.prepare<[], RecentFailedRow>(
  `SELECT job_id, chat_id, created_at FROM jobs
    WHERE status = 'failed'
      AND created_at >= datetime('now', '-24 hours')
    ORDER BY created_at DESC LIMIT 5`,
)

export const sysstatusHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const home = os.homedir()
  const botRoot = path.dirname(config.WORKSPACE_ROOT)

  // ---- runtime ----
  const uptime = process.uptime()
  const todayLog = path.join(
    config.LOG_DIR,
    `${new Date().toISOString().slice(0, 10)}.log`,
  )
  const todayLogStat = await fs.stat(todayLog).catch(() => null)
  const heartbeatAge = await (async () => {
    try {
      const raw = await fs.readFile(path.join(botRoot, '.heartbeat'), 'utf8')
      return Date.now() - Number(raw.trim())
    } catch {
      return null
    }
  })()

  // ---- binaries ----
  const claudePath = which('claude')
  const pandocPath = which('pandoc')
  const typstPath = which('typst')

  // ---- workers ----
  const watchdogLog = path.join(config.LOG_DIR, 'watchdog.log')
  const backupLog = path.join(config.LOG_DIR, 'backup.log')
  const watchdogMtime = await lastMtime(watchdogLog)
  const backupMtime = await lastMtime(backupLog)
  let backupCount = 0
  try {
    const entries = await fs.readdir(path.join(botRoot, 'backups'))
    backupCount = entries.filter((e) => e.startsWith('bot_') && e.endsWith('.tar.gz'))
      .length
  } catch {
    /* dir missing */
  }

  // ---- DB ----
  const jobsByStatus = _jobsByStatus24h.all()
  const recentFailed = _recentFailed.all()

  // ---- disk ----
  const sizes = await Promise.all([
    dirSize(config.WORKSPACE_ROOT),
    dirSize(config.LOG_DIR),
    dirSize(path.join(botRoot, 'backups')),
    dirSize(path.join(botRoot, 'archive')).catch(() => 0),
  ])

  // ---- compose ----
  const lines: string[] = []
  lines.push(`<b>🩺 sysstatus · pid ${process.pid}</b>`)
  lines.push(
    `uptime: ${fmtUptime(uptime)} · NODE_ENV: ${escapeHtml(config.NODE_ENV)} · node: ${escapeHtml(process.version)}`,
  )

  // Daily log
  if (todayLogStat) {
    lines.push(
      `today's log: ✅ <code>${escapeHtml(todayLog.replace(home, '~'))}</code> (${fmtBytes(todayLogStat.size)})`,
    )
  } else {
    lines.push(
      `today's log: ❌ <code>${escapeHtml(todayLog.replace(home, '~'))}</code> <b>missing</b> — logger may be writing to stdout instead of file`,
    )
  }

  // Heartbeat
  if (heartbeatAge !== null) {
    const fresh = heartbeatAge < 180_000
    lines.push(
      `heartbeat: ${fresh ? '✅' : '⚠️'} ${Math.round(heartbeatAge / 1000)}s old (threshold 180s)`,
    )
  } else {
    lines.push(`heartbeat: ❌ file missing or unreadable`)
  }
  lines.push('')

  // Binaries
  lines.push(`<b>Binaries</b>`)
  for (const [name, p] of [
    ['claude', claudePath],
    ['pandoc', pandocPath],
    ['typst', typstPath],
  ] as const) {
    if (p) {
      const v = versionLine(name)
      lines.push(
        `${name}: ✅ <code>${escapeHtml(p.replace(home, '~'))}</code>${v ? ` · ${escapeHtml(v)}` : ''}`,
      )
    } else {
      lines.push(`${name}: ❌ <b>not on PATH</b>`)
    }
  }
  lines.push('')

  // Workers
  lines.push(`<b>Workers</b>`)
  lines.push(`watchdog last log: ${fmtAgo(watchdogMtime)}`)
  lines.push(
    `backup last log: ${fmtAgo(backupMtime)} · ${backupCount} tarball(s) on disk`,
  )
  lines.push('')

  // DB activity
  lines.push(`<b>Jobs (last 24h)</b>`)
  if (jobsByStatus.length === 0) {
    lines.push('<i>no jobs in the last 24h</i>')
  } else {
    for (const r of jobsByStatus) {
      const emoji =
        r.status === 'ready'
          ? '🟢'
          : r.status === 'archived'
            ? '⚪️'
            : r.status === 'failed'
              ? '🔴'
              : r.status === 'generating'
                ? '🟡'
                : r.status === 'interrupted'
                  ? '🟠'
                  : '·'
      lines.push(`${emoji} ${escapeHtml(r.status ?? '?')}: ${r.n}`)
    }
  }

  if (recentFailed.length > 0) {
    lines.push('')
    lines.push(`<b>Recent failures (last 24h)</b>`)
    for (const r of recentFailed) {
      lines.push(
        `🔴 <code>${escapeHtml(r.job_id)}</code> chat=${r.chat_id} · ${escapeHtml(r.created_at ?? '?')}`,
      )
    }
  }
  lines.push('')

  // Disk
  lines.push(`<b>Disk (${escapeHtml(botRoot.replace(home, '~'))})</b>`)
  lines.push(
    `users: ${fmtBytes(sizes[0]!)} · logs: ${fmtBytes(sizes[1]!)} · backups: ${fmtBytes(sizes[2]!)} · archive: ${fmtBytes(sizes[3]!)}`,
  )

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
}
