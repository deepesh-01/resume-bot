// Headless CLI entry point for System B (job-intake) integration.
// Mirrors src/runJob.ts's pipeline (tailor → critic → optional refine →
// render PDF) but takes inputs from CLI args instead of a Telegram message
// and writes JSON to stdout instead of replying via grammY.
//
// Usage:
//   node dist/cli-tailor.js \
//     --jd-path /path/to/job_description.md \
//     --chat-id 1089113785 \
//     --output-dir /path/to/copy/pdf/to \
//     --output-format json
//
// Output (stdout, single line):
//   {"ok":true,"pdf_path":"...","last_change":"...","score":87,
//    "refinement_applied":false,"duration_ms":47200}
//
// On error: ok=false, error=<message>; exit code 1.
//
// This file is intentionally NOT imported from src/index.ts so it can run
// without spinning up the Telegram bot. ADR-021 covers the design choice.

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import { makeJobId, createJobWorkspace } from './jobs.js'
import { createJob, setJobSession, setJobStatus } from './db.js'
import {
  runTailoring,
  runCritic,
  runRefinement,
  ClaudeError,
} from './claude.js'
import { renderResumePdf, RenderError } from './render.js'

interface CliArgs {
  jdPath: string
  chatId: number
  outputDir?: string
}

interface CliResult {
  ok: boolean
  pdf_path: string | null
  last_change: string | null
  score: number | null
  refinement_applied: boolean
  error: string | null
  duration_ms: number
}

const usage = (): never => {
  process.stderr.write(
    'usage: node dist/cli-tailor.js --jd-path <path> --chat-id <int> ' +
      '[--output-dir <path>] [--output-format json]\n',
  )
  process.exit(2)
}

const parseArgs = (argv: string[]): CliArgs => {
  let jdPath: string | undefined
  let chatIdStr: string | undefined
  let outputDir: string | undefined
  let format: string = 'json'
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const val = argv[i + 1]
    if (flag === '--jd-path') {
      jdPath = val
      i++
    } else if (flag === '--chat-id') {
      chatIdStr = val
      i++
    } else if (flag === '--output-dir') {
      outputDir = val
      i++
    } else if (flag === '--output-format') {
      format = (val ?? 'json').toLowerCase()
      i++
    } else {
      process.stderr.write(`unknown arg: ${flag}\n`)
      usage()
    }
  }
  if (!jdPath || !chatIdStr) usage()
  if (format !== 'json') {
    process.stderr.write(`only --output-format json supported, got: ${format}\n`)
    usage()
  }
  const chatId = Number(chatIdStr)
  if (!Number.isFinite(chatId)) {
    process.stderr.write(`--chat-id must be numeric, got: ${chatIdStr}\n`)
    usage()
  }
  return { jdPath: jdPath!, chatId, outputDir }
}

const slugFromPath = (p: string): string => {
  const base = path.basename(p, path.extname(p))
  return base.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().slice(0, 30) || 'cli'
}

