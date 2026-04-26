import type { StructuredPatchHunk } from 'diff'

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max - 1) + '…' : s

// Walk back through baseLines from `lineNum` (1-indexed) to find the most
// recent `## Header` (or any heading). Used as the section label for a hunk.
export const findSectionHeader = (
  baseLines: string[],
  lineNum: number,
): string => {
  // baseLines is 0-indexed; lineNum is 1-indexed (from hunk.oldStart).
  for (let i = Math.min(lineNum - 1, baseLines.length - 1); i >= 0; i--) {
    const line = baseLines[i] ?? ''
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (m?.[1]) return m[1]
  }
  return '(intro)'
}

// One-line summary of a hunk for the numbered display.
//   pure additions  → "+ \"first added line...\""
//   pure deletions  → "- \"first removed line...\""
//   modifications   → "\"removed...\" → \"added...\""
export const summarizeHunk = (
  hunk: StructuredPatchHunk,
  sectionHeader: string,
): string => {
  const removed = hunk.lines
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean)
  const added = hunk.lines
    .filter((l) => l.startsWith('+'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean)

  let body: string
  if (removed.length === 0 && added.length > 0) {
    body = `+ "${truncate(added[0] ?? '', 90)}"${
      added.length > 1 ? ` (and ${added.length - 1} more line${added.length - 1 === 1 ? '' : 's'})` : ''
    }`
  } else if (added.length === 0 && removed.length > 0) {
    body = `− "${truncate(removed[0] ?? '', 90)}"${
      removed.length > 1 ? ` (and ${removed.length - 1} more)` : ''
    }`
  } else if (added.length > 0 && removed.length > 0) {
    body = `"${truncate(removed[0] ?? '', 50)}" → "${truncate(added[0] ?? '', 50)}"`
    if (added.length + removed.length > 2) {
      body += ` (+${added.length} −${removed.length} lines)`
    }
  } else {
    body = '(whitespace/context only)'
  }

  return `${sectionHeader}: ${body}`
}

const MAX_HUNKS_SHOWN = 25

export const buildSaveMessage = (
  hunkSummaries: string[],
  jobId: string,
): string => {
  const total = hunkSummaries.length
  const lines: string[] = []
  lines.push(
    `Diff vs your base resume (${total} change${total === 1 ? '' : 's'}, job ${jobId}):`,
  )
  lines.push('')
  const shown = hunkSummaries.slice(0, MAX_HUNKS_SHOWN)
  for (let i = 0; i < shown.length; i++) {
    lines.push(`[${i + 1}] ${shown[i]}`)
  }
  if (total > MAX_HUNKS_SHOWN) {
    lines.push('')
    lines.push(`…and ${total - MAX_HUNKS_SHOWN} more changes (not shown)`)
  }
  lines.push('')
  lines.push(`Reply with numbers to keep (e.g. "1 3"), "all", or "none".`)
  return lines.join('\n')
}
