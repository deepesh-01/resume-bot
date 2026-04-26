import path from 'node:path'
import fs from 'node:fs/promises'
import type { BotContext } from '../bot.js'
import {
  ensureUserDir,
  downloadTelegramFile,
  clearStagedUpload,
} from '../workspace.js'
import {
  convertDocx,
  convertMd,
  convertPdf,
  ConversionError,
} from '../convert.js'
import { setBasePath, upsertUser } from '../db.js'
import { STRINGS } from '../strings.js'

const SUPPORTED_EXTS = ['pdf', 'docx', 'md'] as const
type SupportedExt = (typeof SUPPORTED_EXTS)[number]
const isSupported = (ext: string): ext is SupportedExt =>
  (SUPPORTED_EXTS as readonly string[]).includes(ext)

const PREVIEW_LIMIT = 500

const getExt = (filename: string | undefined): string => {
  if (!filename) return ''
  const m = /\.([a-z0-9]+)$/i.exec(filename)
  return m?.[1]?.toLowerCase() ?? ''
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const documentHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  const doc = ctx.message?.document
  if (chatId === undefined || !doc) return

  const ext = getExt(doc.file_name)
  if (!isSupported(ext)) {
    ctx.logger.info(
      { event: 'upload_unsupported', ext, file_name: doc.file_name },
      'rejected unsupported extension',
    )
    await ctx.reply(STRINGS.unsupportedExt)
    return
  }

  // The document handler can be the user's first interaction (bypassing /start),
  // so make sure the row exists before setBasePath UPDATEs.
  upsertUser({
    chat_id: chatId,
    display_name: ctx.from?.username ?? ctx.from?.first_name ?? null,
  })

  await ctx.reply(STRINGS.readingResume)

  const dir = ensureUserDir(chatId)
  // Wipe any prior upload artifacts (orphans from failed conversions, or a
  // different-extension upload) so the new file is the only base_resume.*.
  clearStagedUpload(chatId)
  const downloadPath = path.join(dir, `base_resume.${ext}`)

  try {
    await downloadTelegramFile(ctx, downloadPath)
    ctx.logger.info(
      { event: 'upload_downloaded', ext, bytes: doc.file_size },
      'downloaded',
    )

    if (ext === 'md') await convertMd(dir)
    else if (ext === 'docx') await convertDocx(dir)
    else await convertPdf(dir)

    setBasePath({
      chat_id: chatId,
      base_path: path.join(dir, 'base_resume.md'),
    })

    const md = await fs.readFile(path.join(dir, 'base_resume.md'), 'utf8')
    const preview = md.slice(0, PREVIEW_LIMIT)
    ctx.logger.info(
      { event: 'upload_converted', ext, bytes: md.length },
      'converted',
    )

    await ctx.reply(
      "Got it. Here's what I extracted (first ~500 chars):\n\n" +
        `<pre>${escapeHtml(preview)}</pre>\n\n` +
        'Reply /confirm if this looks right, or /reupload to try again.',
      { parse_mode: 'HTML' },
    )
  } catch (err) {
    if (err instanceof ConversionError) {
      ctx.logger.error(
        { err, code: err.code, event: 'upload_failed', ext },
        'conversion failed',
      )
    } else {
      ctx.logger.error(
        { err, event: 'upload_failed', ext },
        'upload pipeline failed',
      )
    }
    await ctx.reply(STRINGS.uploadParseFailed)
  }
}
