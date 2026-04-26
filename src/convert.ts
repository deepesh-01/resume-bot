import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { logger } from './logger.js'

// §13.7 error code surfaced to user as STRINGS.uploadParseFailed.
export class ConversionError extends Error {
  constructor(
    public code: 'UPLOAD_PARSE_FAILED',
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

// §13.3 timeouts.
const PDF_TIMEOUT_MS = 90_000
const DOCX_TIMEOUT_MS = 30_000

// §13.1 invocation C — verbatim prompt.
const PDF_PROMPT =
  'Read base_resume.pdf and write a clean markdown version to base_resume.md. ' +
  'Use ## for section headings, - for bullets. Preserve all content exactly. ' +
  'Output only the file — no commentary.'

interface SubprocessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const runWithTimeout = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<SubprocessResult> =>
  new Promise((resolve, reject) => {
    // Close stdin so claude doesn't wait 3s for input when using --print.
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    // §13.3 SIGTERM → wait 5s → SIGKILL.
    const term = setTimeout(() => {
      timedOut = true
      logger.warn(
        { cmd, pid: child.pid, ms: opts.timeoutMs },
        'subprocess soft timeout, sending SIGTERM',
      )
      child.kill('SIGTERM')
    }, opts.timeoutMs)
    const kill = setTimeout(() => {
      logger.error(
        { cmd, pid: child.pid },
        'subprocess hard timeout, sending SIGKILL',
      )
      child.kill('SIGKILL')
    }, opts.timeoutMs + 5_000)

    child.on('exit', (code) => {
      clearTimeout(term)
      clearTimeout(kill)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(term)
      clearTimeout(kill)
      reject(err)
    })
  })

// .md upload was downloaded directly to base_resume.md — no conversion needed.
export const convertMd = async (dir: string): Promise<void> => {
  await fs.access(path.join(dir, 'base_resume.md'))
}

// Pandoc DOCX → GFM markdown into base_resume.md.
export const convertDocx = async (dir: string): Promise<void> => {
  const src = path.join(dir, 'base_resume.docx')
  const dest = path.join(dir, 'base_resume.md')
  const result = await runWithTimeout(
    'pandoc',
    [src, '-o', dest, '--to=gfm', '--wrap=none'],
    { cwd: dir, timeoutMs: DOCX_TIMEOUT_MS },
  )
  if (result.timedOut || result.code !== 0) {
    throw new ConversionError(
      'UPLOAD_PARSE_FAILED',
      `pandoc exit=${result.code} timedOut=${result.timedOut}: ${result.stderr.slice(0, 500)}`,
    )
  }
  await fs.access(dest)
}

// claude -p one-shot extraction per §13.1 invocation C, with the §13.10
// "spirit not syntax" substitution: --cwd → spawn cwd option, drop --max-turns.
export const convertPdf = async (dir: string): Promise<void> => {
  const dest = path.join(dir, 'base_resume.md')
  // Prompt MUST come right after -p, before the variadic --allowedTools.
  // claude's commander parser otherwise greedy-eats the prompt as a tool name.
  const result = await runWithTimeout(
    'claude',
    [
      '-p', PDF_PROMPT,
      '--output-format', 'json',
      '--allowedTools', 'Read,Write',
    ],
    { cwd: dir, timeoutMs: PDF_TIMEOUT_MS },
  )

  if (result.timedOut) {
    throw new ConversionError('UPLOAD_PARSE_FAILED', 'claude PDF extraction timed out')
  }
  if (result.code !== 0) {
    throw new ConversionError(
      'UPLOAD_PARSE_FAILED',
      `claude exit=${result.code}: ${result.stderr.slice(0, 500)}`,
    )
  }

  // §13.2 — parse JSON output.
  let parsed: { is_error?: boolean; result?: string; subtype?: string }
  try {
    parsed = JSON.parse(result.stdout)
  } catch (err) {
    throw new ConversionError(
      'UPLOAD_PARSE_FAILED',
      `claude output not JSON: ${result.stdout.slice(0, 200)}`,
      err,
    )
  }
  if (parsed.is_error) {
    throw new ConversionError(
      'UPLOAD_PARSE_FAILED',
      `claude is_error subtype=${parsed.subtype}: ${String(parsed.result).slice(0, 500)}`,
    )
  }
  try {
    await fs.access(dest)
  } catch {
    throw new ConversionError(
      'UPLOAD_PARSE_FAILED',
      'claude returned success but did not write base_resume.md',
    )
  }
}
