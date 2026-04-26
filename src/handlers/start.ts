import type { BotContext } from '../bot.js'
import { upsertUser } from '../db.js'
import { STRINGS } from '../strings.js'

export const startHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const displayName = ctx.from?.username ?? ctx.from?.first_name ?? null
  upsertUser({ chat_id: chatId, display_name: displayName })

  ctx.logger.info(
    { event: 'start', chat_id: chatId, display_name: displayName },
    '/start',
  )

  await ctx.reply(STRINGS.onboarding)
}
