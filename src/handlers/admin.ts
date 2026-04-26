import type { BotContext } from '../bot.js'
import { bot } from '../bot.js'
import { isAdmin } from '../access.js'
import {
  listPending,
  listAllowedUsers,
  listBlockedUsers,
  getAllowedUser,
  removeAllowedUser,
  addBlockedUser,
  removeBlockedUser,
  isBlocked,
  archiveActiveJobsForChat,
} from '../db.js'
import { approveAccess, rejectAccess } from './accessApproval.js'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// /pending — list all pending access requests still within their 24h window.
export const pendingHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const rows = listPending()
  if (rows.length === 0) {
    await ctx.reply('No pending access requests.')
    return
  }

  const lines = ['<b>Pending access requests</b>']
  for (const r of rows) {
    const handle = r.username
      ? `@${escapeHtml(r.username)}`
      : escapeHtml(r.display_name ?? 'unknown')
    lines.push(
      `• <code>${escapeHtml(r.code)}</code> — ${handle} (chat <code>${r.chat_id}</code>) · expires ${escapeHtml(r.expires_at)} UTC`,
    )
  }
  lines.push(
    '\nReply <code>/allow CODE</code> to approve or <code>/deny CODE</code> to reject.',
  )
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

const extractCode = (ctx: BotContext): string | null => {
  const m = ((ctx.match as string | undefined) ?? '').trim()
  return m === '' ? null : m
}

// /allow CODE — manual approval fallback (button is the primary path).
export const allowHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const code = extractCode(ctx)
  if (!code) {
    await ctx.reply('Usage: <code>/allow CODE</code>', { parse_mode: 'HTML' })
    return
  }
  const r = await approveAccess(ctx, code)
  await ctx.reply(r.ok ? `✅ Approved ${code}` : `❌ ${r.reason}`)
}

// /deny CODE — manual reject fallback.
export const denyHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const code = extractCode(ctx)
  if (!code) {
    await ctx.reply('Usage: <code>/deny CODE</code>', { parse_mode: 'HTML' })
    return
  }
  const r = await rejectAccess(ctx, code)
  await ctx.reply(r.ok ? `❌ Rejected ${code}` : `❌ ${r.reason}`)
}

// ----- Allowed/blocked listing & management -----

const extractChatId = (ctx: BotContext): number | null => {
  const m = ((ctx.match as string | undefined) ?? '').trim()
  if (!m) return null
  const id = Number(m)
  return Number.isFinite(id) ? id : null
}

// /users — show allowed + blocked.
export const usersHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const allowed = listAllowedUsers()
  const blocked = listBlockedUsers()

  const lines: string[] = []
  lines.push(`<b>Allowed users (${allowed.length})</b>`)
  if (allowed.length === 0) lines.push('(none)')
  for (const u of allowed) {
    const name = escapeHtml(u.display_name ?? '—')
    const expiry = u.expires_at
      ? `expires ${escapeHtml(u.expires_at)} UTC`
      : '<i>permanent</i>'
    lines.push(`• <code>${u.chat_id}</code> — ${name} · ${expiry}`)
  }

  lines.push('')
  lines.push(`<b>Blocked users (${blocked.length})</b>`)
  if (blocked.length === 0) lines.push('(none)')
  for (const u of blocked) {
    const name = escapeHtml(u.display_name ?? '—')
    const reason = u.reason ? ` · "${escapeHtml(u.reason)}"` : ''
    lines.push(`• <code>${u.chat_id}</code> — ${name}${reason}`)
  }

  lines.push('')
  lines.push(
    'Manage: <code>/revoke ID</code> · <code>/block ID</code> · <code>/unblock ID</code>',
  )

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

