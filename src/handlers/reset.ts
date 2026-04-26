import type { BotContext } from '../bot.js'
import { getActiveJob, getJob, setJobStatus } from '../db.js'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// /reset           → archive currently active job (no confirm; reversible)
// /reset JOB_ID    → confirmation prompt → on confirm, wipe job dir + DB rows
export const resetHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const arg = ((ctx.match as string | undefined) ?? '').trim()

  if (!arg) {
    const active = getActiveJob(chatId)
    if (!active) {
      await ctx.reply(
        'No active job to reset. Send a URL or paste a JD to start.',
      )
      return
    }
    setJobStatus(active.job_id, 'archived')
    ctx.logger.info(
      { event: 'reset', archived_job: active.job_id },
      'active job archived via /reset',
    )
    await ctx.reply(
      `Active job ended (${active.job_id}). Send a URL or paste a JD to start fresh.`,
    )
    return
  }

  // /reset JOB_ID — destructive; confirm with buttons.
  const jobId = arg
  const job = getJob(jobId)
  if (!job || job.chat_id !== chatId) {
    await ctx.reply(
      `No job <code>${escapeHtml(jobId)}</code> found in your history.`,
      { parse_mode: 'HTML' },
    )
    return
  }

  await ctx.reply(
    `<b>Wipe job <code>${escapeHtml(jobId)}</code>?</b>\n\n` +
      `Deletes the job folder (resume.md, PDF, JD, session) and removes it from your history. Cannot be undone.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🗑️ Wipe job',
              callback_data: `reset_job:confirm:${jobId}`,
            },
            { text: '❌ Cancel', callback_data: `reset_job:cancel:${jobId}` },
          ],
        ],
      },
    },
  )
}
