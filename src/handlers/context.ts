import path from 'node:path'
import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import { userDir, ensureUserDir } from '../workspace.js'

const PREVIEW_LIMIT = 3500

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// /context           → show current content
// /context <text>    → set content (single message, multi-line OK)
export const contextHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  ensureUserDir(chatId)
  const filePath = path.join(userDir(chatId), 'context.md')

  // ctx.match is everything after the command (grammY's command middleware).
  const raw = (ctx.match as string | undefined) ?? ''
  const arg = raw.trim()

  if (arg === '') {
    let body = ''
    try {
      body = await fs.readFile(filePath, 'utf8')
    } catch {
      await ctx.reply(
        'No context set yet.\n\n' +
          'Send `/context <text>` (multi-line OK) to add off-resume facts ' +
          'the bot can use when tailoring — side projects, infra you self-host, ' +
          'specific outcomes not in your resume, etc. ' +
          'Hard rule: only truthful facts. They become a second source-of-truth.',
        { parse_mode: 'Markdown' },
      )
      return
    }
    const truncated =
      body.length > PREVIEW_LIMIT ? body.slice(0, PREVIEW_LIMIT) + '\n…(truncated)' : body
    await ctx.reply(
      `Current context (${body.length} chars):\n\n<pre>${escapeHtml(truncated)}</pre>`,
      { parse_mode: 'HTML' },
    )
    return
  }

  await fs.writeFile(filePath, arg + '\n', { mode: 0o600 })
  ctx.logger.info(
    { event: 'context_set', bytes: arg.length },
    'context.md updated',
  )
  await ctx.reply(
    `Context updated (${arg.length} chars). It will be picked up on your next tailoring or edit.`,
  )
}
