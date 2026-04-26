import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'

export class RenderError extends Error {
  constructor(public code: 'RENDER_FAILED', message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

const PANDOC_TIMEOUT_MS = 30_000
const TYPST_TIMEOUT_MS = 30_000
const TECTONIC_TIMEOUT_MS = 60_000

// Resolve template relative to this module so `dist/` lookups still find it.
//   src/render.ts  → ../templates/resume.typ
//   dist/render.js → ../templates/resume.typ
const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.resolve(HERE, '..', 'templates', 'resume.typ')

interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const run = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const term = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, opts.timeoutMs - 5_000)
    const kill = setTimeout(() => {
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('error', (err) => {
      clearTimeout(term)
      clearTimeout(kill)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(term)
      clearTimeout(kill)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })

// Primary path: pandoc → typst. Fallback path: tectonic+LaTeX. §13.5.
// Returns the absolute path to the produced PDF.
export const renderResumePdf = async (jobDir: string): Promise<string> => {
  const pdfPath = path.join(jobDir, 'final.pdf')

  try {
    await tryTypst(jobDir)
    return pdfPath
  } catch (err) {
    logger.warn({ err: String(err) }, 'typst path failed, trying tectonic fallback')
    try {
      await tryTectonic(jobDir)
      return pdfPath
    } catch (fallbackErr) {
      throw new RenderError(
        'RENDER_FAILED',
        `typst+tectonic both failed: ${String(fallbackErr).slice(0, 300)}`,
      )
    }
  }
}

const tryTypst = async (jobDir: string): Promise<void> => {
  // 1. resume.md → resume_body.typ via pandoc
  const pandoc = await run(
    'pandoc',
    ['resume.md', '-o', 'resume_body.typ', '--to=typst', '--wrap=none'],
    { cwd: jobDir, timeoutMs: PANDOC_TIMEOUT_MS },
  )
  if (pandoc.timedOut || pandoc.code !== 0) {
    throw new Error(
      `pandoc-to-typst failed exit=${pandoc.code}: ${pandoc.stderr.slice(0, 300)}`,
    )
  }

  // 2. Copy template into jobDir so its `#include "resume_body.typ"` resolves.
  await fs.copyFile(TEMPLATE_PATH, path.join(jobDir, 'resume.typ'))

  // 3. typst compile
  const typst = await run(
    'typst',
    ['compile', 'resume.typ', 'final.pdf'],
    { cwd: jobDir, timeoutMs: TYPST_TIMEOUT_MS },
  )
  if (typst.timedOut || typst.code !== 0) {
    throw new Error(
      `typst compile failed exit=${typst.code}: ${typst.stderr.slice(0, 300)}`,
    )
  }
}

const tryTectonic = async (jobDir: string): Promise<void> => {
  // §13.5 fallback: pandoc resume.md -o final.pdf --pdf-engine=tectonic
  const r = await run(
    'pandoc',
    ['resume.md', '-o', 'final.pdf', '--pdf-engine=tectonic'],
    { cwd: jobDir, timeoutMs: TECTONIC_TIMEOUT_MS },
  )
  if (r.timedOut || r.code !== 0) {
    throw new Error(
      `tectonic fallback failed exit=${r.code}: ${r.stderr.slice(0, 300)}`,
    )
  }
}
