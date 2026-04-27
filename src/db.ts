import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

// Schema per resume-bot-design.md §5. Inlined so it's available after `tsc`
// without copying .sql files into dist/.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  chat_id        INTEGER PRIMARY KEY,
  display_name   TEXT,
  created_at     DATETIME,
  base_path      TEXT,
  onboarded      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id         TEXT PRIMARY KEY,
  chat_id        INTEGER REFERENCES users(chat_id),
  workspace_path TEXT,
  jd_url         TEXT,
  company        TEXT,
  role           TEXT,
  status         TEXT,
  session_id     TEXT,
  created_at     DATETIME,
  last_active_at DATETIME,
  quality_score  INTEGER  -- post-critic 0-100; null if critic didn't run
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  job_id     TEXT REFERENCES jobs(job_id),
  direction  TEXT,
  content    TEXT,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS usage (
  id              INTEGER PRIMARY KEY,
  job_id          TEXT,
  chat_id         INTEGER,
  invocation_type TEXT,
  duration_ms     INTEGER,
  total_cost_usd  REAL,
  created_at      DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_chat_active
  ON jobs(chat_id, last_active_at);
CREATE INDEX IF NOT EXISTS idx_usage_chat_created
  ON usage(chat_id, created_at);

CREATE TABLE IF NOT EXISTS allowed_users (
  chat_id      INTEGER PRIMARY KEY,
  display_name TEXT,
  added_by     INTEGER,
  added_at     DATETIME DEFAULT (datetime('now')),
  expires_at   DATETIME  -- NULL = permanent (admins / pre-seeded)
);

CREATE TABLE IF NOT EXISTS pending_access (
  code         TEXT PRIMARY KEY,
  chat_id      INTEGER UNIQUE NOT NULL,
  username     TEXT,
  display_name TEXT,
  requested_at DATETIME DEFAULT (datetime('now')),
  expires_at   DATETIME NOT NULL,
  notify_msg_ids TEXT  -- JSON array of {admin_chat_id, message_id} for editing
);

CREATE TABLE IF NOT EXISTS blocked_users (
  chat_id      INTEGER PRIMARY KEY,
  display_name TEXT,
  blocked_by   INTEGER,
  blocked_at   DATETIME DEFAULT (datetime('now')),
  reason       TEXT
);
`

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true })

export const db: Database.Database = new Database(config.DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(SCHEMA)

// Idempotent migrations for additive columns on previously-existing tables.
// CREATE TABLE IF NOT EXISTS ignores schema diffs on tables that already exist.
const migrations = [
  'ALTER TABLE jobs ADD COLUMN quality_score INTEGER',
  'ALTER TABLE users ADD COLUMN username TEXT',
]
for (const sql of migrations) {
  try {
    db.exec(sql)
  } catch (err) {
    if (!String(err).includes('duplicate column name')) throw err
  }
}

// Seed the allowlist with admins and any pre-approved chat_ids from env.
// Both lists become permanent (expires_at = NULL).
{
  const seed = db.prepare(
    `INSERT INTO allowed_users (chat_id, display_name, added_by, added_at, expires_at)
     VALUES (?, NULL, NULL, datetime('now'), NULL)
     ON CONFLICT(chat_id) DO UPDATE SET expires_at = NULL`,
  )
  const seedTxn = db.transaction(() => {
    for (const id of new Set([
      ...config.ADMIN_CHAT_IDS,
      ...config.ALLOWED_CHAT_IDS,
    ])) {
      seed.run(id)
    }
  })
  seedTxn()
}

export interface UserRow {
  chat_id: number
  display_name: string | null
  username: string | null  // added in QOL.3 migration
  created_at: string
  base_path: string | null
  onboarded: number
}

const _getUser = db.prepare('SELECT * FROM users WHERE chat_id = ?')
export const getUser = (chat_id: number): UserRow | undefined =>
  _getUser.get(chat_id) as UserRow | undefined

const _upsertUser = db.prepare(`
  INSERT INTO users (chat_id, display_name, username, created_at, onboarded)
  VALUES (@chat_id, @display_name, @username, datetime('now'), 0)
  ON CONFLICT(chat_id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, users.display_name),
    username     = COALESCE(excluded.username,     users.username)
`)
export const upsertUser = (params: {
  chat_id: number
  display_name: string | null
  username?: string | null
}): void => {
  _upsertUser.run({ username: null, ...params })
}

const _setBasePath = db.prepare(
  'UPDATE users SET base_path = @base_path WHERE chat_id = @chat_id',
)
export const setBasePath = (params: {
  chat_id: number
  base_path: string
}): void => {
  _setBasePath.run(params)
}

const _setOnboarded = db.prepare(
  'UPDATE users SET onboarded = @onboarded WHERE chat_id = @chat_id',
)
export const setOnboarded = (params: {
  chat_id: number
  onboarded: 0 | 1
}): void => {
  _setOnboarded.run(params)
}

// ----- jobs -----

export interface JobRow {
  job_id: string
  chat_id: number
  workspace_path: string | null
  jd_url: string | null
  company: string | null
  role: string | null
  status: string | null
  session_id: string | null
  created_at: string | null
  last_active_at: string | null
  quality_score: number | null
}

const _getJob = db.prepare('SELECT * FROM jobs WHERE job_id = ?')
export const getJob = (job_id: string): JobRow | undefined =>
  _getJob.get(job_id) as JobRow | undefined

const _createJob = db.prepare(`
  INSERT INTO jobs (
    job_id, chat_id, workspace_path, jd_url, company, role, status,
    created_at, last_active_at
  )
  VALUES (
    @job_id, @chat_id, @workspace_path, @jd_url, @company, @role, @status,
    datetime('now'), datetime('now')
  )
`)
export const createJob = (row: {
  job_id: string
  chat_id: number
  workspace_path: string
  jd_url: string | null
  company: string | null
  role: string | null
  status: string
}): void => {
  _createJob.run(row)
}

const _setJobStatus = db.prepare(
  'UPDATE jobs SET status = @status, last_active_at = datetime(\'now\') WHERE job_id = @job_id',
)
export const setJobStatus = (job_id: string, status: string): void => {
  _setJobStatus.run({ job_id, status })
}

const _setJobSession = db.prepare(
  'UPDATE jobs SET session_id = @session_id WHERE job_id = @job_id',
)
export const setJobSession = (job_id: string, session_id: string): void => {
  _setJobSession.run({ job_id, session_id })
}

const _touchJob = db.prepare(
  'UPDATE jobs SET last_active_at = datetime(\'now\') WHERE job_id = @job_id',
)
export const touchJob = (job_id: string): void => {
  _touchJob.run({ job_id })
}

const _setQualityScore = db.prepare(
  'UPDATE jobs SET quality_score = @score WHERE job_id = @job_id',
)
export const setQualityScore = (job_id: string, score: number): void => {
  _setQualityScore.run({ job_id, score: Math.round(score) })
}

// Most-recent ready job within 24h, used by step 5 edit-loop detection.
const _getActiveJob = db.prepare(`
  SELECT * FROM jobs
  WHERE chat_id = ? AND status = 'ready'
    AND last_active_at >= datetime('now', '-24 hours')
  ORDER BY last_active_at DESC
  LIMIT 1
`)
export const getActiveJob = (chat_id: number): JobRow | undefined =>
  _getActiveJob.get(chat_id) as JobRow | undefined

// ----- usage -----

const _logUsage = db.prepare(`
  INSERT INTO usage (job_id, chat_id, invocation_type, duration_ms, total_cost_usd, created_at)
  VALUES (@job_id, @chat_id, @invocation_type, @duration_ms, @total_cost_usd, datetime('now'))
`)
// Invocation types tracked in the usage table:
//   A = initial tailoring (§13.1)
//   B = edit pass (§13.1, --resume)
//   C = PDF extraction during onboarding (§13.1; reserved)
//   D = critic / quality gate (post-tailoring eval)
//   E = refinement pass (auto-fix from critic feedback)
export const logUsage = (row: {
  job_id: string
  chat_id: number
  invocation_type: 'A' | 'B' | 'C' | 'D' | 'E'
  duration_ms: number
  total_cost_usd: number
}): void => {
  _logUsage.run(row)
}

// ----- access control -----

export interface AllowedUserRow {
  chat_id: number
  display_name: string | null
  username: string | null  // pulled via LEFT JOIN on users
  added_by: number | null
  added_at: string
  expires_at: string | null
}

export interface PendingAccessRow {
  code: string
  chat_id: number
  username: string | null
  display_name: string | null
  requested_at: string
  expires_at: string
  notify_msg_ids: string | null
}

const _isAllowed = db.prepare(
  `SELECT 1 FROM allowed_users
   WHERE chat_id = ?
     AND (expires_at IS NULL OR expires_at > datetime('now'))`,
)
export const isAllowed = (chat_id: number): boolean =>
  Boolean(_isAllowed.get(chat_id))

const _addAllowedUser = db.prepare(`
  INSERT INTO allowed_users (chat_id, display_name, added_by, added_at, expires_at)
  VALUES (@chat_id, @display_name, @added_by, datetime('now'), @expires_at)
  ON CONFLICT(chat_id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, allowed_users.display_name),
    added_by     = COALESCE(excluded.added_by, allowed_users.added_by),
    expires_at   = excluded.expires_at
`)
export const addAllowedUser = (row: {
  chat_id: number
  display_name: string | null
  added_by: number | null
  expires_at: string | null
}): void => {
  _addAllowedUser.run(row)
}

const _removeAllowedUser = db.prepare(
  'DELETE FROM allowed_users WHERE chat_id = ?',
)
export const removeAllowedUser = (chat_id: number): void => {
  _removeAllowedUser.run(chat_id)
}

const _addPendingAccess = db.prepare(`
  INSERT INTO pending_access (code, chat_id, username, display_name, requested_at, expires_at, notify_msg_ids)
  VALUES (@code, @chat_id, @username, @display_name, datetime('now'), @expires_at, @notify_msg_ids)
  ON CONFLICT(chat_id) DO UPDATE SET
    code           = excluded.code,
    username       = COALESCE(excluded.username, pending_access.username),
    display_name   = COALESCE(excluded.display_name, pending_access.display_name),
    requested_at   = datetime('now'),
    expires_at     = excluded.expires_at,
    notify_msg_ids = excluded.notify_msg_ids
`)
export const upsertPendingAccess = (row: {
  code: string
  chat_id: number
  username: string | null
  display_name: string | null
  expires_at: string
  notify_msg_ids: string | null
}): void => {
  _addPendingAccess.run(row)
}

const _getPendingByCode = db.prepare(
  `SELECT * FROM pending_access WHERE code = ? AND expires_at > datetime('now')`,
)
export const getPendingByCode = (code: string): PendingAccessRow | undefined =>
  _getPendingByCode.get(code) as PendingAccessRow | undefined

const _getPendingByChatId = db.prepare(
  `SELECT * FROM pending_access WHERE chat_id = ? AND expires_at > datetime('now')`,
)
export const getPendingByChatId = (
  chat_id: number,
): PendingAccessRow | undefined =>
  _getPendingByChatId.get(chat_id) as PendingAccessRow | undefined

const _removePendingAccess = db.prepare(
  'DELETE FROM pending_access WHERE code = ?',
)
export const removePendingAccess = (code: string): void => {
  _removePendingAccess.run(code)
}

const _listPending = db.prepare(
  `SELECT * FROM pending_access
   WHERE expires_at > datetime('now')
   ORDER BY requested_at ASC`,
)
export const listPending = (): PendingAccessRow[] =>
  _listPending.all() as PendingAccessRow[]

const _listAllowedUsers = db.prepare(
  `SELECT a.*, u.username AS username
     FROM allowed_users a
     LEFT JOIN users u ON u.chat_id = a.chat_id
    ORDER BY a.added_at DESC`,
)
export const listAllowedUsers = (): AllowedUserRow[] =>
  _listAllowedUsers.all() as AllowedUserRow[]

const _getAllowedUser = db.prepare(
  `SELECT * FROM allowed_users WHERE chat_id = ?`,
)
export const getAllowedUser = (chat_id: number): AllowedUserRow | undefined =>
  _getAllowedUser.get(chat_id) as AllowedUserRow | undefined

// ----- block list -----

export interface BlockedUserRow {
  chat_id: number
  display_name: string | null
  username: string | null  // pulled via LEFT JOIN on users
  blocked_by: number | null
  blocked_at: string
  reason: string | null
}

const _isBlocked = db.prepare(
  `SELECT 1 FROM blocked_users WHERE chat_id = ?`,
)
export const isBlocked = (chat_id: number): boolean =>
  Boolean(_isBlocked.get(chat_id))

const _addBlockedUser = db.prepare(`
  INSERT INTO blocked_users (chat_id, display_name, blocked_by, blocked_at, reason)
  VALUES (@chat_id, @display_name, @blocked_by, datetime('now'), @reason)
  ON CONFLICT(chat_id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, blocked_users.display_name),
    blocked_by   = COALESCE(excluded.blocked_by, blocked_users.blocked_by),
    blocked_at   = datetime('now'),
    reason       = COALESCE(excluded.reason, blocked_users.reason)
`)
export const addBlockedUser = (row: {
  chat_id: number
  display_name: string | null
  blocked_by: number | null
  reason: string | null
}): void => {
  _addBlockedUser.run(row)
}

const _removeBlockedUser = db.prepare(
  'DELETE FROM blocked_users WHERE chat_id = ?',
)
export const removeBlockedUser = (chat_id: number): boolean => {
  return _removeBlockedUser.run(chat_id).changes > 0
}

const _listBlockedUsers = db.prepare(
  `SELECT b.*, u.username AS username
     FROM blocked_users b
     LEFT JOIN users u ON u.chat_id = b.chat_id
    ORDER BY b.blocked_at DESC`,
)
export const listBlockedUsers = (): BlockedUserRow[] =>
  _listBlockedUsers.all() as BlockedUserRow[]

// ----- bulk archive (used by /revoke and /block) -----

const _archiveActiveJobs = db.prepare(
  `UPDATE jobs SET status='archived', last_active_at=datetime('now')
   WHERE chat_id = ? AND status = 'ready'`,
)
export const archiveActiveJobsForChat = (chat_id: number): number =>
  _archiveActiveJobs.run(chat_id).changes

// ----- restart-time interrupted-job handling (ADR-030) -----

// Called from the shutdown handler so a /restart marks in-flight jobs
// before the process exits. The boot path picks them up and DMs the user.
const _markGeneratingAsInterrupted = db.prepare(
  `UPDATE jobs SET status='interrupted', last_active_at=datetime('now')
    WHERE status='generating'`,
)
export const markGeneratingAsInterrupted = (): number =>
  _markGeneratingAsInterrupted.run().changes

// On boot we need to find users whose jobs we should DM about. Includes
// rows still stuck in 'generating' (kill -9 path — shutdown handler never
// got to mark them) AND rows we marked 'interrupted' on a graceful exit.
// Restricts to last 24h so we don't DM about jobs the user has long
// forgotten if the bot was offline for days.
export interface InterruptedJobsByChatRow {
  chat_id: number
  n: number
}
const _interruptedRecent = db.prepare<[], InterruptedJobsByChatRow>(
  `SELECT chat_id, COUNT(*) AS n
     FROM jobs
    WHERE status IN ('interrupted', 'generating')
      AND created_at >= datetime('now', '-24 hours')
    GROUP BY chat_id`,
)
export const listRecentInterruptedJobsByChat =
  (): InterruptedJobsByChatRow[] => _interruptedRecent.all()

// Bulk-flip everything to 'failed' regardless of age — no point leaving
// rows in transient states. Affects rows the boot DM scan covered AND any
// older 'generating'/'interrupted' rows that fell outside the 24h window.
const _flushInterruptedToFailed = db.prepare(
  `UPDATE jobs SET status='failed', last_active_at=datetime('now')
    WHERE status IN ('interrupted', 'generating')`,
)
export const flushInterruptedToFailed = (): number =>
  _flushInterruptedToFailed.run().changes

export const closeDb = (): void => {
  db.close()
}