// /revoke <chat_id> — soft remove from allowed_users + archive their active jobs.
export const revokeHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const chatId = extractChatId(ctx)
  if (chatId === null) {
    await ctx.reply('Usage: <code>/revoke CHAT_ID</code>', {
      parse_mode: 'HTML',
    })
    return
  }
  if (isAdmin(chatId)) {
    await ctx.reply(`<code>${chatId}</code> is an admin — refusing.`, {
      parse_mode: 'HTML',
    })
    return
  }

  const existing = getAllowedUser(chatId)
  if (!existing) {
    await ctx.reply(`<code>${chatId}</code> is not in allowed_users.`, {
      parse_mode: 'HTML',
    })
    return
  }

  removeAllowedUser(chatId)
  const archived = archiveActiveJobsForChat(chatId)

  ctx.logger.info(
    {
      event: 'revoked',
      target: chatId,
      jobs_archived: archived,
      by: ctx.from?.id,
    },
    'access revoked',
  )

  // Polite DM to the friend.
  try {
    await bot.api.sendMessage(
      chatId,
      'Your access to this bot has been revoked. Send /start if you need to request again.',
    )
  } catch (err) {
    ctx.logger.warn(
      { err: String(err), target: chatId },
      'failed to DM revoked user',
    )
  }

  await ctx.reply(
    `Revoked <code>${chatId}</code>${archived > 0 ? ` (${archived} job${archived === 1 ? '' : 's'} archived)` : ''}.`,
    { parse_mode: 'HTML' },
  )
}

// /block <chat_id> [reason...] — revoke + add to blocked_users + DM.
export const blockHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const raw = ((ctx.match as string | undefined) ?? '').trim()
  if (!raw) {
    await ctx.reply('Usage: <code>/block CHAT_ID [reason...]</code>', {
      parse_mode: 'HTML',
    })
    return
  }
  const [first, ...rest] = raw.split(/\s+/)
  const chatId = Number(first)
  if (!Number.isFinite(chatId)) {
    await ctx.reply('First argument must be a numeric CHAT_ID.', {
      parse_mode: 'HTML',
    })
    return
  }
  if (isAdmin(chatId)) {
    await ctx.reply(`<code>${chatId}</code> is an admin — refusing.`, {
      parse_mode: 'HTML',
    })
    return
  }
  const reason = rest.length > 0 ? rest.join(' ') : null

  const existing = getAllowedUser(chatId)
  removeAllowedUser(chatId)
  const archived = archiveActiveJobsForChat(chatId)
  addBlockedUser({
    chat_id: chatId,
    display_name: existing?.display_name ?? null,
    blocked_by: ctx.from?.id ?? null,
    reason,
  })

  ctx.logger.info(
    {
      event: 'blocked',
      target: chatId,
      jobs_archived: archived,
      by: ctx.from?.id,
      reason,
    },
    'user blocked',
  )

  try {
    await bot.api.sendMessage(
      chatId,
      '🚫 You have been blocked from this bot.',
    )
  } catch (err) {
    ctx.logger.warn(
      { err: String(err), target: chatId },
      'failed to DM blocked user',
    )
  }

  await ctx.reply(
    `🚫 Blocked <code>${chatId}</code>${archived > 0 ? ` (${archived} job${archived === 1 ? '' : 's'} archived)` : ''}${reason ? ` — reason: <i>${escapeHtml(reason)}</i>` : ''}.`,
    { parse_mode: 'HTML' },
  )
}

// /unblock <chat_id> — remove from blocked_users (does NOT re-grant access).
export const unblockHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const chatId = extractChatId(ctx)
  if (chatId === null) {
    await ctx.reply('Usage: <code>/unblock CHAT_ID</code>', {
      parse_mode: 'HTML',
    })
    return
  }
  if (!isBlocked(chatId)) {
    await ctx.reply(`<code>${chatId}</code> is not blocked.`, {
      parse_mode: 'HTML',
    })
    return
  }
  removeBlockedUser(chatId)

  ctx.logger.info(
    { event: 'unblocked', target: chatId, by: ctx.from?.id },
    'user unblocked',
  )

  try {
    await bot.api.sendMessage(
      chatId,
      'Your block has been lifted. Send /start to request access.',
    )
  } catch {
    /* ignore */
  }

  await ctx.reply(
    `Unblocked <code>${chatId}</code>. They still need to /start and be approved.`,
    { parse_mode: 'HTML' },
  )
}
