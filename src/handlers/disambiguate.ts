import type { BotContext } from '../bot.js'
import { clearPending, getPending } from '../disambiguate.js'
import { setJobStatus } from '../db.js'
import { runJob } from '../runJob.js'
import { runEditFlow } from '../runEdit.js'

// Telegram callback_data values produced by jobMessage.ts:
//   pend:new   → process the buffer as a NEW job (archive any active first)
//   pend:edit  → process the buffer as an edit instruction on the active job
//   pend:more  → user is still typing; keep buffer alive, do nothing
export const disambiguateCallback = async (
  ctx: BotContext,
): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data?.startsWith('pend:')) return

  const action = data.split(':')[1]
  const chatId = ctx.chat?.id
  if (chatId === undefined || !action) return

  if (action === 'more') {
    await ctx.answerCallbackQuery({ text: 'Waiting — keep going.' })
    return
  }

  const peek = getPending(chatId)
  if (!peek) {
    await ctx.answerCallbackQuery({
      text: 'This prompt has expired.',
    })
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } catch {
      /* ignore */
    }
    return
  }

  await ctx.answerCallbackQuery({
    text: action === 'new' ? 'Starting fresh' : 'Editing current',
  })
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
  } catch (err) {
    ctx.logger.warn({ err }, 'failed to strip prompt buttons')
  }

  const state = clearPending(chatId)
  if (!state) return // race; nothing to do

  if (action === 'new') {
    if (state.jobId) {
      setJobStatus(state.jobId, 'archived')
      ctx.logger.info(
        { event: 'pend_new', archived_job: state.jobId, words: state.text },
        'archived active job, starting new',
      )
    } else {
      ctx.logger.info(
        { event: 'pend_new_first', total_chars: state.text.length },
        'starting first job from buffer',
      )
    }
    await runJob(ctx, { text: state.text })
  } else if (action === 'edit') {
    if (!state.jobId) {
      // Defensive — shouldn't happen because the edit button only renders
      // when state.jobId is set. Fall back to new job to avoid losing input.
      ctx.logger.warn(
        { event: 'pend_edit_no_job' },
        'edit chosen but no jobId; falling back to new job',
      )
      await runJob(ctx, { text: state.text })
      return
    }
    ctx.logger.info(
      { event: 'pend_edit', job_id: state.jobId },
      'routing buffer as edit',
    )
    await runEditFlow(ctx, state.text)
  }
}
