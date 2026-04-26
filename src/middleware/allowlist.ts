import type { NextFunction } from 'grammy'
import type { BotContext } from '../bot.js'
import { isAllowed, isBlocked } from '../db.js'
import { initiateAccessRequest } from '../handlers/accessRequest.js'

const isStartCommand = (text: string | undefined): boolean =>
  text === '/start' || (text?.startsWith('/start ') ?? false) || (text?.startsWith('/start@') ?? false)

export const allowlist = async (
  ctx: BotContext,
  next: NextFunction,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) {
    await next()
    return
  }

  // Block check wins over everything else: blocked users can't even request.
  if (isBlocked(chatId)) {
    ctx.logger.info(
      {
        event: 'blocked_message',
        chat_id: chatId,
        username: ctx.from?.username,
      },
      'message from blocked user',
    )
    try {
      await ctx.reply(
        '🚫 You are blocked from this bot. Reach out to the admin if you think this is a mistake.',
      )
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to send block notice')
    }
    return
  }

  if (isAllowed(chatId)) {
    await next()
    return
  }

  // Non-allowlisted user. Two paths:
  //   /start → kick off access request flow (DMs admin, generates code)
  //   anything else → polite rejection
  const text = ctx.message?.text
  if (isStartCommand(text)) {
    ctx.logger.info(
      { event: 'access_request_received', username: ctx.from?.username },
      'non-allowlisted /start; opening request',
    )
    await initiateAccessRequest(ctx)
    return
  }

  ctx.logger.info(
    {
      event: 'rejected',
      chat_id: chatId,
      username: ctx.from?.username,
    },
    'rejected non-allowlisted message',
  )
  try {
    await ctx.reply(
      'This bot is private. Send /start to request access.',
    )
  } catch (err) {
    ctx.logger.warn({ err }, 'failed to send rejection')
  }
}
