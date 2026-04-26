// Single source of truth for the Telegram command list shown in
// autocomplete (via setMyCommands) and listed by /commands.

export const PUBLIC_COMMAND_MENU: ReadonlyArray<{
  command: string
  description: string
}> = [
  { command: 'start', description: 'onboarding (upload base resume)' },
  { command: 'help', description: 'detailed help with tips' },
  { command: 'commands', description: 'list available commands' },
  { command: 'confirm', description: 'accept extracted resume during onboarding' },
  { command: 'reupload', description: 'replace your base resume' },
  { command: 'reonboard', description: 'full reset: clears base + context' },
  { command: 'context', description: 'view/set off-resume facts' },
  { command: 'status', description: 'active job + recent activity + 24h spend' },
  { command: 'jobs', description: 'list your recent jobs' },
  { command: 'edit', description: 'refine an old job: /edit JOB_ID instruction' },
  { command: 'reset', description: 'end current job (or wipe specific)' },
  { command: 'done', description: 'finalize current job' },
  { command: 'save', description: 'promote good edits to base resume' },
]

export const ADMIN_COMMAND_MENU: ReadonlyArray<{
  command: string
  description: string
}> = [
  { command: 'pending', description: 'list pending access requests' },
  { command: 'allow', description: 'approve access: /allow CODE' },
  { command: 'deny', description: 'reject access: /deny CODE' },
  { command: 'users', description: 'list approved users' },
  { command: 'revoke', description: 'revoke a user: /revoke chat_id' },
  { command: 'block', description: 'block a user: /block chat_id' },
  { command: 'unblock', description: 'unblock a user: /unblock chat_id' },
  { command: 'restart', description: 'restart the bot via watchdog' },
]
