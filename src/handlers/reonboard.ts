import type { BotContext } from '../bot.js'
import { getOnboardingState } from '../state.js'
import { STRINGS } from '../strings.js'

// /reonboard — heavier reset than /reupload. Full wipe (base resume + CLAUDE.md
// + context.md + archive active jobs). Always confirms; not valid in 'fresh' state.
export const reonboardHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const state = getOnboardingState(chatId)
  if (state === 'fresh') {
    await ctx.reply(STRINGS.onboarding)
    return
  }

  await ctx.reply(
    '<b>Full reset</b> will:\n' +
      '• clear your base resume\n' +
      '• clear your <code>context.md</code> (off-resume facts)\n' +
      '• clear your <code>CLAUDE.md</code> (regenerated automatically next job)\n' +
      '• archive any active job\n\n' +
      'Old jobs stay on disk for history. Continue?',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Yes, fresh start', callback_data: 'reonboard:confirm' },
            { text: '❌ Cancel', callback_data: 'reonboard:cancel' },
          ],
        ],
      },
    },
  )
}
