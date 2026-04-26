import path from 'node:path'
import fs from 'node:fs/promises'
import { InputFile } from 'grammy'
import type { BotContext } from './bot.js'
import { withUserLock } from './mutex.js'
import { runEdit as runClaudeEdit, ClaudeError } from './claude.js'
import { renderResumePdf, RenderError } from './render.js'
import { buildPdfFilename, getCandidateName } from './pdfName.js'
import {
  getActiveJob,
  setJobSession,
  touchJob,
  logUsage,
} from './db.js'
import { STRINGS } from './strings.js'
import { checkAndAlertIfOver80 } from './budget.js'
import { bot } from './bot.js'

const mapErrorToString = (err: unknown): string => {
  if (err instanceof ClaudeError) {
    if (err.code === 'CLAUDE_TIMEOUT') return STRINGS.claudeTimeout
    if (err.code === 'CLAUDE_AUTH') return STRINGS.claudeAuth
    if (err.code === 'CLAUDE_RATE_LIMIT') return STRINGS.claudeRateLimit()
    return STRINGS.claudeFailed
  }
  if (err instanceof RenderError) return STRINGS.renderFailedFinal
  return STRINGS.claudeFailed
}

export const runEditFlow = async (
  ctx: BotContext,
  instruction: string,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  await withUserLock(chatId, async () => {
    const job = getActiveJob(chatId)
    if (!job || !job.session_id || !job.workspace_path) {
      ctx.logger.info(
        { event: 'edit_no_active_job' },
        'edit fired without active job (race?); ignoring',
      )
      return
    }

    try {
      await ctx.reply(STRINGS.onIt)

      const result = await runClaudeEdit(
        job.workspace_path,
        job.session_id,
        instruction,
      )

      logUsage({
        job_id: job.job_id,
        chat_id: chatId,
        invocation_type: 'B',
        duration_ms: result.durationMs,
        total_cost_usd: result.totalCostUsd,
      })

      if (result.isError) {
        throw new ClaudeError(
          'CLAUDE_FAILED',
          `subtype=${result.subtype}: ${result.result.slice(0, 200)}`,
        )
      }

      // claude --resume can fork to a new session_id (e.g. compact). Track it.
      if (result.sessionId && result.sessionId !== job.session_id) {
        setJobSession(job.job_id, result.sessionId)
      }
      touchJob(job.job_id)

      const pdfPath = await renderResumePdf(job.workspace_path)

      let summary = '(no change summary)'
      try {
        const txt = await fs.readFile(
          path.join(job.workspace_path, 'last_change.txt'),
          'utf8',
        )
        summary = txt.trim() || summary
      } catch {
        /* ignore */
      }

      ctx.logger.info(
        {
          event: 'edit_done',
          job_id: job.job_id,
          cost_usd: result.totalCostUsd,
          duration_ms: result.durationMs,
        },
        'edit complete',
      )

      const candidate = await getCandidateName(chatId)
      const downloadName = buildPdfFilename({
        candidate,
        role: job.role,
        company: job.company,
        jobId: job.job_id,
      })
      await ctx.replyWithDocument(new InputFile(pdfPath, downloadName), {
        caption: STRINGS.editComplete(summary),
      })
    } catch (err) {
      ctx.logger.error(
        { err, job_id: job.job_id, event: 'edit_failed' },
        'edit failed',
      )
      try {
        await ctx.reply(mapErrorToString(err))
      } catch (replyErr) {
        ctx.logger.warn({ replyErr }, 'failed to send edit error reply')
      }
    } finally {
      // Same one-shot weekly-budget check as runJob; budget tracking
      // disabled by default (CLAUDE_WEEKLY_BUDGET_USD=0).
      void checkAndAlertIfOver80(bot)
    }
  })
}
