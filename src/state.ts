import fs from 'node:fs'
import { getUser } from './db.js'
import { userDir } from './workspace.js'

export type OnboardingState = 'fresh' | 'awaiting_confirm' | 'onboarded'

// State is derived from (users.onboarded flag, filesystem). Three cases:
//   fresh            — no successful upload yet
//   awaiting_confirm — base_resume.<ext> AND base_resume.md both present, onboarded=0
//   onboarded        — users.onboarded=1
export const getOnboardingState = (chat_id: number): OnboardingState => {
  const user = getUser(chat_id)
  if (user?.onboarded === 1) return 'onboarded'

  const dir = userDir(chat_id)
  if (!fs.existsSync(dir)) return 'fresh'

  const files = fs.readdirSync(dir)
  const hasOriginal = files.some((f) => /^base_resume\.(pdf|docx|md)$/i.test(f))
  const hasMarkdown = files.includes('base_resume.md')

  if (hasOriginal && hasMarkdown) return 'awaiting_confirm'
  return 'fresh'
}
