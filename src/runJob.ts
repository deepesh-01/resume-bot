import path from 'node:path'
import fs from 'node:fs/promises'
import { InputFile } from 'grammy'
import type { BotContext } from './bot.js'
import { withUserLock } from './mutex.js'
import { scrape, ScrapeError } from './scrape.js'
import { makeJobId, createJobWorkspace } from './jobs.js'
import {
  runTailoring,
  runCritic,
  runRefinement,
  ClaudeError,
} from './claude.js'
import { renderResumePdf, RenderError } from './render.js'
import { buildPdfFilename, getCandidateName } from './pdfName.js'
import { checkAndAlertIfOver80 } from './budget.js'
import { bot } from './bot.js'
import {
  createJob,
  setJobStatus,
  setJobSession,
  touchJob,
  logUsage,
  setQualityScore,
} from './db.js'
import { config } from './config.js'
import { STRINGS } from './strings.js'

export type JobInput = { url: string } | { text: string }

const MIN_PASTED_JD_CHARS = 200

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const slugFromUrl = (url: string): string => {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const first = host.split('.')[0] ?? 'job'
    return first
  } catch {
    return 'job'
  }
}

const mapErrorToString = (err: unknown): string => {
  if (err instanceof ScrapeError) {
    if (err.code === 'SCRAPE_AUTH_WALL') return STRINGS.scrapeAuthWall
    if (err.code === 'JD_TOO_SHORT') return STRINGS.jdTooShort
    return STRINGS.scrapeFailed
  }
  if (err instanceof ClaudeError) {
    if (err.code === 'CLAUDE_TIMEOUT') return STRINGS.claudeTimeout
    if (err.code === 'CLAUDE_AUTH') return STRINGS.claudeAuth
    if (err.code === 'CLAUDE_RATE_LIMIT') return STRINGS.claudeRateLimit()
    return STRINGS.claudeFailed
  }
  if (err instanceof RenderError) return STRINGS.renderFailedFinal
  return STRINGS.claudeFailed
}

const isOwnerNotify = (err: unknown): boolean =>
  err instanceof ClaudeError && err.code === 'CLAUDE_AUTH'

