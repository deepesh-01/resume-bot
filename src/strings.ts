// User-facing message strings — verbatim per resume-bot-design.md §13.6 / §13.7.
// Centralized so the binding "do not invent copy" rule (§13.10) is auditable.

export const STRINGS = {
  // §13.6 onboarding
  onboarding:
    'Hey 👋 I tailor resumes to job descriptions.\n\n' +
    'To start, send me your current resume as a PDF, DOCX, or markdown file.',
  rejected: 'This bot is private. Sorry!',
  readingResume: 'Reading your resume…',
  saved: 'Saved. Send me a job URL or paste a job description to start tailoring.',
  // §13.9 edge cases
  unsupportedExt: 'I can read PDF, DOCX, or markdown. Try one of those?',
  // §13.7 error taxonomy — onboarding
  uploadParseFailed: "Couldn't read that file. Try another format?",
  // §13.6 generation
  readingJob: 'Reading the job description…',
  gotIt: (role: string, company: string): string =>
    `Got it: ${role} at ${company}. Tailoring now…`,
  gotItUnknown: 'Tailoring now…',
  v1Ready: (summary: string, scoreNote?: string): string =>
    `v1 ready. ${summary}${scoreNote ? `\n\n${scoreNote}` : ''}\n\nReply with edits (e.g. "make the summary punchier") or /done to finalize.`,
  // §13.7 error taxonomy — generation
  scrapeFailed: "Couldn't load that page. Paste the JD text instead?",
  scrapeAuthWall: 'LinkedIn blocked the scrape. Paste the JD text?',
  jdTooShort:
    'That JD looks too short to tailor against. Paste a fuller version?',
  claudeTimeout: 'Generation took too long. Try /reset and resend.',
  claudeAuth: 'Claude Code auth expired — owner needs to re-login.',
  claudeRateLimit: (hours = 'a few'): string =>
    `Subscription rate limit hit. Try again in ~${hours} hours.`,
  claudeFailed: 'Generation failed. Try /reset and resend.',
  renderFailed: 'PDF render failed. Trying fallback…',
  renderFailedFinal: 'PDF render failed even with fallback. Try again or /reset.',
  // §13.6 editing
  onIt: 'On it…',
  editComplete: (summary: string): string => `Updated. ${summary}`,
  // §13.6 saving (v1 stub — /save itself is step 6)
  finalized:
    'Finalized. Send /save to push edits to your base resume, or skip.',
} as const
