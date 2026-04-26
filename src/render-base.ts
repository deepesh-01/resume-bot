// Headless: re-render a user's base_resume.md → base_resume.pdf without
// going through the Telegram bot. Useful when base_resume.md was edited
// out-of-band (e.g. by an admin via filesystem) and the sibling
// base_resume.pdf is now stale.
//
// Usage:
//   npm run render-base -- --chat-id 1089113785
//   npm run render-base -- --all              # all users with a base_resume.md
//
// Mirrors src/render.ts's pandoc → typst pipeline by staging into a temp
// dir (since render.ts expects `resume.md` + writes `final.pdf`), then
// copying the produced PDF back to the user's workspace.

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { config } from './config.js'
import { userDir } from './workspace.js'
import { renderResumePdf, RenderError } from './render.js'

interface Args {
  chatIds: number[]
  all: boolean
}

const parseArgs = (argv: string[]): Args => {
  const out: Args = { chatIds: [], all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') {
      out.all = true
    } else if (a === '--chat-id') {
      const next = argv[i + 1]
      if (!next) throw new Error('--chat-id requires a value')
      const n = Number(next)
      if (!Number.isFinite(n)) throw new Error(`invalid --chat-id: ${next}`)
      out.chatIds.push(n)
      i++
    }
  }
  if (!out.all && out.chatIds.length === 0) {
    throw new Error('pass --chat-id <id> or --all')
  }
  return out
}

const renderForChat = async (chatId: number): Promise<string> => {
  const dir = userDir(chatId)
  const baseMd = path.join(dir, 'base_resume.md')
  await fs.access(baseMd)

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `render-base-${chatId}-`))
  try {
    // render.ts expects resume.md and writes final.pdf
    await fs.copyFile(baseMd, path.join(stage, 'resume.md'))
    const pdf = await renderResumePdf(stage)
    const dest = path.join(dir, 'base_resume.pdf')
    await fs.copyFile(pdf, dest)
    return dest
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

const listUsersWithBaseResume = async (): Promise<number[]> => {
  const root = config.WORKSPACE_ROOT // ~/bot/users
  const entries = await fs.readdir(root, { withFileTypes: true })
  const out: number[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const n = Number(e.name)
    if (!Number.isFinite(n)) continue
    try {
      await fs.access(path.join(root, e.name, 'base_resume.md'))
      out.push(n)
    } catch {
      // skip dirs without a base resume
    }
  }
  return out.sort((a, b) => a - b)
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const targets = args.all ? await listUsersWithBaseResume() : args.chatIds
  if (targets.length === 0) {
    console.log('no users with base_resume.md found')
    return
  }

  let ok = 0
  let failed = 0
  for (const chatId of targets) {
    process.stdout.write(`rendering ${chatId} ... `)
    try {
      const dest = await renderForChat(chatId)
      console.log(`OK → ${dest}`)
      ok++
    } catch (err) {
      const msg = err instanceof RenderError ? err.message : String(err)
      console.log(`FAILED: ${msg}`)
      failed++
    }
  }
  console.log(`\n${ok} ok, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('render-base fatal:', err)
  process.exit(1)
})
