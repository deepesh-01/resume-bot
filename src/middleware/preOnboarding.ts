import type { NextFunction } from 'grammy'
import type { BotContext } from '../bot.js'
import { getOnboardingState } from '../state.js'
import { STRINGS } from '../strings.js'

const ONBOARDING_COMMANDS = new Set([
  'start',
  'help',
  'confirm',
  'reupload',
  'reonboard',
  'context',
])

// §13.9 edge case: "Non-file message before onboarded=1 → resend onboarding prompt."
// Runs after allowlist, before handlers. Lets onboarding commands and document
// uploads through; everything else from a non-onboarded user gets the prompt.
export const preOnboarding = async (
  ctx: BotContext,
  next: NextFunction,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) {
    await next()
    return
  }

  const state = getOnboardingState(chatId)
  if (state === 'onboarded') {
    await next()
    return
  }

  if (ctx.message?.document) {
    await next()
    return
  }

  const text = ctx.message?.text
  if (text?.startsWith('/')) {
    const cmd = text.slice(1).split(/\s+/)[0]?.toLowerCase()
    if (cmd && ONBOARDING_COMMANDS.has(cmd)) {
      await next()
      return
    }
  }

  ctx.logger.info(
    { event: 'pre_onboarding_fallback', state },
    'reprompting onboarding',
  )
  await ctx.reply(STRINGS.onboarding)
}
