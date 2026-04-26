import path from 'node:path'
import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { userDir } from '../workspace.js'
import { setOnboarded } from '../db.js'
import { getOnboardingState } from '../state.js'
import { CLAUDEMD_TEMPLATE } from '../templates/claudemd.js'
import { STRINGS } from '../strings.js'

export const confirmHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const state = getOnboardingState(chatId)
  if (state !== 'awaiting_confirm') {
    ctx.logger.info(
      { event: 'confirm_skipped', state },
      '/confirm in non-awaiting state',
    )
    return
  }

  const dir = userDir(chatId)
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), CLAUDEMD_TEMPLATE, {
    mode: 0o600,
  })
  setOnboarded({ chat_id: chatId, onboarded: 1 })

  ctx.logger.info({ event: 'onboarded', chat_id: chatId }, 'onboarded')
  await ctx.reply(STRINGS.saved)
}
