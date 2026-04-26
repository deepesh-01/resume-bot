import type { BotContext } from '../bot.js'

const HELP =
  `<b>🤖 Resume Tailoring Bot</b>\n` +
  `\n` +
  `Tailor your base resume to specific job descriptions. Send a URL or paste a JD, and I'll produce a tailored PDF. Reply with edits to refine.\n` +
  `\n` +
  `<b>Typical flow</b>\n` +
  `1. <code>/start</code> → upload your resume (PDF/DOCX/MD) → <code>/confirm</code>\n` +
  `2. Paste a JD or send a job URL → tailored PDF arrives\n` +
  `3. Reply with edits (<i>"trim to one page"</i>, <i>"lead with security"</i>) to refine\n` +
  `4. <code>/done</code> when satisfied\n` +
  `\n` +
  `<b>Commands</b>\n` +
  `/start — onboarding (upload base resume)\n` +
  `/commands — tappable list of available commands\n` +
  `/confirm — accept extracted resume during onboarding\n` +
  `/reupload — replace your base resume (keeps context.md and history)\n` +
  `/reonboard — full reset: clears base resume, context.md, archives active jobs\n` +
  `/context — view or set off-resume facts the bot can use (side projects, achievements not in your resume)\n` +
  `/status — active job + recent activity + 24h spend\n` +
  `/jobs — list your recent jobs (ids + scores + status)\n` +
  `/edit JOB_ID instruction — refine an old job (uses --resume)\n` +
  `/reset — end the current job (reversible — just archives)\n` +
  `/reset JOB_ID — wipe a specific job (destructive, asks to confirm)\n` +
  `/done — finalize the current job\n` +
  `/save — promote good edits from active job back into your base resume\n` +
  `/help — this message\n` +
  `\n` +
  `<b>Tips</b>\n` +
  `• URLs auto-scrape (LinkedIn, Greenhouse, Lever, Ashby). LinkedIn cookies must be valid.\n` +
  `• Long messages (≥70 words) get a "complete or more coming?" prompt — handles split pastes and lets you stack JD content across messages.\n` +
  `• Short text routes immediately: edit if you have an active job, new job if not.\n` +
  `• <code>/context</code> facts persist across jobs and become a second source of truth alongside your resume.\n`

export const helpHandler = async (ctx: BotContext): Promise<void> => {
  await ctx.reply(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
}
