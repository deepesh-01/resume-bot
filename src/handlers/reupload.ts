import type { BotContext } from '../bot.js'
import { clearStagedUpload } from '../workspace.js'
import { getOnboardingState } from '../state.js'
import { STRINGS } from '../strings.js'

// /reupload behavior depends on state:
//   awaiting_confirm → clear staged file, prompt for new upload (no confirm)
//   onboarded        → confirm prompt, then clear base_resume + onboarded=0
//   fresh            → just send onboarding prompt
export const reuploadHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const state = getOnboardingState(chatId)

  if (state === 'awaiting_confirm') {
    clearStagedUpload(chatId)
    ctx.logger.info({ event: 'reuploaded_awaiting' }, 'staged upload cleared')
    await ctx.reply(STRINGS.onboarding)
    return
  }

  if (state === 'onboarded') {
    await ctx.reply(
      'This will clear your current base resume so you can upload a new one.\n\n' +
        'Your <code>context.md</code>, jobs history, and active jobs are kept.\n\n' +
        'Continue?',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Yes, replace resume',
                callback_data: 'reupload:confirm',
              },
              { text: '❌ Cancel', callback_data: 'reupload:cancel' },
            ],
          ],
        },
      },
    )
    return
  }

  // fresh — no resume yet
  await ctx.reply(STRINGS.onboarding)
}
