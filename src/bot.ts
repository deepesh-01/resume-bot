import { Bot, type Context } from 'grammy'
import type { Logger } from 'pino'
import { config } from './config.js'
import { logger } from './logger.js'

export type BotContext = Context & { logger: Logger }

// 60s timeout on every Telegram API call. Without this, sendDocument /
// sendMessage can hang forever if Telegram swallows the response — which
// happened on linkedin_4 (PDF rendered, ctx.replyWithDocument never returned,
// bot stuck for ~7 min until manual restart).
export const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN, {
  client: {
    timeoutSeconds: 60,
  },
})

// Attach a chat-scoped logger to every update so handlers can log without
// re-deriving bindings.
bot.use(async (ctx, next) => {
  ctx.logger = logger.child({ chat_id: ctx.chat?.id })
  await next()
})

bot.catch((err) => {
  logger.error(
    {
      err: err.error,
      update_id: err.ctx.update.update_id,
      chat_id: err.ctx.chat?.id,
    },
    'bot error',
  )
})
