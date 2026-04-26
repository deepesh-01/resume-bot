import type { BotContext } from '../bot.js'
import { getActiveJob } from '../db.js'
import { STRINGS } from '../strings.js'

export const doneHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const active = getActiveJob(chatId)
  if (!active) {
    ctx.logger.info({ event: 'done_no_active_job' }, '/done with no active job')
    return
  }

  ctx.logger.info(
    { event: 'done', job_id: active.job_id },
    '/done finalize stub',
  )
  // /save itself is step 6 — message is verbatim §13.6.
  await ctx.reply(STRINGS.finalized)
}
