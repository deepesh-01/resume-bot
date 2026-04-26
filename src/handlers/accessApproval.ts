import type { BotContext } from '../bot.js'
import { bot } from '../bot.js'
import {
  addAllowedUser,
  getPendingByCode,
  removePendingAccess,
  type PendingAccessRow,
} from '../db.js'
import { isAdmin, type AdminNotification } from '../access.js'

const APPROVAL_DAYS = 7

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const friendName = (p: PendingAccessRow): string =>
  p.username ? `@${p.username}` : (p.display_name ?? `chat ${p.chat_id}`)

// Edit every admin's copy of the request notification so the final state is
// consistent across all admins (e.g., if you have two admins and one approves).
const updateAllAdminNotifications = async (
  pending: PendingAccessRow,
  newText: string,
): Promise<void> => {
  if (!pending.notify_msg_ids) return
  let parsed: AdminNotification[]
  try {
    parsed = JSON.parse(pending.notify_msg_ids) as AdminNotification[]
  } catch {
    return
  }
  for (const n of parsed) {
    try {
      await bot.api.editMessageText(n.admin_chat_id, n.message_id, newText, {
        parse_mode: 'HTML',
      })
    } catch {
      /* ignore — message may have been deleted by admin */
    }
  }
}

export const approveAccess = async (
  ctx: BotContext,
  code: string,
): Promise<{ ok: true; pending: PendingAccessRow } | { ok: false; reason: string }> => {
  const requester = ctx.from?.id
  if (requester === undefined || !isAdmin(requester)) {
    return { ok: false, reason: 'Not an admin' }
  }

  const pending = getPendingByCode(code)
  if (!pending) {
    return { ok: false, reason: 'Code is invalid or expired' }
  }

  const expiresAt = new Date(
    Date.now() + APPROVAL_DAYS * 24 * 3600 * 1000,
  ).toISOString().slice(0, 19).replace('T', ' ')

  addAllowedUser({
    chat_id: pending.chat_id,
    display_name: pending.display_name,
    added_by: requester,
    expires_at: expiresAt,
  })
  removePendingAccess(code)

  await updateAllAdminNotifications(
    pending,
    `✅ <b>Approved</b> ${escapeHtml(friendName(pending))} (7 days)\n` +
      `Chat ID: <code>${pending.chat_id}</code>\n` +
      `Code: <code>${escapeHtml(code)}</code>`,
  )

  // DM the friend with the good news.
  try {
    await bot.api.sendMessage(
      pending.chat_id,
      `✅ Welcome! Your access was approved (7-day session).\n\nSend /start to begin onboarding.`,
    )
  } catch (err) {
    ctx.logger.warn(
      { err: String(err), friend_chat_id: pending.chat_id },
      'failed to DM friend after approval',
    )
  }

  ctx.logger.info(
    {
      event: 'access_approved',
      code,
      friend_chat_id: pending.chat_id,
      approved_by: requester,
    },
    'access approved',
  )

  return { ok: true, pending }
}

export const rejectAccess = async (
  ctx: BotContext,
  code: string,
): Promise<{ ok: true; pending: PendingAccessRow } | { ok: false; reason: string }> => {
  const requester = ctx.from?.id
  if (requester === undefined || !isAdmin(requester)) {
    return { ok: false, reason: 'Not an admin' }
  }

  const pending = getPendingByCode(code)
  if (!pending) {
    return { ok: false, reason: 'Code is invalid or expired' }
  }

  removePendingAccess(code)

  await updateAllAdminNotifications(
    pending,
    `❌ <b>Rejected</b> ${escapeHtml(friendName(pending))}\n` +
      `Chat ID: <code>${pending.chat_id}</code>\n` +
      `Code: <code>${escapeHtml(code)}</code>`,
  )

  try {
    await bot.api.sendMessage(
      pending.chat_id,
      `Your access request was declined.`,
    )
  } catch {
    /* ignore */
  }

  ctx.logger.info(
    {
      event: 'access_rejected',
      code,
      friend_chat_id: pending.chat_id,
      rejected_by: requester,
    },
    'access rejected',
  )

  return { ok: true, pending }
}

// Inline-button callback (callback_data: access:approve:CODE | access:reject:CODE).
export const accessCallback = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data?.startsWith('access:')) return
  const parts = data.split(':')
  const action = parts[1]
  const code = parts[2]
  if (!action || !code) return

  if (!isAdmin(ctx.from?.id ?? -1)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' })
    return
  }

  if (action === 'approve') {
    const r = await approveAccess(ctx, code)
    await ctx.answerCallbackQuery({
      text: r.ok ? 'Approved' : r.reason,
    })
  } else if (action === 'reject') {
    const r = await rejectAccess(ctx, code)
    await ctx.answerCallbackQuery({
      text: r.ok ? 'Rejected' : r.reason,
    })
  } else {
    await ctx.answerCallbackQuery({ text: 'Unknown action' })
  }
}
