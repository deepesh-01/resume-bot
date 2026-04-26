import 'dotenv/config'
import fs from 'node:fs'

const REQUIRED_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_CHAT_IDS',
  'ADMIN_CHAT_IDS',
  'OWNER_CHAT_ID',
  'WORKSPACE_ROOT',
  'TEMPLATES_DIR',
  'LOG_DIR',
  'DB_PATH',
  'PLAYWRIGHT_LINKEDIN_COOKIE_PATH',
  'NODE_ENV',
] as const

const fail = (msg: string): never => {
  process.stderr.write(`config: ${msg}\n`)
  process.exit(1)
}

const missing = REQUIRED_KEYS.filter((k) => {
  const v = process.env[k]
  return v === undefined || v.trim() === ''
})
if (missing.length > 0) {
  fail(`missing required env vars: ${missing.join(', ')}`)
}

const parseChatIds = (raw: string): number[] => {
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number)
  if (ids.length === 0) fail('ALLOWED_CHAT_IDS is empty')
  if (ids.some((n) => !Number.isFinite(n))) {
    fail(`ALLOWED_CHAT_IDS contains non-numeric values: ${raw}`)
  }
  return ids
}

const ownerChatId = Number(process.env.OWNER_CHAT_ID)
if (!Number.isFinite(ownerChatId)) {
  fail(`OWNER_CHAT_ID must be numeric, got: ${process.env.OWNER_CHAT_ID}`)
}

const workspaceRoot = process.env.WORKSPACE_ROOT!
try {
  fs.accessSync(workspaceRoot, fs.constants.W_OK)
} catch {
  fail(
    `WORKSPACE_ROOT (${workspaceRoot}) does not exist or is not writable. ` +
      `Run \`npm run init-workspace\` first.`,
  )
}

// Optional: critic refinement threshold. Defaults to 80 if missing/invalid.
const parseQualityThreshold = (): number => {
  const raw = process.env.QUALITY_THRESHOLD
  if (!raw || raw.trim() === '') return 80
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 80
}

// Optional: HTTP health-check + restart endpoint port. 0 = disabled.
// Default 8787, bound to 127.0.0.1.
const parseHealthPort = (): number => {
  const raw = process.env.HEALTH_PORT
  if (!raw || raw.trim() === '') return 8787
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 65535 ? n : 8787
}

export const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  ALLOWED_CHAT_IDS: parseChatIds(process.env.ALLOWED_CHAT_IDS!),
  ADMIN_CHAT_IDS: parseChatIds(process.env.ADMIN_CHAT_IDS!),
  OWNER_CHAT_ID: ownerChatId,
  WORKSPACE_ROOT: workspaceRoot,
  TEMPLATES_DIR: process.env.TEMPLATES_DIR!,
  LOG_DIR: process.env.LOG_DIR!,
  DB_PATH: process.env.DB_PATH!,
  PLAYWRIGHT_LINKEDIN_COOKIE_PATH: process.env.PLAYWRIGHT_LINKEDIN_COOKIE_PATH!,
  NODE_ENV: process.env.NODE_ENV!,
  QUALITY_THRESHOLD: parseQualityThreshold(),
  HEALTH_PORT: parseHealthPort(),
  // Optional: enables /restart endpoint when set. Empty/undefined disables it.
  WATCHDOG_RESTART_TOKEN: process.env.WATCHDOG_RESTART_TOKEN ?? '',
} as const

export const isProd = config.NODE_ENV === 'production'
