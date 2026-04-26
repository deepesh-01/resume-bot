import path from 'node:path'
import fs from 'node:fs/promises'
import {
  structuredPatch,
  applyPatch,
  type StructuredPatchHunk,
} from 'diff'
import type { BotContext } from '../bot.js'
import { userDir } from '../workspace.js'
import { getActiveJob } from '../db.js'
import {
  setSavePending,
  getSavePending,
  clearSavePending,
  parseSelection,
} from '../savePending.js'
import {
  findSectionHeader,
  summarizeHunk,
  buildSaveMessage,
} from '../saveDiff.js'

// /save — diff active job's resume.md vs base, present numbered hunks.
export const saveHandler = async (ctx: BotContext): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const active = getActiveJob(chatId)
  if (!active || !active.workspace_path) {
    await ctx.reply(
      'No active job to save from. Send a URL or paste a JD first.',
    )
    return
  }

  const dir = userDir(chatId)
  const basePath = path.join(dir, 'base_resume.md')
  const resumePath = path.join(active.workspace_path, 'resume.md')

  let baseText: string
  let resumeText: string
  try {
    baseText = await fs.readFile(basePath, 'utf8')
    resumeText = await fs.readFile(resumePath, 'utf8')
  } catch (err) {
    ctx.logger.error({ err: String(err) }, '/save failed to read files')
    await ctx.reply('Error reading files for diff.')
    return
  }

  const patch = structuredPatch(
    'base_resume.md',
    'resume.md',
    baseText,
    resumeText,
    '',
    '',
    { context: 3 },
  )

  if (patch.hunks.length === 0) {
    await ctx.reply(
      'No changes to save — your tailored resume is identical to your base.',
    )
    return
  }

  const baseLines = baseText.split('\n')
  const summaries = patch.hunks.map((h: StructuredPatchHunk) => {
    const section = findSectionHeader(baseLines, h.oldStart)
    return summarizeHunk(h, section)
  })

  setSavePending(chatId, {
    hunks: patch.hunks,
    baseText,
    basePath,
    jobId: active.job_id,
  })

  ctx.logger.info(
    {
      event: 'save_diff_presented',
      job_id: active.job_id,
      hunks: patch.hunks.length,
    },
    '/save diff presented',
  )

  await ctx.reply(buildSaveMessage(summaries, active.job_id))
}

// Called from jobMessage when text arrives and savePending exists.
// Returns true if the message was consumed by save selection logic.
export const handleSaveSelection = async (
  ctx: BotContext,
  text: string,
): Promise<boolean> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return false
  const pending = getSavePending(chatId)
  if (!pending) return false

  const sel = parseSelection(text, pending.hunks.length)

  if (sel === 'invalid') {
    await ctx.reply(
      'Reply with numbers separated by spaces (e.g. "1 3"), or "all", or "none".',
    )
    return true // consumed; pending stays
  }

  if (sel === 'none') {
    clearSavePending(chatId)
    ctx.logger.info(
      { event: 'save_cancelled', job_id: pending.jobId },
      '/save cancelled',
    )
    await ctx.reply('Cancelled. Base resume unchanged.')
    return true
  }

  const selected: StructuredPatchHunk[] =
    sel === 'all' ? pending.hunks : sel.map((i) => pending.hunks[i]!)

  const partial = {
    oldFileName: 'base_resume.md',
    newFileName: 'base_resume.md',
    oldHeader: '',
    newHeader: '',
    hunks: selected,
  }

  const result = applyPatch(pending.baseText, partial, { fuzzFactor: 2 })
  if (typeof result !== 'string') {
    ctx.logger.error(
      { event: 'save_apply_failed', job_id: pending.jobId },
      'applyPatch failed',
    )
    clearSavePending(chatId)
    await ctx.reply(
      'Failed to apply patch — context mismatch. Run /save again.',
    )
    return true
  }

  try {
    await fs.writeFile(pending.basePath, result, { mode: 0o600 })
  } catch (err) {
    ctx.logger.error(
      { err: String(err), job_id: pending.jobId },
      'failed to write base_resume.md',
    )
    clearSavePending(chatId)
    await ctx.reply('Failed to write to base resume.')
    return true
  }

  clearSavePending(chatId)
  ctx.logger.info(
    {
      event: 'save_applied',
      job_id: pending.jobId,
      applied: selected.length,
      total: pending.hunks.length,
    },
    'base resume updated',
  )
  await ctx.reply(
    `✅ Base updated. ${selected.length} change${selected.length === 1 ? '' : 's'} applied (of ${pending.hunks.length}).`,
  )
  return true
}
