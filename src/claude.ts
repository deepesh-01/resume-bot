import { spawn } from 'node:child_process'
import { logger } from './logger.js'

export class ClaudeError extends Error {
  constructor(
    public code:
      | 'CLAUDE_TIMEOUT'
      | 'CLAUDE_AUTH'
      | 'CLAUDE_RATE_LIMIT'
      | 'CLAUDE_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'ClaudeError'
  }
}

// §13.3 hard-kill timeouts (soft = hard - 5s grace).
// EDIT bumped to 4 min: complex multi-direction edit instructions (e.g. "lead
// with X, reframe Y, link Z to JD phrase") routinely hit the original 2 min.
const TAILOR_HARD_MS = 5 * 60_000
const EDIT_HARD_MS = 4 * 60_000
const CRITIC_HARD_MS = 90_000

// §13.1 invocation A — verbatim prompt.
const TAILOR_PROMPT =
  'Tailor resume.md to fit job_description.md. Edit resume.md in place. ' +
  'After editing, write a one-line summary of your changes to last_change.txt.'

// Critic pass — read-only evaluator. Outputs structured JSON.
const CRITIC_PROMPT = `You are a critical reviewer evaluating a tailored resume against a job description.

Read \`resume.md\`, \`job_description.md\`, and \`context.md\` (if present).

Step 1. Identify the 3-5 most important attributes a strong candidate would demonstrate for THIS role. Draw from the JD's specific emphasis (team name, problem domain, stack, scale, compliance regime, AI tooling expectations, etc.). DO NOT pick generic attributes — pick what THIS JD specifically values.

Step 2. For each attribute, score 0-10 on how prominently the resume leads with / surfaces it (10 = dominates the first 5 lines and recurs in experience bullets; 0 = absent).

Step 3. List specific gaps where the resume fails to lead with attributes the JD emphasizes. Be concrete (which section, what's missing).

Step 4. List any claims in resume.md that aren't supported by base_resume.md or context.md (rule #2 violations — facts the agent invented).

Step 5. Compute a single weighted score 0-100 across all attributes (10 ↔ 10 points each scaled to 100).

Output ONLY a single JSON object on stdout. No commentary, no code fences.

Format:
{
  "score": <0-100 integer>,
  "attributes": [{"name":"...","score":7,"rationale":"..."}],
  "gaps": ["specific gap"],
  "violations": ["specific invented fact"]
}`

export interface TailoringResult {
  sessionId: string
  isError: boolean
  subtype: string
  result: string
  totalCostUsd: number
  durationMs: number
}

const classifyStderr = (
  stderr: string,
): 'CLAUDE_AUTH' | 'CLAUDE_RATE_LIMIT' | undefined => {
  if (/expired|unauthorized|not.*logged.*in|please.*log.*in/i.test(stderr)) {
    return 'CLAUDE_AUTH'
  }
  if (/rate.?limit|quota.*exceeded|too.*many.*requests/i.test(stderr)) {
    return 'CLAUDE_RATE_LIMIT'
  }
  return undefined
}

const runClaude = async (
  args: string[],
  cwd: string,
  hardMs: number,
): Promise<TailoringResult> => {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
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
      logger.warn({ pid: child.pid, hardMs }, 'claude soft-timeout SIGTERM')
      child.kill('SIGTERM')
    }, hardMs - 5_000)
    const kill = setTimeout(() => {
      logger.error({ pid: child.pid }, 'claude hard-timeout SIGKILL')
      child.kill('SIGKILL')
    }, hardMs)

    child.on('error', (err) => {
      clearTimeout(term)
      clearTimeout(kill)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(term)
      clearTimeout(kill)

      if (timedOut) {
        return reject(
          new ClaudeError('CLAUDE_TIMEOUT', `claude exceeded ${hardMs}ms`),
        )
      }
      if (code !== 0) {
        const cls = classifyStderr(stderr)
        return reject(
          new ClaudeError(
            cls ?? 'CLAUDE_FAILED',
            `claude exit=${code}: ${stderr.slice(0, 500)}`,
          ),
        )
      }

      let parsed: {
        session_id?: string
        is_error?: boolean
        subtype?: string
        result?: string
        total_cost_usd?: number
        duration_ms?: number
      }
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(
          new ClaudeError(
            'CLAUDE_FAILED',
            `claude output not JSON: ${stdout.slice(0, 200)}`,
          ),
        )
      }

      resolve({
        sessionId: parsed.session_id ?? '',
        isError: Boolean(parsed.is_error),
        subtype: parsed.subtype ?? 'unknown',
        result: String(parsed.result ?? ''),
        totalCostUsd: Number(parsed.total_cost_usd ?? 0),
        durationMs: Number(parsed.duration_ms ?? Date.now() - start),
      })
    })
  })
}

