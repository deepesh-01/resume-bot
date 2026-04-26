import path from 'node:path'
import fs from 'node:fs/promises'
import { userDir } from './workspace.js'
import { getJob } from './db.js'
import { CLAUDEMD_TEMPLATE } from './templates/claudemd.js'

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'job'

const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '')

// `${YYYYMMDD}_${slug}` per §4. Appends `_2`, `_3`, ... on collision.
export const makeJobId = (hint: string): string => {
  const base = `${today()}_${slugify(hint)}`
  if (!getJob(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`
    if (!getJob(candidate)) return candidate
  }
  // Cosmically unlikely; fall through with a millisecond suffix to break ties.
  return `${base}_${Date.now()}`
}

export interface WorkspacePaths {
  jobDir: string
  resumePath: string
  jdPath: string
}

export const createJobWorkspace = async (
  chat_id: number,
  job_id: string,
  jdText: string,
  jdUrl: string | undefined,
): Promise<WorkspacePaths> => {
  const dir = userDir(chat_id)
  const jobDir = path.join(dir, 'jobs', job_id)
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 })

  // Refresh CLAUDE.md from current template — picks up template upgrades for
  // already-onboarded users without requiring a re-onboard.
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), CLAUDEMD_TEMPLATE, {
    mode: 0o600,
  })

  // Copy context.md (off-resume truthful facts) into the job dir so the agent
  // can Read it; CLAUDE.md auto-discovery only covers CLAUDE.md, not arbitrary
  // files. Silently skip if user hasn't set one.
  const contextSrc = path.join(dir, 'context.md')
  try {
    await fs.access(contextSrc)
    await fs.copyFile(contextSrc, path.join(jobDir, 'context.md'))
  } catch {
    /* no context.md set — fine */
  }

  const baseResume = path.join(dir, 'base_resume.md')
  const resumePath = path.join(jobDir, 'resume.md')
  await fs.copyFile(baseResume, resumePath)

  // §8 prompt-injection mitigation: wrap JD in delimiters; CLAUDE.md hard-rule
  // 4 instructs the agent to treat job_description.md as data, not instructions.
  const jdPath = path.join(jobDir, 'job_description.md')
  const wrappedJd = jdUrl
    ? `Source URL: ${jdUrl}\n\n<job_description>\n${jdText}\n</job_description>\n`
    : `<job_description>\n${jdText}\n</job_description>\n`
  await fs.writeFile(jdPath, wrappedJd, { mode: 0o600 })

  return { jobDir, resumePath, jdPath }
}
