#!/usr/bin/env node
// Headless re-edit of an existing tailored resume — invoked from System B
// (job-intake) when the user reviews a tailored output and provides
// feedback. Resumes the prior Claude session for the matching job, applies
// the user's instruction via Read/Edit/Write tools, then re-renders the PDF.
//
// Usage:
//     node dist/cli-edit.js \
//         --job-slug <slug>     # System B's safe-id, e.g. "naukri-all-060326022621"
//         --instruction <text>  # the user's feedback, passed as the prompt
//         [--output-dir PATH]   # optional copy target (System B's data/tailored/)
//         --output-format json
//
// Returns a JSON object on stdout matching cli-tailor.js's shape:
// { ok, pdf_path, last_change, error, duration_ms }
//
// Exits 0 on success, 1 on caught failure (still emits JSON), 2 on bad args.
//
// See ADR-032 (this repo) and ADR-026 (job-intake) for the contract.

import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from './db.js'
import { runEdit, ClaudeError } from './claude.js'
import { renderResumePdf, RenderError } from './render.js'
import { logger } from './logger.js'

interface CliArgs {
  jobSlug: string
  instruction: string
  outputDir?: string
}

const usage = (): never => {
  process.stderr.write(
    'usage: node dist/cli-edit.js --job-slug <slug> --instruction <text> ' +
      '[--output-dir <path>] --output-format json\n',
  )
  process.exit(2)
}

const parseArgs = (argv: string[]): CliArgs => {
  let jobSlug: string | undefined
  let instruction: string | undefined
  let outputDir: string | undefined
  let format = 'json'
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const val = argv[i + 1]
    if (flag === '--job-slug') {
      jobSlug = val
      i++
    } else if (flag === '--instruction') {
      instruction = val
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
  if (!jobSlug || !instruction) usage()
  if (format !== 'json') {
    process.stderr.write(`only --output-format json supported, got: ${format}\n`)
    usage()
  }
  return { jobSlug: jobSlug!, instruction: instruction!, outputDir }
}

// Look up the most recent job whose job_id ends with `_<slug>`. Returns
// null if no prior tailor exists OR if the matched row lacks a session_id /
// workspace_path (e.g. a tailor that errored before claude was invoked).
const findLatestJobBySlug = (slug: string): {
  job_id: string
  workspace_path: string
  session_id: string
} | null => {
  const stmt = db.prepare(
    'SELECT job_id, workspace_path, session_id FROM jobs ' +
      'WHERE job_id LIKE ? ' +
      'AND workspace_path IS NOT NULL AND session_id IS NOT NULL ' +
      'ORDER BY created_at DESC LIMIT 1',
  )
  const row = stmt.get(`%_${slug}`) as
    | { job_id: string; workspace_path: string; session_id: string }
    | undefined
  return row ?? null
}

interface EmitShape {
  ok: boolean
  pdf_path: string | null
  last_change: string | null
  error: string | null
  duration_ms: number
}

const main = async (): Promise<number> => {
  const started = Date.now()
  const out: EmitShape = {
    ok: false,
    pdf_path: null,
    last_change: null,
    error: null,
    duration_ms: 0,
  }

  try {
    const args = parseArgs(process.argv.slice(2))

    const prior = findLatestJobBySlug(args.jobSlug)
    if (!prior) {
      throw new Error(`EDIT_NO_PRIOR_JOB: no tailored job found for slug ${args.jobSlug}`)
    }
    logger.info(
      {
        event: 'cli_edit_resolved_job',
        job_id: prior.job_id,
        workspace: prior.workspace_path,
      },
      'resumed prior job',
    )

    // Validate workspace still exists on disk (could have been
    // archived/cleaned up). Without it, runEdit will fail anyway, but
    // surface the cleaner error here.
    try {
      await fs.access(prior.workspace_path)
    } catch {
      throw new Error(
        `EDIT_WORKSPACE_MISSING: ${prior.workspace_path} (the prior tailor's workspace was deleted). ` +
          'Fall back to a fresh tailor run.',
      )
    }
    // Same for the resume.md inside it — the file `runEdit`'s Read tool will need.
    try {
      await fs.access(path.join(prior.workspace_path, 'resume.md'))
    } catch {
      throw new Error(
        `EDIT_RESUME_MISSING: ${prior.workspace_path}/resume.md is gone. Fall back to a fresh tailor run.`,
      )
    }

    // 1. Run Claude with the user's instruction. runEdit() invokes
    //    `claude -p <instruction> --resume <sessionId> --allowedTools Read,Edit,Write`
    //    in the workspace dir, so Claude can edit resume.md in place.
    const editResult = await runEdit(
      prior.workspace_path,
      prior.session_id,
      args.instruction,
    )
    if (editResult.isError) {
      throw new ClaudeError(
        'CLAUDE_FAILED',
        `edit is_error subtype=${editResult.subtype}: ${editResult.result.slice(0, 200)}`,
      )
    }
    logger.info(
      {
        event: 'cli_edit_done',
        job_id: prior.job_id,
        cost_usd: editResult.totalCostUsd,
        duration_ms: editResult.durationMs,
      },
      'edit complete',
    )

    // 2. Render PDF from the (now-updated) resume.md.
    let pdfPath: string
    try {
      pdfPath = await renderResumePdf(prior.workspace_path)
    } catch (err) {
      if (err instanceof RenderError) throw err
      throw new RenderError('RENDER_FAILED', String(err).slice(0, 300))
    }

    // 3. Optional: copy to caller's output_dir for stable downstream paths.
    let finalPdfPath = pdfPath
    if (args.outputDir) {
      await fs.mkdir(args.outputDir, { recursive: true })
      finalPdfPath = path.join(args.outputDir, `${prior.job_id}.pdf`)
      await fs.copyFile(pdfPath, finalPdfPath)
    }

    // 4. Read the agent's one-line change summary written to last_change.txt.
    let lastChange = '(no summary)'
    try {
      const txt = await fs.readFile(
        path.join(prior.workspace_path, 'last_change.txt'),
        'utf8',
      )
      lastChange = txt.trim().split('\n').pop() || lastChange
    } catch {
      // Non-fatal — runEdit's prompt may not enforce last_change.txt.
    }

    out.ok = true
    out.pdf_path = finalPdfPath
    out.last_change = lastChange
    out.duration_ms = Date.now() - started
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
    out.duration_ms = Date.now() - started
    logger.error({ err: out.error }, 'cli-edit failed')
  }

  process.stdout.write(JSON.stringify(out) + '\n')
  return out.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err}\n`)
    process.exit(1)
  },
)
