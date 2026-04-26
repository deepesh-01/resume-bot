// /restart — admin-only. Writes ~/bot/.restart-reason with attribution and
// exits the process. The launchd watchdog respawns within ~2 min and DMs
// admins with the recorded reason.

import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { isAdmin } from '../access.js'
import { RESTART_REASON_FILE } from '../heartbeat.js'

export const restartHandler = async (ctx: BotContext): Promise<void> => {
  if (!isAdmin(ctx.from?.id ?? -1)) return

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

  await ctx.reply(
    '♻️ Restarting now. The watchdog will respawn me within ~2 min.',
  )

  // Brief delay so the reply has time to flush, then trigger the same
  // graceful shutdown path as SIGINT (releases port 8787 cleanly).
  setTimeout(() => process.kill(process.pid, 'SIGINT'), 500).unref?.()
}
