// Per-chat pending state for the /save selection step.
// Lives between /save (which presents the diff) and the user's reply
// (which lists hunk numbers / "all" / "none").

import type { StructuredPatchHunk } from 'diff'

export interface SavePending {
  hunks: StructuredPatchHunk[]
  baseText: string
  basePath: string
  jobId: string
}

const pending = new Map<number, SavePending>()

export const setSavePending = (chat_id: number, state: SavePending): void => {
  pending.set(chat_id, state)
}

export const getSavePending = (chat_id: number): SavePending | undefined =>
  pending.get(chat_id)

export const clearSavePending = (chat_id: number): SavePending | undefined => {
  const v = pending.get(chat_id)
  pending.delete(chat_id)
  return v
}

// Parse user's selection reply.
// Accepts: "1 3 5", "1,3,5", "all", "none" / "cancel".
// Returns: number[] (0-indexed hunk indices) | 'all' | 'none' | 'invalid'.
export const parseSelection = (
  input: string,
  total: number,
): number[] | 'all' | 'none' | 'invalid' => {
  const t = input.trim().toLowerCase()
  if (t === 'all') return 'all'
  if (t === 'none' || t === 'cancel') return 'none'

  const tokens = t.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return 'invalid'

  const indices: number[] = []
  for (const tok of tokens) {
    const n = Number(tok)
    if (!Number.isFinite(n) || n < 1 || n > total) return 'invalid'
    indices.push(n - 1)
  }
  // De-dup, keep order.
  return Array.from(new Set(indices))
}