const main = async (): Promise<void> => {
  const start = Date.now()
  let result: CliResult = {
    ok: false,
    pdf_path: null,
    last_change: null,
    score: null,
    refinement_applied: false,
    error: null,
    duration_ms: 0,
  }

  try {
    const args = parseArgs(process.argv.slice(2))

    // 1. Read JD text from disk.
    const jdText = await fs.readFile(args.jdPath, 'utf8')
    if (jdText.trim().length < 50) {
      throw new Error(`JD too short: ${jdText.length} chars at ${args.jdPath}`)
    }

    // 2. Build the per-job workspace using System A's existing helper.
    const jobId = makeJobId(slugFromPath(args.jdPath))
    const { jobDir } = await createJobWorkspace(args.chatId, jobId, jdText, undefined)
    logger.info({ event: 'cli_workspace_created', job_id: jobId, jobDir }, 'workspace ready')

    // Insert into the jobs table so cli-edit.js (and admin tooling like
    // /sysstatus) can find this run later. Without this row the headless
    // tailor would be a "ghost job" — workspace on disk but invisible to
    // the DB. ADR-032 (cli-edit) requires the row + session_id pair.
    createJob({
      job_id: jobId,
      chat_id: args.chatId,
      workspace_path: jobDir,
      jd_url: null,
      company: null,
      role: null,
      status: 'generating',
    })

    // 3. Tailoring (§13.1 invocation A).
    const tailorResult = await runTailoring(jobDir)
    if (tailorResult.isError) {
      setJobStatus(jobId, 'failed')
      throw new ClaudeError(
        'CLAUDE_FAILED',
        `tailor is_error subtype=${tailorResult.subtype}: ${tailorResult.result.slice(0, 200)}`,
      )
    }
    // Persist the session_id IMMEDIATELY after a successful tailor — this
    // is what cli-edit.js will look up for the iterate-on-existing flow
    // (ADR-032). Doing it here, not after critic/refine, ensures the
    // session is recoverable even if a downstream step fails.
    setJobSession(jobId, tailorResult.sessionId)
    logger.info(
      {
        event: 'cli_tailor_done',
        job_id: jobId,
        cost_usd: tailorResult.totalCostUsd,
        duration_ms: tailorResult.durationMs,
      },
      'tailor complete',
    )

    // 4. Critic + optional refinement (degrades gracefully on failure).
    let score: number | null = null
    let refinementApplied = false
    try {
      const critic = await runCritic(jobDir)
      score = critic.score
      const needsRefine =
        (critic.score < config.QUALITY_THRESHOLD || critic.violations.length > 0) &&
        (critic.gaps.length > 0 || critic.violations.length > 0)
      if (needsRefine) {
        try {
          await runRefinement(
            jobDir,
            tailorResult.sessionId,
            critic.gaps,
            critic.violations,
          )
          refinementApplied = true
          logger.info({ event: 'cli_refine_done', job_id: jobId }, 'refinement complete')
        } catch (err) {
          logger.warn(
            { err: String(err), job_id: jobId },
            'refinement failed; keeping v1 output',
          )
        }
      }
    } catch (err) {
      logger.warn(
        { err: String(err), job_id: jobId },
        'critic failed; skipping quality gate',
      )
    }

    // 5. Render PDF.
    let pdfPath: string
    try {
      pdfPath = await renderResumePdf(jobDir)
    } catch (err) {
      if (err instanceof RenderError) throw err
      throw new RenderError('RENDER_FAILED', String(err).slice(0, 300))
    }

    // 6. Optional: copy to caller's output_dir for stable downstream paths.
    let finalPdfPath = pdfPath
    if (args.outputDir) {
      await fs.mkdir(args.outputDir, { recursive: true })
      finalPdfPath = path.join(args.outputDir, `${jobId}.pdf`)
      await fs.copyFile(pdfPath, finalPdfPath)
    }

    // 7. Read the agent's one-line change summary.
    let lastChange = '(no summary)'
    try {
      const txt = await fs.readFile(path.join(jobDir, 'last_change.txt'), 'utf8')
      lastChange = txt.trim() || lastChange
    } catch {
      /* fine — agent may not have written one */
    }

    // Mark the job ready in the DB so cli-edit can find it later.
    // (Errors handled in the catch block — they call setJobStatus('failed').)
    try {
      setJobStatus(jobId, 'ready')
    } catch (e) {
      logger.warn({ err: String(e), job_id: jobId }, 'setJobStatus(ready) failed')
    }

    result = {
      ok: true,
      pdf_path: finalPdfPath,
      last_change: lastChange,
      score,
      refinement_applied: refinementApplied,
      error: null,
      duration_ms: Date.now() - start,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.error = msg.slice(0, 500)
    result.duration_ms = Date.now() - start
    logger.error({ err: msg, event: 'cli_failed' }, 'cli-tailor failed')
  }

  // Single-line JSON to stdout — System B's tailor_bridge.py JSON-decodes this.
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}

void main()
