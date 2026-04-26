import type { BotContext } from '../bot.js'
import { accessCallback } from './accessApproval.js'
import { disambiguateCallback } from './disambiguate.js'
import { reuploadCallback, reonboardCallback } from './resetActions.js'
import { resetJobCallback } from './resetJob.js'

// Single dispatcher so we don't have two `bot.on('callback_query:data', ...)`
// handlers fighting over which calls next().
export const callbackRouter = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data) return

  if (data.startsWith('access:')) {
    await accessCallback(ctx)
    return
  }
  if (data.startsWith('pend:')) {
    await disambiguateCallback(ctx)
    return
  }
  if (data.startsWith('reupload:')) {
    await reuploadCallback(ctx)
    return
  }
  if (data.startsWith('reonboard:')) {
    await reonboardCallback(ctx)
    return
  }
  if (data.startsWith('reset_job:')) {
    await resetJobCallback(ctx)
    return
  }

  // Unknown callback — acknowledge so the spinner stops.
  await ctx.answerCallbackQuery({ text: 'Unknown action' }).catch(() => undefined)
}
