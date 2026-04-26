// Build descriptive PDF filenames so users see (and save) something more
// useful than `final.pdf`. On-disk file stays at jobDir/final.pdf for
// predictable internal addressing; only the Telegram-side filename changes.
//
// Format: {First}_{Last}_{Role}_{Company}.pdf
// Falls back to {job_id}.pdf when role/company/name can't be resolved.

import path from 'node:path'
import fs from 'node:fs/promises'
import { userDir } from './workspace.js'

const sanitize = (s: string | null | undefined): string => {
  if (!s) return ''
  return s
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
}

interface CandidateName {
  first: string
  last: string
}

// Read the first H1 from base_resume.md and split into first/last name.
// "# DEEPESH RATHOD" → { first: 'DEEPESH', last: 'RATHOD' }
// "# Jane Q. Doe"   → { first: 'Jane', last: 'Doe' }  (middles dropped)
export const getCandidateName = async (
  chat_id: number,
): Promise<CandidateName> => {
  try {
    const content = await fs.readFile(
      path.join(userDir(chat_id), 'base_resume.md'),
      'utf8',
    )
    for (const line of content.split('\n')) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (!m?.[1]) continue
      const parts = m[1].trim().split(/\s+/).filter(Boolean)
      const first = parts[0] ?? ''
      const last = parts.length >= 2 ? (parts[parts.length - 1] ?? '') : ''
      return { first, last }
    }
  } catch {
    /* fall through to default */
  }
  return { first: '', last: '' }
}

export interface FilenameInputs {
  candidate: CandidateName
  role: string | null
  company: string | null
  jobId: string
}

export const buildPdfFilename = ({
  candidate,
  role,
  company,
  jobId,
}: FilenameInputs): string => {
  const parts = [
    sanitize(candidate.first),
    sanitize(candidate.last),
    sanitize(role),
    sanitize(company),
  ].filter(Boolean)
  if (parts.length < 2) {
    // Not enough info for a useful name — keep the job_id as the unique fallback.
    return `${jobId}.pdf`
  }
  return `${parts.join('_')}.pdf`
}
