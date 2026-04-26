import fs from 'node:fs'
import path from 'node:path'
import type { BotContext } from './bot.js'
import { config } from './config.js'

// One workspace per chat: ${WORKSPACE_ROOT}/<chat_id>/
// WORKSPACE_ROOT already includes the `users/` segment per §13.8.
export const userDir = (chat_id: number): string =>
  path.join(config.WORKSPACE_ROOT, String(chat_id))

export const ensureUserDir = (chat_id: number): string => {
  const dir = userDir(chat_id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// grammY's File.download() requires the @grammyjs/files plugin; fetch directly
// from the Telegram file CDN instead.
export const downloadTelegramFile = async (
  ctx: BotContext,
  destPath: string,
): Promise<void> => {
  const file = await ctx.getFile()
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path')
  }
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `Telegram file fetch ${res.status}: ${(await res.text()).slice(0, 200)}`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(destPath, buf, { mode: 0o600 })
}

// Wipes any base_resume.* in the user's dir. Used by /reupload.
export const clearStagedUpload = (chat_id: number): void => {
  const dir = userDir(chat_id)
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (/^base_resume\./i.test(f)) {
      fs.unlinkSync(path.join(dir, f))
    }
  }
}
