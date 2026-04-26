import { config } from './config.js'
import { logger } from './logger.js'

// Avoid visually-confusable chars (0/O, 1/I/L) for hand-typed /allow fallback.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6

export const generateCode = (): string => {
  let code = ''
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

export const isAdmin = (chat_id: number): boolean =>
  config.ADMIN_CHAT_IDS.includes(chat_id)

// Send a notification to every admin and return the (chat_id, message_id)
// pairs so we can edit the originals later when one admin acts on the request.
import type { Bot } from 'grammy'
import type { BotContext } from './bot.js'

export interface AdminNotification {
  admin_chat_id: number
  message_id: number
}

export const notifyAdmins = async (
  bot: Bot<BotContext>,
  text: string,
  reply_markup: Parameters<typeof bot.api.sendMessage>[2] extends infer T
    ? T extends { reply_markup?: infer R }
      ? R
      : never
    : never,
): Promise<AdminNotification[]> => {
  const out: AdminNotification[] = []
  for (const adminId of config.ADMIN_CHAT_IDS) {
    try {
      const msg = await bot.api.sendMessage(adminId, text, {
        parse_mode: 'HTML',
        reply_markup,
      })
      out.push({ admin_chat_id: adminId, message_id: msg.message_id })
    } catch (err) {
      logger.warn(
        { err: String(err), admin_chat_id: adminId },
        'failed to notify admin',
      )
    }
  }
  return out
}
