import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { db, getJob } from '../db.js'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// callback_data: reset_job:confirm:<jobId> | reset_job:cancel:<jobId>
export const resetJobCallback = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data?.startsWith('reset_job:')) return

  const parts = data.split(':')
  const action = parts[1]
  // job_ids contain underscores but no colons, so re-joining is safe.
  const jobId = parts.slice(2).join(':')
  if (!action || !jobId) return

  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  if (action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' })
    try {
      await ctx.editMessageText(
        `❌ Cancelled — <code>${escapeHtml(jobId)}</code> not wiped.`,
        { parse_mode: 'HTML' },
      )
    } catch {
      /* ignore */
    }
    return
  }

  if (action === 'confirm') {
    const job = getJob(jobId)
    if (!job || job.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'Job not found' })
      try {
        await ctx.editMessageText(
          `Job <code>${escapeHtml(jobId)}</code> not found.`,
          { parse_mode: 'HTML' },
        )
      } catch {
        /* ignore */
      }
      return
    }

    let dirRemoved = false
    if (job.workspace_path) {
      try {
        await fs.rm(job.workspace_path, { recursive: true, force: true })
        dirRemoved = true
      } catch (err) {
        ctx.logger.warn(
          { err: String(err), job_id: jobId },
          'job dir rm failed',
        )
      }
    }

    // Remove DB rows.
    db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId)
    db.prepare('DELETE FROM usage WHERE job_id = ?').run(jobId)

    ctx.logger.info(
      { event: 'job_wiped', job_id: jobId, dir_removed: dirRemoved },
      'job wiped',
    )

    await ctx.answerCallbackQuery({ text: 'Wiped' })
    try {
      await ctx.editMessageText(
        `🗑️ Wiped <code>${escapeHtml(jobId)}</code>.`,
        { parse_mode: 'HTML' },
      )
    } catch {
      /* ignore */
    }
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' })
}
