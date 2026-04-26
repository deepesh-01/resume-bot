import type { BotContext } from '../bot.js'
import { getJob, setJobStatus, touchJob } from '../db.js'
import { runEditFlow } from '../runEdit.js'

// /edit JOB_ID instruction
//   Reactivate JOB_ID (set status=ready, touch last_active_at) so it becomes
//   the active job, then run the standard edit flow with the instruction.
//   Future short-text edits will land on this job until /reset or another
//   /edit on a different job_id.
export const editHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const arg = ((ctx.match as string | undefined) ?? '').trim()
  if (!arg) {
    await ctx.reply(
      'Usage: <code>/edit JOB_ID your edit instruction</code>\n\n' +
        'See /jobs for ids.',
      { parse_mode: 'HTML' },
    )
    return
  }

  const tokens = arg.split(/\s+/)
  const jobId = tokens[0] ?? ''
  const instruction = tokens.slice(1).join(' ').trim()

  if (!instruction) {
    await ctx.reply(
      'Provide an instruction after the job id.\n\n' +
        'Example: <code>/edit 20260426_linkedin_4 trim summary to one line</code>',
      { parse_mode: 'HTML' },
    )
    return
  }

  const job = getJob(jobId)
  if (!job || job.chat_id !== chatId) {
    await ctx.reply(
      `No job <code>${jobId}</code> found in your history. /jobs to see ids.`,
      { parse_mode: 'HTML' },
    )
    return
  }

  if (!job.session_id || !job.workspace_path) {
    await ctx.reply(
      `Job <code>${jobId}</code> is missing session data — can't edit. Try /reset ${jobId} and re-run from JD.`,
      { parse_mode: 'HTML' },
    )
    return
  }

  if (job.status !== 'ready') {
    setJobStatus(jobId, 'ready')
  }
  touchJob(jobId)

  ctx.logger.info(
    { event: 'edit_explicit', job_id: jobId },
    '/edit on specific job',
  )

  await runEditFlow(ctx, instruction)
}
