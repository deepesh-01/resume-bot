// Callback handlers for /reupload and /reonboard confirmation buttons.

import path from 'node:path'
import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { clearStagedUpload, userDir } from '../workspace.js'
import { db, setOnboarded } from '../db.js'
import { STRINGS } from '../strings.js'

export const reuploadCallback = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data?.startsWith('reupload:')) return
  const action = data.split(':')[1]
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  if (action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' })
    try {
      await ctx.editMessageText('❌ Cancelled — base resume unchanged.')
    } catch {
      /* ignore */
    }
    return
  }

  if (action === 'confirm') {
    clearStagedUpload(chatId)
    setOnboarded({ chat_id: chatId, onboarded: 0 })
    ctx.logger.info(
      { event: 'reupload_confirmed' },
      'base resume cleared via /reupload',
    )
    await ctx.answerCallbackQuery({ text: 'Resume cleared' })
    try {
      await ctx.editMessageText('✅ Base resume cleared.')
    } catch {
      /* ignore */
    }
    await ctx.reply(STRINGS.onboarding)
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' })
}

export const reonboardCallback = async (ctx: BotContext): Promise<void> => {
  const data = ctx.callbackQuery?.data
  if (!data?.startsWith('reonboard:')) return
  const action = data.split(':')[1]
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  if (action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' })
    try {
      await ctx.editMessageText('❌ Cancelled — nothing changed.')
    } catch {
      /* ignore */
    }
    return
  }

  if (action === 'confirm') {
    const dir = userDir(chatId)

    // Wipe staged upload + key files. Old job dirs stay on disk (history).
    clearStagedUpload(chatId)
    for (const f of ['CLAUDE.md', 'context.md']) {
      await fs.rm(path.join(dir, f), { force: true })
    }

    // Archive any active jobs.
    const archived = db
      .prepare(
        `UPDATE jobs SET status='archived', last_active_at=datetime('now')
         WHERE chat_id = ? AND status = 'ready'`,
      )
      .run(chatId)

    setOnboarded({ chat_id: chatId, onboarded: 0 })

    ctx.logger.info(
      {
        event: 'reonboarded',
        archived_jobs: archived.changes,
      },
      'full reset via /reonboard',
    )

    await ctx.answerCallbackQuery({ text: 'Reset complete' })
    try {
      await ctx.editMessageText(
        `✅ Full reset done${archived.changes > 0 ? ` (${archived.changes} job${archived.changes === 1 ? '' : 's'} archived)` : ''}.`,
      )
    } catch {
      /* ignore */
    }
    await ctx.reply(STRINGS.onboarding)
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action' })
}
