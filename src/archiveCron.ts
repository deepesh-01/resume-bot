// Daily sweep: find jobs idle >30 days, tar.gz their workspace dir into
// ~/bot/archive/<chat_id>/<job_id>.tar.gz, remove the working dir, clear
// workspace_path in the DB so we don't re-archive on the next sweep.
//
// History (DB rows) is preserved — only the on-disk workspace is reclaimed.

import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { db } from './db.js'
import { logger } from './logger.js'
import { config } from './config.js'

export const IDLE_DAYS = 30
const ARCHIVE_DIR = path.join(path.dirname(config.WORKSPACE_ROOT), 'archive')
const ONE_DAY_MS = 24 * 60 * 60 * 1000

interface IdleJobRow {
  job_id: string
  chat_id: number
  workspace_path: string | null
  last_active_at: string | null
}

const _findIdle = db.prepare(`
  SELECT job_id, chat_id, workspace_path, last_active_at
  FROM jobs
  WHERE workspace_path IS NOT NULL
    AND last_active_at IS NOT NULL
    AND last_active_at < datetime('now', '-' || ? || ' days')
`)

const _clearWorkspacePath = db.prepare(
  `UPDATE jobs SET workspace_path = NULL WHERE job_id = ?`,
)

const findIdleJobs = (idleDays = IDLE_DAYS): IdleJobRow[] =>
  _findIdle.all(idleDays) as IdleJobRow[]

const archiveJob = async (job: IdleJobRow): Promise<boolean> => {
  if (!job.workspace_path) return false

  // Don't re-archive a dir that's already gone (DB drift).
  try {
    await fs.access(job.workspace_path)
  } catch {
    logger.info(
      { job_id: job.job_id, workspace_path: job.workspace_path },
      'workspace dir already absent — clearing path only',
    )
    _clearWorkspacePath.run(job.job_id)
    return true
  }

  const subDir = path.join(ARCHIVE_DIR, String(job.chat_id))
  await fs.mkdir(subDir, { recursive: true, mode: 0o700 })
  const tarPath = path.join(subDir, `${job.job_id}.tar.gz`)

  const parentDir = path.dirname(job.workspace_path)
  const baseName = path.basename(job.workspace_path)

  // Native tar: `tar -czf <out> -C <parent> <basename>`.
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('tar', ['-czf', tarPath, '-C', parentDir, baseName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      logger.warn({ err: String(err), job_id: job.job_id }, 'tar spawn error')
      resolve(-1)
    })
    child.on('exit', (code) => {
      if (code !== 0 && stderr) {
        logger.warn(
          { code, job_id: job.job_id, stderr: stderr.slice(0, 300) },
          'tar non-zero exit',
        )
      }
      resolve(code ?? -1)
    })
  })

  if (exitCode !== 0) return false

  try {
    await fs.access(tarPath)
  } catch {
    logger.warn(
      { job_id: job.job_id, tarPath },
      'tarball missing after tar exit=0',
    )
    return false
  }

  await fs.rm(job.workspace_path, { recursive: true, force: true })
  _clearWorkspacePath.run(job.job_id)
  return true
}

export const runArchiveSweep = async (): Promise<{
  archived: number
  failed: number
  total: number
}> => {
  const start = Date.now()
  const jobs = findIdleJobs()
  if (jobs.length === 0) {
    logger.info(
      { event: 'archive_sweep', archived: 0, total: 0 },
      'archive sweep: nothing to do',
    )
    return { archived: 0, failed: 0, total: 0 }
  }

  let archived = 0
  let failed = 0
  for (const job of jobs) {
    try {
      const ok = await archiveJob(job)
      if (ok) archived++
      else failed++
    } catch (err) {
      logger.warn(
        { err: String(err), job_id: job.job_id },
        'archive job error',
      )
      failed++
    }
  }
  logger.info(
    {
      event: 'archive_sweep',
      archived,
      failed,
      total: jobs.length,
      duration_ms: Date.now() - start,
    },
    'archive sweep complete',
  )
  return { archived, failed, total: jobs.length }
}

let timer: NodeJS.Timeout | undefined

export const startArchiveCron = (): void => {
  // Run once at startup (so a long-offline laptop catches up), then daily.
  void runArchiveSweep().catch((err) => {
    logger.warn({ err: String(err) }, 'startup archive sweep failed')
  })
  timer = setInterval(() => {
    void runArchiveSweep().catch((err) => {
      logger.warn({ err: String(err) }, 'periodic archive sweep failed')
    })
  }, ONE_DAY_MS)
  // Don't pin the event loop on the timer alone.
  if (typeof timer.unref === 'function') timer.unref()
  logger.info(
    { event: 'archive_cron_started', interval_ms: ONE_DAY_MS, idle_days: IDLE_DAYS },
    'archive cron scheduled',
  )
}

export const stopArchiveCron = (): void => {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}