// §13.1 invocation A.
export const runTailoring = async (jobDir: string): Promise<TailoringResult> =>
  runClaude(
    [
      '-p', TAILOR_PROMPT,
      '--output-format', 'json',
      '--allowedTools', 'Read,Edit,Write',
    ],
    jobDir,
    TAILOR_HARD_MS,
  )

// §13.1 invocation B — for step 5 edit loop.
export const runEdit = async (
  jobDir: string,
  sessionId: string,
  instruction: string,
): Promise<TailoringResult> =>
  runClaude(
    [
      '-p', instruction,
      '--resume', sessionId,
      '--output-format', 'json',
      '--allowedTools', 'Read,Edit,Write',
    ],
    jobDir,
    EDIT_HARD_MS,
  )

// ---------- Critic pass (lever A, quality gate) ----------

export interface CriticResult {
  score: number
  attributes: Array<{ name: string; score: number; rationale?: string }>
  gaps: string[]
  violations: string[]
  totalCostUsd: number
  durationMs: number
}

const extractJsonBlock = (text: string): string => {
  // Strip optional code fences.
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  // Fall back to first { ... last } if there's surrounding prose.
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first !== -1 && last > first) s = s.slice(first, last + 1)
  return s
}

export const runCritic = async (jobDir: string): Promise<CriticResult> => {
  const inner = await runClaude(
    [
      '-p', CRITIC_PROMPT,
      '--output-format', 'json',
      '--allowedTools', 'Read', // read-only; cannot mutate resume.md
    ],
    jobDir,
    CRITIC_HARD_MS,
  )

  if (inner.isError) {
    throw new ClaudeError(
      'CLAUDE_FAILED',
      `critic is_error: ${inner.result.slice(0, 200)}`,
    )
  }

  let parsed: {
    score?: number
    attributes?: Array<{ name?: string; score?: number; rationale?: string }>
    gaps?: string[]
    violations?: string[]
  }
  try {
    parsed = JSON.parse(extractJsonBlock(inner.result))
  } catch (err) {
    throw new ClaudeError(
      'CLAUDE_FAILED',
      `critic JSON parse failed: ${inner.result.slice(0, 200)}`,
    )
  }

  return {
    score: Number(parsed.score ?? 0),
    attributes: Array.isArray(parsed.attributes)
      ? parsed.attributes.map((a) => ({
          name: String(a.name ?? ''),
          score: Number(a.score ?? 0),
          rationale: a.rationale ? String(a.rationale) : undefined,
        }))
      : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
    violations: Array.isArray(parsed.violations)
      ? parsed.violations.map(String)
      : [],
    totalCostUsd: inner.totalCostUsd,
    durationMs: inner.durationMs,
  }
}

// ---------- Refinement pass (auto-fix from critic feedback) ----------

const buildRefinementPrompt = (
  gaps: string[],
  violations: string[],
): string => {
  const lines: string[] = []
  lines.push('A reviewer evaluated your tailoring and flagged the following.')
  lines.push('')
  if (gaps.length > 0) {
    lines.push('Gaps to address:')
    for (const g of gaps) lines.push(`- ${g}`)
    lines.push('')
  }
  if (violations.length > 0) {
    lines.push(
      'Unsupported claims to remove (these are not in resume.md / base_resume.md / context.md):',
    )
    for (const v of violations) lines.push(`- ${v}`)
    lines.push('')
  }
  lines.push(
    'Apply these fixes to resume.md. Edit in place. Do NOT introduce new claims beyond what is already in resume.md, base_resume.md, or context.md.',
  )
  lines.push('Update last_change.txt with a one-line summary of the refinements.')
  return lines.join('\n')
}

export const runRefinement = async (
  jobDir: string,
  sessionId: string,
  gaps: string[],
  violations: string[],
): Promise<TailoringResult> =>
  runClaude(
    [
      '-p', buildRefinementPrompt(gaps, violations),
      '--resume', sessionId,
      '--output-format', 'json',
      '--allowedTools', 'Read,Edit,Write',
    ],
    jobDir,
    EDIT_HARD_MS,
  )
