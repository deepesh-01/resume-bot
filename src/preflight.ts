// Preflight checks at process boot. Anything that's a hard prerequisite
// for the bot to do real work — but isn't a TypeScript-level import —
// gets verified here, BEFORE we start serving Telegram. Failures are
// logged FATAL and DM'd to admins so a degraded bot doesn't sit silent.

import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import type { Bot } from 'grammy'
import type { BotContext } from './bot.js'

// Augment process.env.PATH with the directories we know our binaries live
// in. The bot can be launched by various supervisors (our launchd
// watchdog, sibling job-intake's `python -m web.server`, manual
// `npm start`). Some of those supervisors strip PATH down to launchd's
// minimal default '/usr/bin:/bin:/usr/sbin:/sbin' which doesn't include
// any of the user-installed CLI dirs. Without this, `spawn('claude', …)`
// fails ENOENT and every job in the bot fails silently as `claudeFailed`.
//
// The order matters: we PREPEND so user-installed binaries shadow any
// system equivalents.
export const augmentPath = (): { before: string; after: string } => {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const before = process.env.PATH ?? ''
  const existing = before.split(':').filter(Boolean)
  const merged = [...new Set([...candidates, ...existing])]
  const after = merged.join(':')
  process.env.PATH = after
  return { before, after }
}

export interface PreflightResult {
  ok: boolean
  pathBefore: string
  pathAfter: string
  claude: { found: boolean; resolvedPath?: string; version?: string }
  pandoc: { found: boolean; resolvedPath?: string }
  typst: { found: boolean; resolvedPath?: string }
}

const which = (cmd: string): string | undefined => {
  // POSIX `command -v` works in bash and is fine for our needs.
  const res = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], {
    encoding: 'utf8',
  })
  if (res.status !== 0) return undefined
  const out = res.stdout.trim()
  return out || undefined
}

const versionOf = (cmd: string): string | undefined => {
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) return undefined
  return res.stdout.trim().split('\n')[0]
}

export const runPreflight = (): PreflightResult => {
  const { before, after } = augmentPath()

  const claudePath = which('claude')
  const pandocPath = which('pandoc')
  const typstPath = which('typst')

  const result: PreflightResult = {
    ok: Boolean(claudePath && pandocPath && typstPath),
    pathBefore: before,
    pathAfter: after,
    claude: {
      found: Boolean(claudePath),
      resolvedPath: claudePath,
      version: claudePath ? versionOf('claude') : undefined,
    },
    pandoc: { found: Boolean(pandocPath), resolvedPath: pandocPath },
    typst: { found: Boolean(typstPath), resolvedPath: typstPath },
  }

  if (result.ok) {
    logger.info(
      {
        event: 'preflight_ok',
        claude: result.claude.resolvedPath,
        claude_version: result.claude.version,
        pandoc: result.pandoc.resolvedPath,
        typst: result.typst.resolvedPath,
      },
      'preflight passed',
    )
  } else {
    logger.fatal(
      {
        event: 'preflight_failed',
        claude_found: result.claude.found,
        pandoc_found: result.pandoc.found,
        typst_found: result.typst.found,
        path_before: before,
        path_after: after,
      },
      'preflight failed: required CLI(s) missing — jobs will fail with ENOENT',
    )
  }

  return result
}

// One-shot admin DM when preflight fails. Bot keeps running so admins can
// still see /sysstatus and react; we just want loud notification that the
// bot is degraded the moment it boots.
export const dmAdminsIfPreflightFailed = async (
  bot: Bot<BotContext>,
  result: PreflightResult,
): Promise<void> => {
  if (result.ok) return

  const missing: string[] = []
  if (!result.claude.found) missing.push('claude')
  if (!result.pandoc.found) missing.push('pandoc')
  if (!result.typst.found) missing.push('typst')

  const msg =
    `🚨 <b>Bot booted in a degraded state</b>\n` +
    `Missing on PATH: <code>${missing.join(', ')}</code>\n\n` +
    `Jobs will fail with <code>ENOENT</code> until this is fixed. ` +
    `Most likely cause: a supervisor (watchdog, sibling project, manual ` +
    `<code>npm start</code>) launched the bot with a stripped PATH that ` +
    `doesn't include the dir where the missing binary lives.\n\n` +
    `Current PATH:\n<code>${result.pathAfter.slice(0, 800)}</code>\n\n` +
    `Run <code>/sysstatus</code> for a full health snapshot.`

  for (const adminId of config.ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(adminId, msg, { parse_mode: 'HTML' })
    } catch (err) {
      logger.warn(
        { err: String(err), admin_chat_id: adminId },
        'preflight-failed DM did not deliver',
      )
    }
  }
}
