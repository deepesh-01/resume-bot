// Direct smoke for step 2 modules — bypasses Telegram so we can verify the
// non-network parts: state derivation, .md no-op, pandoc DOCX → MD.
// PDF path is left for the manual Telegram smoke (touches claude CLI).

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../src/config.js'
import { db, getUser, setOnboarded, upsertUser } from '../src/db.js'
import { getOnboardingState } from '../src/state.js'
import { convertMd, convertDocx } from '../src/convert.js'
import { ensureUserDir, userDir, clearStagedUpload } from '../src/workspace.js'

const TEST_CHAT = 99_999_999

const log = (label: string, ok: boolean, detail = '') => {
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

const cleanup = () => {
  const dir = userDir(TEST_CHAT)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  db.prepare('DELETE FROM users WHERE chat_id = ?').run(TEST_CHAT)
}

const main = async () => {
  cleanup()
  console.log(`workspace_root=${config.WORKSPACE_ROOT}`)

  // 1. Fresh state — no user row, no dir.
  log('state: fresh (no user, no dir)', getOnboardingState(TEST_CHAT) === 'fresh')

  // 2. After upsertUser only — still fresh (no files).
  upsertUser({ chat_id: TEST_CHAT, display_name: 'smoke' })
  log('state: fresh (user row, no dir)', getOnboardingState(TEST_CHAT) === 'fresh')

  // 3. Stage a .md upload manually, then convertMd → state should be awaiting_confirm.
  const dir = ensureUserDir(TEST_CHAT)
  fs.writeFileSync(
    path.join(dir, 'base_resume.md'),
    '## Header\n\n- bullet one\n- bullet two\n',
  )
  await convertMd(dir)
  log(
    'convertMd: file present',
    fs.existsSync(path.join(dir, 'base_resume.md')),
  )
  log(
    'state: awaiting_confirm after .md upload',
    getOnboardingState(TEST_CHAT) === 'awaiting_confirm',
  )

  // 4. setOnboarded(1) → state should flip to onboarded.
  setOnboarded({ chat_id: TEST_CHAT, onboarded: 1 })
  log(
    'state: onboarded after flag flip',
    getOnboardingState(TEST_CHAT) === 'onboarded',
    `onboarded=${getUser(TEST_CHAT)?.onboarded}`,
  )

  // 5. clearStagedUpload + reset onboarded → state back to fresh.
  setOnboarded({ chat_id: TEST_CHAT, onboarded: 0 })
  clearStagedUpload(TEST_CHAT)
  log(
    'state: fresh after clear',
    getOnboardingState(TEST_CHAT) === 'fresh',
  )

  // 6. DOCX path — generate a sample .docx via pandoc from a .md, then convertDocx.
  const tmpMd = path.join(dir, 'sample.md')
  const tmpDocx = path.join(dir, 'base_resume.docx')
  fs.writeFileSync(
    tmpMd,
    '# Jane Doe\n\n## Summary\n\nBackend engineer.\n\n## Skills\n\n- TypeScript\n- Postgres\n',
  )
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('pandoc', [tmpMd, '-o', tmpDocx])
  if (r.status !== 0) {
    log('pandoc fixture: docx generated', false, r.stderr.toString().slice(0, 200))
  } else {
    log('pandoc fixture: docx generated', true)
    try {
      await convertDocx(dir)
      const md = fs.readFileSync(path.join(dir, 'base_resume.md'), 'utf8')
      log('convertDocx: produced base_resume.md', md.length > 0, `${md.length} bytes`)
      log(
        'convertDocx: content includes original headings',
        md.includes('Jane Doe') && md.includes('Skills'),
      )
    } catch (err) {
      log('convertDocx: succeeded', false, String(err).slice(0, 200))
    }
  }
  fs.unlinkSync(tmpMd)

  // 7. State should now be awaiting_confirm again.
  log(
    'state: awaiting_confirm after docx',
    getOnboardingState(TEST_CHAT) === 'awaiting_confirm',
  )

  // 8. Verify CLAUDE.md template loads and contains the binding hard-rule line.
  const { CLAUDEMD_TEMPLATE } = await import('../src/templates/claudemd.js')
  log(
    'CLAUDE.md template: contains "Hard rules"',
    CLAUDEMD_TEMPLATE.includes('## Hard rules'),
  )
  log(
    'CLAUDE.md template: contains untrusted-data instruction',
    CLAUDEMD_TEMPLATE.includes('untrusted data'),
  )

  cleanup()
  console.log(process.exitCode === 1 ? '\nSMOKE FAILED' : '\nSMOKE OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