export const runJob = async (
  ctx: BotContext,
  input: JobInput,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  await withUserLock(chatId, async () => {
    let jobId: string | undefined
    try {
      await ctx.reply(STRINGS.readingJob)

      let jdText: string
      let role: string | undefined
      let company: string | undefined
      let jdUrl: string | undefined
      let slug: string

      if ('url' in input) {
        jdUrl = input.url
        const result = await scrape(input.url)
        jdText = result.jdText
        role = result.role
        company = result.company
        slug = slugFromUrl(input.url)
      } else {
        if (input.text.length < MIN_PASTED_JD_CHARS) {
          throw new ScrapeError(
            'JD_TOO_SHORT',
            `pasted text ${input.text.length} chars`,
          )
        }
        jdText = input.text
        slug = 'manual'
      }

      const statusMsg =
        role && company ? STRINGS.gotIt(role, company) : STRINGS.gotItUnknown
      await ctx.reply(statusMsg)

      jobId = makeJobId(slug)
      const { jobDir, resumePath } = await createJobWorkspace(
        chatId,
        jobId,
        jdText,
        jdUrl,
      )

      createJob({
        job_id: jobId,
        chat_id: chatId,
        workspace_path: jobDir,
        jd_url: jdUrl ?? null,
        company: company ?? null,
        role: role ?? null,
        status: 'generating',
      })

      ctx.logger.info(
        { event: 'job_created', job_id: jobId, jd_url: jdUrl, role, company },
        'job created',
      )

      const claudeResult = await runTailoring(jobDir)

      logUsage({
        job_id: jobId,
        chat_id: chatId,
        invocation_type: 'A',
        duration_ms: claudeResult.durationMs,
        total_cost_usd: claudeResult.totalCostUsd,
      })

      if (claudeResult.isError) {
        setJobStatus(jobId, 'failed')
        throw new ClaudeError(
          'CLAUDE_FAILED',
          `subtype=${claudeResult.subtype}: ${claudeResult.result.slice(0, 200)}`,
        )
      }

      setJobSession(jobId, claudeResult.sessionId)
      setJobStatus(jobId, 'ready')
      touchJob(jobId)

      // ---------- Critic + auto-refinement (lever A) ----------
      // Both calls degrade gracefully: any failure logs and falls through to
      // the v1 output. Bot never gets stuck on a critic glitch.
      let scoreNote: string | undefined
      let criticDetail: import('./claude.js').CriticResult | undefined
      let refinementApplied = false

      try {
        const critic = await runCritic(jobDir)
        criticDetail = critic
        setQualityScore(jobId, critic.score)
        logUsage({
          job_id: jobId,
          chat_id: chatId,
          invocation_type: 'D',
          duration_ms: critic.durationMs,
          total_cost_usd: critic.totalCostUsd,
        })
        ctx.logger.info(
          {
            event: 'critic_done',
            job_id: jobId,
            score: critic.score,
            gaps: critic.gaps.length,
            violations: critic.violations.length,
          },
          'critic complete',
        )

        const needsRefine =
          (critic.score < config.QUALITY_THRESHOLD ||
            critic.violations.length > 0) &&
          (critic.gaps.length > 0 || critic.violations.length > 0)

        if (needsRefine) {
          try {
            const refined = await runRefinement(
              jobDir,
              claudeResult.sessionId,
              critic.gaps,
              critic.violations,
            )
            logUsage({
              job_id: jobId,
              chat_id: chatId,
              invocation_type: 'E',
              duration_ms: refined.durationMs,
              total_cost_usd: refined.totalCostUsd,
            })
            if (refined.sessionId && refined.sessionId !== claudeResult.sessionId) {
              setJobSession(jobId, refined.sessionId)
            }
            refinementApplied = true
            ctx.logger.info(
              {
                event: 'refine_done',
                job_id: jobId,
                cost_usd: refined.totalCostUsd,
                duration_ms: refined.durationMs,
              },
              'refinement complete',
            )
            scoreNote = `🎯 Quality: ${critic.score}/100 (refined)`
          } catch (err) {
            ctx.logger.warn(
              { err: String(err), job_id: jobId },
              'refinement failed; keeping v1 output',
            )
            scoreNote = `🎯 Quality: ${critic.score}/100`
          }
        } else {
          scoreNote = `🎯 Quality: ${critic.score}/100`
        }
      } catch (err) {
        ctx.logger.warn(
          { err: String(err), job_id: jobId },
          'critic failed; skipping quality gate',
        )
      }

      let summary = '(no change summary)'
      try {
        const txt = await fs.readFile(
          path.join(jobDir, 'last_change.txt'),
          'utf8',
        )
        summary = txt.trim() || summary
      } catch {
        /* ignore */
      }

      ctx.logger.info(
        {
          event: 'job_done',
          job_id: jobId,
          cost_usd: claudeResult.totalCostUsd,
          duration_ms: claudeResult.durationMs,
        },
        'job complete',
      )

      // §13.5 render: pandoc → typst → PDF, with tectonic fallback.
      const pdfPath = await renderResumePdf(jobDir)
      ctx.logger.info({ event: 'render_ok', job_id: jobId, pdf: pdfPath }, 'rendered')

      const candidate = await getCandidateName(chatId)
      const downloadName = buildPdfFilename({
        candidate,
        role: role ?? null,
        company: company ?? null,
        jobId,
      })
      await ctx.replyWithDocument(new InputFile(pdfPath, downloadName), {
        caption: STRINGS.v1Ready(summary, scoreNote),
      })

      // Optional: send a follow-up message with critic detail.
      if (criticDetail) {
        const lines: string[] = []
        const headline = refinementApplied
          ? `🔍 <b>Quality detail (${criticDetail.score}/100, refined)</b>`
          : `🔍 <b>Quality detail (${criticDetail.score}/100)</b>`
        lines.push(headline)

        if (criticDetail.attributes.length > 0) {
          lines.push('')
          lines.push('<b>Attributes scored</b>')
          for (const a of criticDetail.attributes) {
            const name = escapeHtml(a.name || '—')
            lines.push(`• ${name}: ${a.score}/10`)
          }
        }

        if (refinementApplied && criticDetail.gaps.length > 0) {
          lines.push('')
          lines.push('<b>Gaps addressed</b>')
          for (const g of criticDetail.gaps) lines.push(`• ${escapeHtml(g)}`)
        }

        if (refinementApplied && criticDetail.violations.length > 0) {
          lines.push('')
          lines.push('<b>Unsupported claims removed</b>')
          for (const v of criticDetail.violations)
            lines.push(`• ${escapeHtml(v)}`)
        }

        // Clip to Telegram's 4096 char limit just in case.
        const text =
          lines.join('\n').length > 3900
            ? lines.join('\n').slice(0, 3900) + '\n…(truncated)'
            : lines.join('\n')

        try {
          await ctx.reply(text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          })
        } catch (err) {
          ctx.logger.warn({ err: String(err) }, 'critic detail send failed')
        }
      }
    } catch (err) {
      ctx.logger.error(
        { err, job_id: jobId, event: 'job_failed' },
        'job failed',
      )
      if (jobId) setJobStatus(jobId, 'failed')

      const userMsg = mapErrorToString(err)
      try {
        await ctx.reply(userMsg)
      } catch (replyErr) {
        ctx.logger.warn({ replyErr }, 'failed to send error reply')
      }

      if (isOwnerNotify(err)) {
        try {
          await ctx.api.sendMessage(
            config.OWNER_CHAT_ID,
            `[notify] ${(err as Error).name} for chat ${chatId}: ${(err as Error).message.slice(0, 300)}`,
          )
        } catch (notifyErr) {
          ctx.logger.warn({ notifyErr }, 'owner notify failed')
        }
      }
    } finally {
      // Best-effort: surface a one-shot DM if rolling-7-day Claude spend
      // crossed the configured 80% threshold. No-op when budget unset.
      void checkAndAlertIfOver80(bot)
    }
  })
}
