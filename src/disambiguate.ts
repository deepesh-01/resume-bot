// Per-chat pending state for the "complete or more coming?" prompt.
// Stays alive across multiple incoming text messages until the user clicks
// one of the routing buttons (or sends a URL, which clears pending).

export interface PendingState {
  text: string
  jobId?: string // active job at time of first long message; undefined if none
  promptMessageId?: number // for editing the prompt as more text arrives
}

const pending = new Map<number, PendingState>()

export const getPending = (chat_id: number): PendingState | undefined =>
  pending.get(chat_id)

export const setPending = (chat_id: number, state: PendingState): void => {
  pending.set(chat_id, state)
}

export const clearPending = (chat_id: number): PendingState | undefined => {
  const v = pending.get(chat_id)
  pending.delete(chat_id)
  return v
}

export const wordCount = (s: string): number =>
  s.trim().split(/\s+/).filter(Boolean).length

// Threshold: ≥70 words → looks "JD-shaped" enough to ask before processing.
// Edit instructions and short pastes route immediately without prompt.
export const LONG_MESSAGE_WORDS = 70
