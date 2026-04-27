// /restart — admin-only. Two-step flow: confirmation prompt with active-
// job count, then on confirm writes ~/bot/.restart-reason and exits via
// SIGINT (graceful path — closes port 8787 cleanly, marks any
// `status='generating'` jobs as 'interrupted' so the boot path can DM
// affected users). After respawn, the bot's announceRestartAfterRespawn
// helper consumes the reason file and DMs admins (ADR-029).

import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { isAdmin } from '../access.js'
import { RESTART_REASON_FILE } from '../heartbeat.js'
import { db } from '../db.js'

const _generatingCount = db.prepare<[], { n: number }>(
  `SELECT COUNT(*) AS n FROM jobs WHERE status = 'generating'`,
)

// /restart → confirmation prompt with [✅ Yes] / [❌ Cancel] inline keyboard.
export const restartHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

  const inFlight = _generatingCount.get()?.n ?? 0
  let msg = '♻️ <b>Restart the bot?</b>'
  if (inFlight > 0) {
    const noun = inFlight === 1 ? 'job is' : 'jobs are'
    msg +=
      `\n\n⚠️ <b>${inFlight} ${noun} currently generating</b> — they will be interrupted. ` +
      `Affected users will get a DM after the bot is back online.`
  }

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Yes, restart', callback_data: 'restart:confirm' },
          { text: '❌ Cancel', callback_data: 'restart:cancel' },
        ],
      ],
    },
  })
}

// restart:confirm | restart:cancel callback. confirm fires the actual
// restart; cancel just edits the message and bails.
export const restartCallback = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) {
    await ctx.answerCallbackQuery({ text: 'admin only' }).catch(() => undefined)
    return
  }

  const data = ctx.callbackQuery?.data ?? ''
  const action = data.split(':')[1]

  if (action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'canceled' }).catch(() => undefined)
    try {
      await ctx.editMessageText('❌ Restart canceled.')
    } catch {
      /* ignore */
    }
    return
  }

  if (action === 'confirm') {
    const who = ctx.from?.username
      ? `@${ctx.from.username}`
      : `chat ${ctx.from?.id ?? 'unknown'}`
    const reason = `Telegram /restart by ${who}`

    try {
      await fs.writeFile(RESTART_REASON_FILE, reason)
    } catch (err) {
      ctx.logger.warn(
        { err: String(err), file: RESTART_REASON_FILE },
        'failed to write restart-reason file',
      )
    }

    ctx.logger.warn(
      { event: 'telegram_restart_requested', source: who },
      'restart triggered via Telegram /restart',
    )

    await ctx.answerCallbackQuery({ text: '♻️ Restarting…' }).catch(() => undefined)
    try {
      await ctx.editMessageText(
        '♻️ Restarting now. Back online in ~10-15s — you\'ll get a DM.',
      )
    } catch {
      /* ignore */
    }

    // Brief delay so the message edit has time to flush, then trigger the
    // graceful shutdown path (releases port 8787 cleanly, marks generating
    // jobs as interrupted, runs announceRestartAfterRespawn on next boot).
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 500).unref?.()
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' }).catch(() => undefined)
}
