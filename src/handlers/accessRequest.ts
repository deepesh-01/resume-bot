import type { BotContext } from '../bot.js'
import { bot } from '../bot.js'
import {
  generateCode,
  isAdmin,
  notifyAdmins,
  type AdminNotification,
} from '../access.js'
import {
  getPendingByChatId,
  upsertPendingAccess,
} from '../db.js'

const PENDING_TTL_HOURS = 24

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const fmtPendingNotification = (params: {
  username: string | null
  display_name: string | null
  chat_id: number
  code: string
}): string => {
  const handle = params.username
    ? `@${escapeHtml(params.username)}`
    : escapeHtml(params.display_name ?? 'unknown')
  return (
    `🔔 <b>New access request</b>\n\n` +
    `From: ${handle}\n` +
    `Chat ID: <code>${params.chat_id}</code>\n` +
    `Display: ${escapeHtml(params.display_name ?? '—')}\n` +
    `Code: <code>${params.code}</code> (24h)\n`
  )
}

const buildKeyboard = (code: string) => ({
  inline_keyboard: [
    [
      { text: '✅ Approve · 7 days', callback_data: `access:approve:${code}` },
      { text: '❌ Reject', callback_data: `access:reject:${code}` },
    ],
  ],
})

export const initiateAccessRequest = async (
  ctx: BotContext,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  // Don't bother if the requester IS already an admin (shouldn't happen since
  // admins are seeded into allowed_users at boot, but defensive).
  if (isAdmin(chatId)) {
    await ctx.reply('You are an admin and already authorized.')
    return
  }

  const username = ctx.from?.username ?? null
  const display_name =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
    null

  // Re-use existing pending if it still has time on the clock.
  const existing = getPendingByChatId(chatId)
  if (existing) {
    ctx.logger.info(
      { event: 'access_pending_repeat', code: existing.code },
      'friend re-pinged while pending',
    )
    await ctx.reply(
      `🔐 Your access request is still pending (code <code>${escapeHtml(existing.code)}</code>). Sit tight — I'll DM you when admin reviews it.`,
      { parse_mode: 'HTML' },
    )
    return
  }

  const code = generateCode()
  const expiresAt = new Date(
    Date.now() + PENDING_TTL_HOURS * 3600 * 1000,
  ).toISOString().slice(0, 19).replace('T', ' ')

  // Notify all admins (collecting message_ids so the approver can later edit
  // the others to keep their UI consistent).
  const notifications: AdminNotification[] = await notifyAdmins(
    bot,
    fmtPendingNotification({ username, display_name, chat_id: chatId, code }),
    buildKeyboard(code),
  )

  upsertPendingAccess({
    code,
    chat_id: chatId,
    username,
    display_name,
    expires_at: expiresAt,
    notify_msg_ids: JSON.stringify(notifications),
  })

  ctx.logger.info(
    {
      event: 'access_requested',
      code,
      requesting_chat_id: chatId,
      notified_admins: notifications.length,
    },
    'access request created',
  )

  await ctx.reply(
    `🔐 Access request sent to admin. You'll be notified when approved.\n\n` +
      `Your reference code: <code>${escapeHtml(code)}</code>`,
    { parse_mode: 'HTML' },
  )
}
