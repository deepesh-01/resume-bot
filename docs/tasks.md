# Build Step 1 — Telegram Bot Scaffold + chat_id Allowlist

*Scope: §9 step 1 only. Stop and smoke-test after this step before moving to step 2 (onboarding flow).*

Each unit is sized ≤30 minutes. Stack pinned per §13.10: TypeScript, ESM, grammY, zx, better-sqlite3, playwright, pino. No unit tests in v1.

Project root: `~/Documents/resume-builder/` (separate from workspace data at `~/bot/`).

---

## 1.1 — Project init (15 min)

- `mkdir -p ~/Documents/resume-builder/{src,templates,scripts}` and `cd` in
- `npm init -y`, then edit `package.json`:
  - `"type": "module"`
  - `"engines": { "node": ">=20" }`
  - scripts: `dev` (`tsx watch src/index.ts`), `build` (`tsc -p .`), `start` (`node dist/index.js`)
- `npm i grammy zx better-sqlite3 pino pino-pretty dotenv`
- `npm i -D typescript tsx @types/node @types/better-sqlite3`
- `tsconfig.json`: `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `outDir: dist`, `rootDir: src`, `esModuleInterop: true`, `skipLibCheck: true`
- `.gitignore`: `node_modules/`, `dist/`, `.env`, `*.log`
- `git init` (optional but recommended)

**Done when:** `npm run build` exits 0 on an empty `src/index.ts` containing only `console.log("ok")`.

---

## 1.2 — Workspace directories (10 min)

- Create at runtime, not by hand: a `scripts/init-workspace.sh` (or inline in `src/config.ts` startup) that mkdirs:
  - `~/bot/users/` (mode 0700 — §8 security)
  - `~/bot/archive/`
  - `~/bot/logs/`
  - `~/bot/templates/`
  - `~/bot/secrets/`
- Idempotent: re-running must not fail or chmod down.

**Done when:** running the script twice succeeds; `stat -f '%Lp' ~/bot/users` returns `700`.

---

## 1.3 — Env loading + validation (20 min)

- `src/config.ts`: load `.env` via `dotenv/config`, export a typed `config` object.
- Required keys per §13.8: `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS` (comma-split → `number[]`), `OWNER_CHAT_ID`, `WORKSPACE_ROOT`, `TEMPLATES_DIR`, `LOG_DIR`, `DB_PATH`, `PLAYWRIGHT_LINKEDIN_COOKIE_PATH`, `NODE_ENV`.
- Fail-fast at startup: throw with a clear message listing every missing key. Verify `WORKSPACE_ROOT` exists and is writable (`fs.accessSync(..., W_OK)`).
- `.env.example` committed with placeholder values; real `.env` only on disk.

**Done when:** deleting any required key from `.env` makes the process exit non-zero with a single readable error line.

---

## 1.4 — Logger (10 min)

- `src/logger.ts`: pino instance.
  - Dev (`NODE_ENV !== 'production'`): pretty transport to stdout.
  - Prod: JSON to `${LOG_DIR}/$(date +%Y-%m-%d).log` via `pino.destination` (rotation deferred to §8 cleanup task — out of scope for step 1, just write to today's file).
- Export a `child(bindings)` helper so handlers can attach `chat_id` / `job_id`.

**Done when:** `logger.info("hello")` shows in dev terminal and writes a JSON line in prod mode.

---

## 1.5 — SQLite init (20 min)

- `src/db/schema.sql`: the three tables from §5 (`users`, `jobs`, `messages`) verbatim, all wrapped in `CREATE TABLE IF NOT EXISTS`.
- `src/db.ts`: open `better-sqlite3(config.DB_PATH)`, `db.pragma('journal_mode = WAL')`, run `schema.sql` on boot. Export the `db` singleton plus typed prepared statements for `getUser(chat_id)` and `upsertUser({chat_id, display_name})`.
- DB file lives at `~/bot/db.sqlite` (per §13.8).

**Done when:** boot creates the file; `sqlite3 ~/bot/db.sqlite '.tables'` lists all three; second boot is a no-op.

---

## 1.6 — Bot scaffold (15 min)

- `src/bot.ts`: `new Bot(config.TELEGRAM_BOT_TOKEN)`.
- Global error handler: `bot.catch(err => logger.error({err}, 'bot error'))`.
- `bot.use` a tiny middleware that attaches `ctx.logger = logger.child({chat_id: ctx.chat?.id})` and logs every incoming update at `debug`.
- Wire SIGINT/SIGTERM to `bot.stop()` then `db.close()` then `process.exit(0)`.

**Done when:** module imports cleanly; no handlers wired yet.

---

## 1.7 — Allowlist middleware (15 min)

- `src/middleware/allowlist.ts`: `bot.use` that runs before all handlers.
- If `ctx.chat?.id` is not in `config.ALLOWED_CHAT_IDS`:
  - Reply with the §13.6 string verbatim: `This bot is private. Sorry!`
  - Log at `info` with `{event: 'rejected', chat_id, username}`
  - Do NOT call `next()`.
- If allowed: log at `debug` and call `next()`.

**Done when:** unit-of-behavior is observable from logs and outbound message; no allowlist bypass possible (allowlist runs before any command handler).

---

## 1.8 — `/start` handler stub (15 min)

- `src/handlers/start.ts`: `bot.command('start', ...)`.
- For allowlisted chats: reply with the §13.6 onboarding string verbatim:
  `Hey 👋 I tailor resumes to job descriptions.\n\nTo start, send me your current resume as a PDF, DOCX, or markdown file.`
- Upsert into `users` table: `chat_id`, `display_name = ctx.from?.username ?? ctx.from?.first_name ?? null`, `created_at = now()`, `onboarded = 0`. Don't overwrite `onboarded` if the row already exists.
- File-upload handling is **not** in step 1 — that's step 2.

**Done when:** `/start` reply matches §13.6 byte-for-byte; row appears in `users` with `onboarded=0`.

---

## 1.9 — Entry point + smoke (15 min)

- `src/index.ts`: import `config` (validates env) → init `logger` → init `db` (runs schema) → register handlers → register allowlist middleware (must be `bot.use`'d before handlers) → `bot.start()`.
- Boot order matters: env first, then logger, then db, then bot.
- On `bot.start()`, log `{event: 'bot_started', allowlist_size: ...}`.

**Smoke checklist (manual, per §13.10):**
- [ ] `npm run dev` boots without throwing; log shows `bot_started`.
- [ ] From an **allowlisted** Telegram chat: `/start` returns the §13.6 onboarding string.
- [ ] From a **non-allowlisted** chat (use a second account or DM the bot from a friend): returns `This bot is private. Sorry!` and nothing else.
- [ ] `sqlite3 ~/bot/db.sqlite 'select chat_id, onboarded from users;'` shows the allowlisted chat with `onboarded=0`.
- [ ] `~/bot/logs/<today>.log` (or stdout in dev) contains `event: rejected` for the non-allowlisted attempt.
- [ ] Ctrl-C exits cleanly; rerunning the bot doesn't recreate the user row.

If any box fails, fix before requesting confirmation to move to step 2.

---

## Out of scope for step 1 (do not pre-build)

- File upload handling, PDF/DOCX → markdown conversion (step 2)
- JD scraping, claude CLI invocation (step 3)
- Typst rendering (step 4)
- Edit loop, `--resume` (step 5)
- `/save` diff flow (step 6)
- `/jobs`, `/reset`, archive cron (step 7)

Resist the urge. Each step gets its own smoke pass.

---

# Build Step 2 — Onboarding upload (PDF/DOCX/MD → `base_resume.md`)

*Scope: §9 step 2. Stop and smoke-test after this step before moving to step 3 (single-shot JD generation).*

Prereqs (decided 2026-04-26):
- `pandoc 3.9.0.2` installed via Homebrew.
- §13.1 flag substitution: `--cwd <dir>` not in installed `claude` CLI → use Node `spawn({ cwd })`. `--max-turns` not present → drop, rely on §13.3 hard timeout (90s for PDF extraction).

---

## 2.1 — CLAUDE.md template module (5 min)

- `src/templates/claudemd.ts` exports the §13.4 template **verbatim** as a `string`.
- No customization, no string interpolation. The doc explicitly forbids inventing additions (§13.10).

**Done when:** `import { CLAUDEMD_TEMPLATE } from './templates/claudemd.js'` returns the §13.4 markdown.

---

## 2.2 — DB helpers for onboarding state (15 min)

Onboarding state is **derived**, not stored as a column — three states from `users.onboarded` + filesystem:
- `fresh` → no `base_resume.*` files in user's workspace
- `awaiting_confirm` → `base_resume.<ext>` AND `base_resume.md` both exist, `onboarded=0`
- `onboarded` → `users.onboarded=1`

In `src/db.ts` add:
- `setBasePath({ chat_id, base_path })`
- `setOnboarded({ chat_id, onboarded })`

In a new `src/state.ts`:
- `getOnboardingState(chat_id): 'fresh'|'awaiting_confirm'|'onboarded'` — combines DB + FS check.

**Done when:** unit-of-behavior is observable: after a fake file write, state flips from `fresh` → `awaiting_confirm` → `onboarded`.

---

## 2.3 — Conversion module (25 min)

`src/convert.ts` exports three functions, each writing `base_resume.md` into the user's workspace:

- `convertMd(srcPath, userDir)` — `fs.rename` to `${userDir}/base_resume.md`. No conversion.
- `convertDocx(srcPath, userDir)` — `pandoc <src> -o ${userDir}/base_resume.md`. 30s hard timeout. Raise `UPLOAD_PARSE_FAILED` (§13.7) on non-zero exit.
- `convertPdf(srcPath, userDir)` — invocation **C** from §13.1 with the `cwd` substitution:
  ```ts
  spawn('claude', [
    '-p',
    '--output-format', 'json',
    '--allowedTools', 'Read,Write',
    'Read base_resume.pdf and write a clean markdown version to base_resume.md. Use ## for section headings, - for bullets. Preserve all content exactly. Output only the file — no commentary.',
  ], { cwd: userDir })
  ```
  90s hard timeout (§13.3 PDF extraction). Parse stdout JSON per §13.2: branch on `is_error`, surface `UPLOAD_PARSE_FAILED` if true.

Also retain the original upload as `base_resume.<original-ext>` per §4 ("Original upload, kept for re-parsing"). Move it before invoking, not after.

**Done when:** all three paths produce a `base_resume.md` for sample inputs (or fail clean with the right error code).

---

## 2.4 — File download + workspace helper (15 min)

`src/workspace.ts`:
- `userDir(chat_id): string` — returns `${WORKSPACE_ROOT}/${chat_id}/`. Note: per §13.8, `WORKSPACE_ROOT` already includes the `users/` segment.
- `ensureUserDir(chat_id)` — `mkdir -p` with mode `0700`.
- `downloadTelegramFile(ctx, destPath)` — uses `ctx.getFile()` then `file.download(destPath)` (grammY's helper).
- `clearStagedUpload(chat_id)` — deletes `base_resume.*` files in user's dir.

**Done when:** all four work in isolation against the real filesystem.

---

## 2.5 — Document upload handler (25 min)

`src/handlers/document.ts`:
- `bot.on('message:document', ...)`.
- Compute file extension from `ctx.message.document.file_name` (lowercase).
- Reject if extension isn't `pdf`, `docx`, or `md` → reply: `I can read PDF, DOCX, or markdown. Try one of those?` (per §13.9 edge case).
- Reply `Reading your resume…` (§13.6).
- `ensureUserDir`, `downloadTelegramFile` to `${userDir}/base_resume.<ext>`.
- Dispatch to convertPdf/convertDocx/convertMd.
- On success: read first 500 chars of `base_resume.md`, send §13.6:
  ```
  Got it. Here's what I extracted (first ~500 chars):

  ```
  {preview}
  ```

  Reply /confirm if this looks right, or /reupload to try again.
  ```
  Telegram MarkdownV2 escaping is fragile — send as plain text with the literal triple-backtick fences for readability, or use HTML mode. Pick one and stick to it.
- `setBasePath({ chat_id, base_path: '${userDir}/base_resume.md' })`.
- On failure: surface §13.7 `UPLOAD_PARSE_FAILED` user message: `Couldn't read that file. Try another format?`

**Done when:** all three formats land a preview reply and create both files in the user's dir.

---

## 2.6 — `/confirm` and `/reupload` handlers (15 min)

`src/handlers/confirm.ts`:
- `bot.command('confirm', ...)`.
- Only valid when state is `awaiting_confirm`. If state is `fresh`, ignore (or send onboarding prompt). If `onboarded`, ignore.
- Write `${userDir}/CLAUDE.md` from the §13.4 template (verbatim).
- `setOnboarded({ chat_id, onboarded: 1 })`.
- Reply: `Saved. Send me a job URL or paste a job description to start tailoring.` (§13.6).

`src/handlers/reupload.ts`:
- `bot.command('reupload', ...)`.
- Only valid when state is `awaiting_confirm`. Otherwise ignore.
- `clearStagedUpload(chat_id)`.
- Reply with the §13.6 onboarding string verbatim (same as `/start` reply).

**Done when:** `/confirm` flips state to `onboarded` and writes CLAUDE.md; `/reupload` returns to `fresh`.

---

## 2.7 — Pre-onboarding fallback middleware (15 min)

`src/middleware/preOnboarding.ts`:
- Runs **after** allowlist, **before** all handlers.
- If user's state is `fresh` (or `awaiting_confirm`) AND the message isn't `/start`, `/confirm`, `/reupload`, or a document → reply with the onboarding prompt (§13.6).
- If `onboarded` → `next()` and let downstream handlers run.

This implements §13.9: "Non-file message before `onboarded=1` → resend onboarding prompt."

**Done when:** sending random text from a fresh user gets the onboarding prompt; doesn't double-fire on `/start` (which also sends it).

---

## 2.8 — Wire into `src/index.ts` + build verification (15 min)

Registration order in `index.ts`:
```
bot.use(allowlist)
bot.use(preOnboarding)
bot.command('start', startHandler)
bot.command('confirm', confirmHandler)
bot.command('reupload', reuploadHandler)
bot.on('message:document', documentHandler)
```
- Run `npm run typecheck` → clean.
- Run `npm run build` → produces `dist/`.

**Done when:** typecheck/build clean, no orphaned imports.

---

## 2.9 — Smoke checklist for step 2

Run `npm run dev` and from your allowlisted Telegram chat:

- [ ] **Reset state:** `rm -rf ~/bot/users/<your-chat-id>/ && sqlite3 ~/bot/db.sqlite "update users set onboarded=0 where chat_id=<id>;"`
- [ ] **`/start`** → onboarding prompt.
- [ ] **Send random text** (e.g. "hi") → onboarding prompt re-sent (pre-onboarding fallback).
- [ ] **Upload `.txt` file** → "I can read PDF, DOCX, or markdown..." (unsupported ext).
- [ ] **Upload `.md` file** → preview reply with first 500 chars within 5s.
- [ ] **`/reupload`** → onboarding prompt; verify `~/bot/users/<id>/base_resume.*` is gone.
- [ ] **Upload `.docx` file** (any sample resume) → preview reply within ~5s. Manually inspect `~/bot/users/<id>/base_resume.md` — should have headings + bullets.
- [ ] **`/reupload`** → reset.
- [ ] **Upload `.pdf` file** → "Reading your resume…" → preview reply within ~30s. Inspect `base_resume.md` quality.
- [ ] **`/confirm`** → "Saved. Send me a job URL...".
- [ ] **Verify state transition:** `sqlite3 ~/bot/db.sqlite 'select chat_id, onboarded, base_path from users;'` shows `onboarded=1`, `base_path=/Users/.../base_resume.md`.
- [ ] **Verify CLAUDE.md exists:** `cat ~/bot/users/<id>/CLAUDE.md` matches §13.4 template byte-for-byte.
- [ ] **Send another file after onboarded** → currently undefined (handler still runs but state is `onboarded`); acceptable for step 2, will be revisited in step 3 when URL/JD handling lands.

If any box fails, fix before moving to step 3.

---

## Out of scope for step 2 (do not pre-build)

- JD scraping, claude CLI invocation for tailoring (step 3)
- Typst rendering (step 4)
- Edit loop, `--resume` (step 5)
- `/save` diff flow (step 6)
- `/jobs`, `/reset`, archive cron (step 7)

---

# Build Step 3 — Single-shot generation (URL/JD → tailored markdown)

*Scope: §9 step 3. PDF render is step 4 — for now, send tailored `resume.md` as a Telegram document. Edit loop is step 5 — every text message in step 3 triggers a NEW job; reply-as-edit is not yet wired.*

Decisions logged 2026-04-26:
- LinkedIn cookies in `~/bot/secrets/li_cookies.json` (Cookie-Editor JSON format → transformed to Playwright format on load).
- URL detection: `^https?://` regex. Otherwise treat as pasted JD text.
- No stealth plugin in v1 — add only if scraping gets flagged.
- Job ID format: `YYYYMMDD_<slug>` per §4. Slug from URL hostname (or "manual" for paste).
- Role/company extraction: best-effort from page `<title>` heuristic; fall back to "Tailoring now…" without `{role} at {company}` if parsing fails.
- For step 3 only: **every** non-command text message from an onboarded user starts a new job. The "this is an edit, not a JD" detection happens in step 5.

---

## 3.1 — Append step 3 to tasks.md (this section) (10 min)

Done by writing this section.

## 3.2 — Install Playwright + chromium (5 min)

- `npm i playwright`
- `npx playwright install chromium` (~150MB download)

**Done when:** `node -e "import('playwright').then(p=>p.chromium.launch().then(b=>{console.log('ok'); b.close()}))"` succeeds.

## 3.3 — DB migrations: usage table + job helpers (15 min)

Add to `src/db.ts` schema:
```sql
CREATE TABLE IF NOT EXISTS usage (
  id              INTEGER PRIMARY KEY,
  job_id          TEXT,
  chat_id         INTEGER,
  invocation_type TEXT,                 -- A | B | C
  duration_ms     INTEGER,
  total_cost_usd  REAL,
  created_at      DATETIME
);
```

Helpers:
- `createJob(jobRow)` — INSERT; returns nothing.
- `setJobStatus(job_id, status)`.
- `setJobSession(job_id, session_id)`.
- `touchJob(job_id)` — bump `last_active_at = datetime('now')`.
- `getActiveJob(chat_id)` — most recent `status='ready'` job within 24h. (Step 5 will use this; expose now to keep DB module cohesive.)
- `logUsage(row)`.

## 3.4 — Per-user mutex (10 min)

`src/mutex.ts`:
```ts
const queues = new Map<number, Promise<unknown>>()
export const withUserLock = <T>(chat_id: number, fn: () => Promise<T>): Promise<T> => {
  const prev = queues.get(chat_id) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  queues.set(chat_id, next.finally(() => {
    if (queues.get(chat_id) === next) queues.delete(chat_id)
  }))
  return next
}
```

## 3.5 — Scraper module (30 min)

`src/scrape.ts`:
- `loadCookies()` — read `PLAYWRIGHT_LINKEDIN_COOKIE_PATH` JSON, transform to Playwright shape: rename `expirationDate→expires`, map `sameSite` (`no_restriction→None`, `strict→Strict`, `lax→Lax`, `null→omit`), drop `storeId`/`hostOnly`/`session`. Skip cookies with `session=true` that have no `expires` (Playwright requires `expires` if present).
- `scrape(url)`: launch Chromium headless, new context with cookies if URL is LinkedIn, `page.goto(url, {timeout: 30000})`, detect auth wall (URL redirected to `/login`/`/uas/login` or login form selector visible) → throw `SCRAPE_AUTH_WALL`. Extract content:
  - LinkedIn: `.show-more-less-html__markup`, `.description__text`, `.jobs-description__content`. Try in order; first non-empty wins.
  - Generic: `<main>`, `<article>`, `body`. Strip nav/footer/script.
- Extract role/company from `<title>` and meta tags (best-effort).
- If extracted text < 200 chars → throw `JD_TOO_SHORT`.
- 30s soft / 45s hard timeout per §13.3.
- Returns `{ jdText, role?, company? }`.

## 3.6 — Job workspace creation (15 min)

`src/jobs.ts`:
- `makeJobId(chat_id, hostOrSlug)` — `${YYYYMMDD}_${slug}`. If a collision, append `_2`, `_3`, etc.
- `createJobWorkspace(chat_id, jobId, jdText, jdUrl)` — mkdir `${userDir}/jobs/${jobId}/`, copy `base_resume.md` → `resume.md`, write `job_description.md` (wrapped in `<job_description>...</job_description>` delimiters per §8 prompt-injection mitigation), return `{ jobDir, resumePath, jdPath }`.

## 3.7 — Claude invocation A wrapper (20 min)

`src/claude.ts`:
- `runTailoring(jobDir)` — spawn `claude -p <prompt> --output-format json --allowedTools Read,Edit,Write` with cwd=jobDir, 5-min hard timeout per §13.3.
- Prompt (§13.1 invocation A): `"Tailor resume.md to fit job_description.md. Edit resume.md in place. After editing, write a one-line summary of your changes to last_change.txt."`
- Parse JSON per §13.2: return `{ sessionId, isError, subtype, result, totalCostUsd, durationMs }`.
- Throw `CLAUDE_TIMEOUT` / `CLAUDE_AUTH` / `CLAUDE_RATE_LIMIT` based on subtype/stderr patterns.

## 3.8 — Job runner orchestration (30 min)

`src/runJob.ts`: `runJob(ctx, input)` where input is `{ url } | { text }`:
1. `withUserLock(chatId, async () => { ... })`
2. Reply: §13.6 `Reading the job description…`
3. Scrape (or use pasted text): produces `{ jdText, role?, company? }`. If pasted, no scraping — use text as-is, role/company unknown.
4. Reply: §13.6 `Got it: {role} at {company}. Tailoring now…` (or generic `Tailoring now…` if role/company missing).
5. `createJob` row with `status='generating'`.
6. `createJobWorkspace`.
7. `runTailoring(jobDir)`.
8. `setJobSession`, `setJobStatus('ready')`, `touchJob`, `logUsage`.
9. Read `last_change.txt` for one-line summary.
10. Send `resume.md` as document with caption: §13.6 `v1 ready. {summary}\n\nReply with edits (e.g. "make the summary punchier") or /done to finalize.` *(Step 4 will replace the markdown send with PDF.)*

Errors map to §13.7 codes; user message uses `STRINGS.<errorKey>`. Owner DM for `error+notify` codes.

## 3.9 — Text message handler + status strings (20 min)

`src/handlers/jobMessage.ts`:
- `bot.on('message:text', ...)` AFTER command handlers (so /commands win).
- Skip if text starts with `/` (defensive — command handlers should already have caught).
- URL detect: `/^https?:\/\//i`. If match → `runJob(ctx, { url: text.trim() })`. Else → `runJob(ctx, { text: text.trim() })`.

Add §13.6 strings to `src/strings.ts`:
- `readingJob: 'Reading the job description…'`
- `gotIt: (role, company) => \`Got it: ${role} at ${company}. Tailoring now…\``
- `gotItUnknown: 'Tailoring now…'`
- `v1Ready: (summary) => \`v1 ready. ${summary}\\n\\nReply with edits (e.g. "make the summary punchier") or /done to finalize.\``

Add §13.7 error strings:
- `scrapeFailed: 'Couldn't load that page. Paste the JD text instead?'`
- `scrapeAuthWall: 'LinkedIn blocked the scrape. Paste the JD text?'`
- `jdTooShort: 'That JD looks too short to tailor against. Paste a fuller version?'`
- `claudeTimeout: 'Generation took too long. Try /reset and resend.'`
- `claudeAuth: 'Claude Code auth expired — owner needs to re-login.'`
- `claudeRateLimit: 'Subscription rate limit hit. Try again in a few hours.'`
- `workspaceCorrupt: 'Job state inconsistent. Run /reset {job_id}.'`

## 3.10 — Wire into index.ts + build verification (15 min)

Order in `index.ts`:
```
bot.use(allowlist)
bot.use(preOnboarding)
bot.command('start', startHandler)
bot.command('confirm', confirmHandler)
bot.command('reupload', reuploadHandler)
bot.on('message:document', documentHandler)
bot.on('message:text', jobMessageHandler)   // <-- new (last)
```

`npm run typecheck` + `npm run build` clean.

---

## 3.11 — Smoke checklist for step 3

Manual; you'll need both LinkedIn URLs and a non-LinkedIn URL handy.

- [ ] Reset state (don't strictly need to; user is already onboarded from step 2 smoke).
- [ ] Bot starts cleanly (`bot started` log, no Playwright errors).
- [ ] Send a non-URL, non-LinkedIn URL like `https://jobs.lever.co/...` or `https://boards.greenhouse.io/...`:
  - Bot replies "Reading the job description…"
  - Within ~30s: "Got it: {role} at {company}. Tailoring now…" (or generic if extraction failed)
  - Within ~3min: tailored `resume.md` arrives as a Telegram document with v1 caption.
  - DB: `jobs` row with `status='ready'`, `session_id` set; `usage` row with `invocation_type='A'`.
- [ ] Send a LinkedIn URL:
  - Same flow. If auth wall hit: "LinkedIn blocked the scrape. Paste the JD text?"
- [ ] Paste a JD text directly (>200 chars):
  - Skips scraping, goes straight to "Tailoring now…"
- [ ] Paste a JD text that's too short (<200 chars):
  - "That JD looks too short to tailor against..."
- [ ] Send a garbage URL `https://example.com/xyz`:
  - "Couldn't load that page..."
- [ ] Send a second URL while first is still tailoring → second message is queued (mutex), processed serially.

If any box fails, fix before step 4 (Typst PDF render).

---

## Out of scope for step 3 (do not pre-build)

- Typst PDF render (step 4)
- Edit loop with `--resume` (step 5)
- `/save` diff (step 6)
- `/jobs`, `/reset`, archive cron (step 7)

---

# Build Step 4 — Typst PDF render

*Scope: §9 step 4. Replace the markdown reply with a rendered PDF. Edit loop is still step 5.*

Decisions logged 2026-04-26:
- Template lives in code repo at `templates/resume.typ` (committed). Copied into each `jobDir` at render time so its `#include "resume_body.typ"` resolves.
- Inter font installed via `brew install --cask font-inter`.
- Render runs after claude tailoring; failure surfaces §13.7 `RENDER_FAILED` (with tectonic fallback in between).

## 4.1 — Install typst + Inter (5 min)
- `brew install typst` (`typst 0.14.2` confirmed)
- `brew install --cask font-inter` (Inter Display family installed to `~/Library/Fonts/`)

## 4.2 — Add Typst template (5 min)
- `templates/resume.typ` verbatim per §13.5.

## 4.3 — Render module (20 min)
- `src/render.ts` exports `renderResumePdf(jobDir): Promise<string>` (returns absolute pdf path).
- Pipeline:
  1. `pandoc resume.md -o resume_body.typ --to=typst --wrap=none`
  2. Copy `templates/resume.typ` → `${jobDir}/resume.typ`
  3. `typst compile resume.typ final.pdf`
- Fallback (§13.5 footnote): `pandoc resume.md -o final.pdf --pdf-engine=tectonic` if typst path fails.
- Both branches fail → `RenderError('RENDER_FAILED')`.
- §13.3 timeouts: pandoc 30s, typst 30s, tectonic 60s. Soft SIGTERM at hard-5s, hard SIGKILL at hard.

## 4.4 — Wire render into runJob (10 min)
- After `runTailoring` succeeds, call `renderResumePdf(jobDir)`.
- `replyWithDocument(InputFile(pdfPath))` with the same `STRINGS.v1Ready(summary)` caption.
- `mapErrorToString` extended: `RenderError` → `STRINGS.renderFailedFinal`.

## 4.5 — Smoke checklist for step 4

- [ ] Direct render: `node -e "import('./dist/render.js').then(m=>m.renderResumePdf('<jobDir>'))"` against an existing job → `final.pdf` exists, opens cleanly, headings styled (rule lines under h1/h2, Inter font).
- [ ] Bot end-to-end: paste a JD → tailored PDF arrives in Telegram (instead of `.md`).
- [ ] Cancel + redownload bug from step 3 is gone (PDFs render natively in Telegram).
- [ ] Multi-page output rendering correctness — first page has heading + summary, content flows across pages.
- [ ] Force a render failure (e.g. corrupt the resume.md to invalid pandoc input) → bot replies `STRINGS.renderFailedFinal`.

If any box fails, fix before step 5.

---

## Out of scope for step 4 (do not pre-build)

- Edit loop with `--resume` (step 5)
- `/save` diff (step 6)
- `/jobs`, `/reset`, archive cron (step 7)

---

# Build Step 5 — Edit loop with `--resume`

*Scope: §9 step 5. After v1 PDF, user replies with edit instructions; bot runs `claude --resume` and returns updated PDF. `/done` stub added (full `/save` is step 6).*

Decisions logged 2026-04-26:
- Routing: URL → new job (always wins). Plain text + active job (status=ready, last_active <24h, has session_id) → edit. Plain text + no active job → new job (pasted JD).
- "Active job" = `jobs.getActiveJob(chat_id)` — most recent ready job within 24h (already added in step 3.3).
- claude `--resume <session_id>` may fork to a new session_id; persist the new one each time.
- `/done` is a stub for now — emits §13.6 finalized string. Actual diff-vs-base logic comes in step 6 (`/save`).

## 5.1 — Edit-flow module (20 min)

`src/runEdit.ts`: `runEditFlow(ctx, instruction)`:
1. Acquire user mutex.
2. `getActiveJob(chat_id)` → bail silently if none (defensive).
3. Reply §13.6 `On it…`.
4. `runEdit(jobDir, sessionId, instruction)` (already in `claude.ts` from step 3) → JSON parse, 2-min hard timeout per §13.3.
5. Log usage `invocation_type='B'`.
6. If `result.is_error` → throw `CLAUDE_FAILED`. Otherwise persist (possibly new) `session_id`, `touchJob`.
7. Render PDF (reuse `renderResumePdf` from step 4).
8. Read `last_change.txt` for summary.
9. Reply with PDF + caption §13.6 `Updated. {summary}`.

## 5.2 — Branching `jobMessage` handler (10 min)

```ts
if (URL_RE.test(text))         await runJob({url})
else if (active?.session_id)   await runEditFlow(text)
else                           await runJob({text})
```

## 5.3 — `/done` handler stub (5 min)

If active job exists → reply §13.6 `Finalized. Send /save to push edits to your base resume, or skip.`

## 5.4 — Strings (5 min)

Add to `STRINGS`:
- `onIt: 'On it…'`
- `editComplete: (summary) => \`Updated. ${summary}\``
- `finalized: 'Finalized. Send /save to push edits to your base resume, or skip.'`

## 5.5 — Smoke checklist for step 5

- [ ] After a generated v1 PDF, reply with `make the summary 1 line shorter` → `On it…` → updated PDF arrives within ~90s with `Updated. {new summary}` caption.
- [ ] Inspect `~/bot/users/<id>/jobs/<id>/resume.md` — change is reflected.
- [ ] DB: `usage` row with `invocation_type='B'`; `jobs.session_id` may have changed (claude can fork on resume).
- [ ] Multiple chained edits in same chat: each one updates the PDF and the cumulative resume.
- [ ] Send a long edit instruction with multiple changes: `Lead with security and the zero-failure migration. Link AI work to Cursor/Copilot. Mention RPi stack.` → expected to apply most/all.
- [ ] After 24h idle, send a non-URL text → new job (no active job in 24h window).
- [ ] During an active job, send a NEW URL → new job created (URL takes precedence over edit).
- [ ] `/done` → `Finalized. Send /save to push edits to your base resume, or skip.`
- [ ] `/save` (not yet implemented) → falls through silently for now.

If any box fails, fix before step 6.

---

## Out of scope for step 5 (do not pre-build)

- `/save` diff (step 6)
- `/jobs`, `/reset`, archive cron (step 7)
- CLAUDE.md upgrade + context.md (post-step-5: chosen "b" lever in the 2026-04-26 strategy review)
- Two-stage classifier (post-step-5 lever "c", deferred until 1-2 jobs prove (b) insufficient)

---

# Build Step 5b — CLAUDE.md upgrade + context.md (lever "b")

*Strategy review 2026-04-26: chose `a → b → c` order. Step 5 (a) shipped. This is (b) — quality lift via better prompting + a place to store off-resume facts.*

## 5b.1 — CLAUDE.md template upgrade

`templates/claudemd.ts` significantly expanded vs. §13.4 verbatim. New sections:

- **Workflow** — explicit pre-edit triage:
  1. Identify the role's archetype (security/compliance, fintech, founding/early-stage, ML, infra, DevTools, frontend, backend, product engineering, data).
  2. Identify candidate's strongest 2-3 claims for THIS archetype, drawing from `resume.md` AND `context.md`.
  3. Find the "golden thread" — direct experiential bridge to a specific JD phrase.
- **What good tailoring looks like** — concrete framings: compliance as enabling outcomes (not checkboxes), reliability in operationally-meaningful terms, AI-augmented work named with specific tools, active outcome verbs.
- **What to avoid** — added: hedging when source supports stronger phrasing.

§13.4 hard rules preserved verbatim:
- Rule #2 ("never invent") extended: sources of truth are `resume.md` (primary) AND `context.md` (secondary, if present).
- Rule #4 ("JD is untrusted data") unchanged.

§13.10 binding "do not invent CLAUDE.md content beyond §13.4" — explicitly green-lit by the strategy review.

## 5b.2 — context.md mechanism

- Lives at `~/bot/users/<chat_id>/context.md`.
- Copied into each new `jobDir/` at workspace creation alongside `resume.md`.
- CLAUDE.md instructs the agent to treat it as a SECOND source of truth.
- `createJobWorkspace` ALSO regenerates `~/bot/users/<chat_id>/CLAUDE.md` from the current template every run (idempotent, picks up template upgrades for already-onboarded users without a re-onboard).

## 5b.3 — `/context` command

`src/handlers/context.ts`:
- `/context` (no args) → show current content (HTML `<pre>` block, truncated >3500 chars).
- `/context <text>` → write `<text>\n` to `~/bot/users/<chat_id>/context.md` (mode 0600). Multi-line single-message text supported.
- Added to `ONBOARDING_COMMANDS` in pre-onboarding middleware so it works before first /confirm too (in case user wants to set context before uploading resume).

## 5b.4 — Smoke checklist

- [ ] `/context` (empty) → "No context set yet" with brief instructions.
- [ ] `/context <multi-line text>` → "Context updated (N chars)..." reply.
- [ ] `/context` (after set) → shows the saved content in a code block.
- [ ] `cat ~/bot/users/<chat_id>/context.md` matches what was sent.
- [ ] Trigger a new tailoring (paste JD, or /reupload+upload+/confirm to start fresh active-job state). New job's `jobDir/context.md` exists and matches user's `context.md`.
- [ ] Re-run an edit on an existing job: `--resume` doesn't re-discover context.md (the prior session was created without it). Workaround: paste a new JD or reset session for context.md to land in the next tailoring.
- [ ] Compare tailoring quality to previous outputs — does it lead with archetype-matched claims? Does it use context.md facts? Does it find a golden thread?

If quality lifts noticeably, no need for lever (c). If it doesn't move (or moves marginally), consider (c).

## Out of scope for step 5b

- `/save` diff (step 6)
- `/jobs`, `/reset`, archive cron (step 7)
- Two-stage classifier (lever "c") — superseded by lever A (critic+refinement)

---

# Build Step 5c — Disambiguation prompt redesign (was: debouncer)

*Strategy: dropped the 3s idle debouncer (band-aid) in favor of an explicit "complete or more coming?" prompt that doubles as the new-job-vs-edit chooser when an active job exists. Rationale in ADR-016.*

## 5c.1 — `src/disambiguate.ts` rewrite (10 min)
- Map<chat_id, PendingState> with `{text, jobId?, promptMessageId?}`.
- `getPending`, `setPending`, `clearPending`, `wordCount`, `LONG_MESSAGE_WORDS = 70`.

## 5c.2 — Pending state store (5 min)
- Each new long-text message either opens pending OR appends to existing pending.
- `promptMessageId` stored so we can edit the prompt in-place when more text arrives.

## 5c.3 — Unified prompt with 3 buttons when active job exists (15 min)
- `📥 Buffered: X words. Active job: Y. What's next?`
- `[📄 New job, end current]` `[✏️ Edit current job]` `[⏳ More coming, wait]`
- For no-active-job case: 2 buttons (New / More coming).

## 5c.4 — Edit-in-place when more text arrives (10 min)
- `ctx.api.editMessageText` with the updated buffer count and same buttons.
- Falls back to a new prompt message if edit fails.

## 5c.5 — Callback dispatch (10 min)
- `pend:new` → archive jobId if present, run `runJob({text: buffer})`.
- `pend:edit` → `runEditFlow(buffer)`.
- `pend:more` → `answerCallbackQuery({text: 'Waiting...'})`, keep buffer.

## 5c.6 — Smoke checklist
- [ ] Single short message + active job → routes immediately as edit (no prompt).
- [ ] Single long message + no active job → prompt with 2 buttons; tap [Process] → new job.
- [ ] Long Msg A then long Msg B (split paste) → first opens prompt, second appends + updates word count. Tap [Process] → ONE job created with combined text.
- [ ] Long message + active job → 3 buttons; [Edit current job] → runs edit on active.
- [ ] Tap [More coming] → bot acknowledges; user sends another message; prompt updates.

---

# Build Step 6 — `/save` (promote edits to base)

## 6.1 — Install diff lib + savePending state (10 min)
- `npm i diff @types/diff` (v8: types are `StructuredPatch`, `StructuredPatchHunk`).
- `src/savePending.ts`: per-chat map of `{hunks, baseText, basePath, jobId}`.
- `parseSelection(input, total)`: returns `number[]` | `'all'` | `'none'` | `'invalid'`.

## 6.2 — Diff utilities (15 min)
- `src/saveDiff.ts`:
  - `findSectionHeader(baseLines, lineNum)` — walk back for `## Header`.
  - `summarizeHunk(hunk, sectionHeader)` — produces "SECTION: '...' → '...'" or "+ '...'" or "− '...'".
  - `buildSaveMessage(summaries, jobId)` — numbered display, max 25 hunks shown.

## 6.3 — `/save` command + selection handler (25 min)
- `src/handlers/save.ts`:
  - `saveHandler(ctx)` — reads base + tailored, runs `structuredPatch`, presents hunks.
  - `handleSaveSelection(ctx, text)` — called from jobMessage; if savePending exists, parses selection and applies.
- `applyPatch(baseText, partialPatch, { fuzzFactor: 2 })` for selective subset.

## 6.4 — Wire into jobMessage handler (5 min)
- First check: `await handleSaveSelection(ctx, text)` — returns true if consumed.
- Save selection takes precedence over URL/edit/new-job routing.

## 6.5 — Smoke checklist
- [ ] `/save` on active job with diffs → numbered list with section labels.
- [ ] `/save` with no diffs → "No changes to save..."
- [ ] Reply `none` → "Cancelled. Base resume unchanged." Pending cleared.
- [ ] Reply `1 3` → only hunks 1 and 3 applied. Verify with `cat base_resume.md`.
- [ ] Reply `all` → full apply. "Base updated. N changes applied (of N)."
- [ ] Reply garbage like `xyz` → bot prompts again. Pending stays.

---

# Build Step 7 — `/jobs`, `/edit JOB_ID`, `/reset JOB_ID`

## 7.1 — `/jobs` listing (15 min)
- `src/handlers/jobs.ts`: SELECT recent 30 jobs ORDER BY last_active_at DESC.
- Format: `🟢/⚪️/🔴 <code>job_id</code> — Role at Company · 🎯 score · Xm/h/d ago`
- Footer hints: usage of `/edit` and `/reset JOB_ID`.

## 7.2 — `/edit JOB_ID instruction` (15 min)
- `src/handlers/edit.ts`:
  - Parse `JOB_ID` (first token) and instruction (rest).
  - `getJob(jobId)`; verify ownership (`job.chat_id === ctx.chat.id`).
  - Check `session_id` and `workspace_path` present; refuse otherwise (e.g. archived/cleared).
  - Reactivate: `setJobStatus(jobId, 'ready')` + `touchJob(jobId)`.
  - Call existing `runEditFlow(ctx, instruction)` (uses `getActiveJob`, which now returns the touched one).

## 7.3 — `/reset JOB_ID` confirmation flow (20 min)
- `src/handlers/reset.ts`: extend to accept arg.
  - If no arg: existing behavior (archive active).
  - If arg: lookup job, present confirmation prompt with `[🗑️ Wipe job] [❌ Cancel]`.
- `src/handlers/resetJob.ts`: callback handler.
  - On confirm: `fs.rm(workspace_path, {recursive: true, force: true})`, `DELETE FROM jobs`, `DELETE FROM usage`.
  - On cancel: edit message to "❌ Cancelled".
- Add `reset_job:` prefix to `callbackRouter`.

## 7.4 — Smoke checklist
- [ ] `/jobs` lists recent with scores + time-ago formatting.
- [ ] `/edit OLD_JOB instruction` reactivates and runs edit; verify with `/jobs` showing it as 🟢.
- [ ] `/edit BAD_ID instruction` → "No job ... found in your history."
- [ ] `/edit JOB_ID` (no instruction) → usage hint.
- [ ] `/reset JOB_ID` shows confirmation; tap Cancel → "❌ Cancelled — JOB_ID not wiped". Job still in /jobs.
- [ ] `/reset JOB_ID` again, tap Wipe → "🗑️ Wiped JOB_ID". Verify dir gone, /jobs no longer lists it.

---

# Build Step 7.5 — Archive cron

## 7.5.1 — `src/archiveCron.ts` (30 min)
- `findIdleJobs()` query: `last_active_at < datetime('now', '-30 days') AND workspace_path IS NOT NULL`.
- `archiveJob(job)`:
  - mkdir `~/bot/archive/<chat_id>/`.
  - spawn `tar -czf <archive> -C <parent> <basename>`.
  - rm workspace dir on success.
  - `UPDATE jobs SET workspace_path = NULL WHERE job_id = ?`.
- `runArchiveSweep()` loops over idle jobs, returns counts.
- `startArchiveCron()`: runs sweep at startup, then `setInterval(... ONE_DAY_MS)`. Calls `.unref()` on the timer.
- `stopArchiveCron()` for graceful shutdown.

## 7.5.2 — Wire into index.ts (5 min)
- After bot setup, before `bot.start()`: `startArchiveCron()`.
- Call `stopArchiveCron()` from the SIGINT/SIGTERM shutdown handler.

## 7.5.3 — Smoke checklist
- [ ] Bot startup logs `archive_cron_started` and `archive_sweep` (likely "nothing to do").
- [ ] Backdate a job (`UPDATE jobs SET last_active_at = datetime('now', '-35 days')`) and trigger sweep manually:
  ```
  node -e "import('./dist/archiveCron.js').then(m => m.runArchiveSweep().then(console.log))"
  ```
- [ ] Verify tarball at `~/bot/archive/<chat_id>/<job_id>.tar.gz`.
- [ ] Verify workspace dir removed.
- [ ] Verify `workspace_path` is NULL in DB.
- [ ] `tar -tzf <archive>` shows all preserved files.

---

# Build Step Friend-Onboarding — Self-service access requests

*Lifted earlier than §9 plan because of multi-friend onboarding need. Spec details in ADR-006.*

## FO.1 — env + schema (15 min)
- `.env`: add `ADMIN_CHAT_IDS` (subset of allowed).
- `src/config.ts`: parse to `number[]`.
- `src/db.ts` schema additions:
  - `allowed_users` (chat_id PK, display_name, added_by, added_at, expires_at NULL=permanent)
  - `pending_access` (code PK, chat_id UNIQUE, username, display_name, requested_at, expires_at, notify_msg_ids JSON)
  - `blocked_users` (chat_id PK, display_name, blocked_by, blocked_at, reason)
- Boot: seed `allowed_users` from `ADMIN_CHAT_IDS ∪ ALLOWED_CHAT_IDS` with expires_at NULL.

## FO.2 — Allowlist middleware DB-backed + access request (20 min)
- `src/middleware/allowlist.ts`:
  - Block check first: `isBlocked(chat_id)` → reply "🚫 You are blocked..." and stop.
  - Allow check: `isAllowed(chat_id)` (NULL or future expires_at) → next().
  - `/start` from non-allowlisted → `initiateAccessRequest(ctx)`.
  - Other messages from non-allowlisted → "This bot is private. Send /start to request access."
- `src/handlers/accessRequest.ts`: generate code, upsert `pending_access`, DM all admins via `notifyAdmins`.

## FO.3 — Approve/reject callback (20 min)
- `src/handlers/accessApproval.ts`:
  - `approveAccess(ctx, code)` → addAllowedUser with 7-day expiry, removePendingAccess, edit ALL admin notifications to "✅ Approved", DM friend.
  - `rejectAccess(ctx, code)` → removePendingAccess, edit notifications to "❌ Rejected", DM friend.
- `accessCallback(ctx)` dispatches by `access:approve:CODE` / `access:reject:CODE`.
- Wire into the unified `callbackRouter`.

## FO.4 — Admin fallback commands (15 min)
- `src/handlers/admin.ts`:
  - `/pending` lists active codes.
  - `/allow CODE` / `/deny CODE` — manual fallbacks calling approveAccess / rejectAccess.

## FO.5 — Smoke checklist
- [ ] Friend `/start`s from a non-allowlisted phone → "🔐 Access request sent..."
- [ ] Admin (you) gets DM with inline buttons.
- [ ] Tap [✅ Approve · 7 days] → admin notification edits to "✅ Approved", friend gets "Welcome" DM.
- [ ] Friend `/start`s again → onboarding flow proceeds.
- [ ] After 7 days (or backdate `expires_at`): friend's next message routes to fresh access request.

---

# Build Step Block-Revoke — Admin moderation

## BR.1 — Block schema + helpers (10 min)
- `blocked_users` table (already added in FO.1).
- DB helpers: `isBlocked`, `addBlockedUser`, `removeBlockedUser`, `listBlockedUsers`.
- Block check in allowlist middleware (already added in FO.2).

## BR.2 — Admin commands (30 min)
- `/users` — `listAllowedUsers()` + `listBlockedUsers()` formatted with chat_id, name, expiry/reason.
- `/revoke CHAT_ID`:
  - Refuse if target is admin.
  - removeAllowedUser, archiveActiveJobsForChat (new helper).
  - DM target: "Your access has been revoked..."
- `/block CHAT_ID [reason...]`:
  - Same as /revoke + addBlockedUser with reason.
  - DM: "🚫 You have been blocked from this bot."
- `/unblock CHAT_ID`:
  - removeBlockedUser. Does NOT auto-allow.
  - DM: "Your block has been lifted. Send /start to request access."

## BR.3 — Smoke checklist
- [ ] `/users` shows admin (permanent) + recent friend (with expiry) + empty blocked.
- [ ] `/revoke FRIEND_ID` → friend DMed, jobs archived, removed from allowed_users.
- [ ] Friend tries `/start` → can re-request (creates new pending row).
- [ ] `/block FRIEND_ID spam` → friend gets "🚫 You have been blocked", row in blocked_users with reason.
- [ ] Friend's next message → "🚫 You are blocked from this bot..." (block check wins).
- [ ] `/unblock FRIEND_ID` → friend DMed; their messages still rejected (need /start to re-request).
- [ ] `/revoke ADMIN_ID` → "is an admin — refusing."
- [ ] `/block ADMIN_ID` → "is an admin — refusing."

---

# Build Step Lever-A — Critic + auto-refinement (10x quality)

*Strategy review 2026-04-26: chose `a → b → c` order. This is the post-step-5 lever (b) extended with active critic loop. Full rationale in ADR-014.*

## LA.1 — Add CRITIC + REFINE invocation types to db.ts (5 min)
- Widen `invocation_type` to `'A' | 'B' | 'C' | 'D' | 'E'`.
- Add `quality_score` column to `jobs` table via idempotent migration.
- Add `setQualityScore` helper.

## LA.2 — `runCritic` and `runRefinement` in claude.ts (30 min)
- `runCritic(jobDir)`: spawn `claude -p` with read-only tools. JSON-parse the assistant's final text. 90s timeout.
- Robust JSON extraction: strip ```json fences, fall back to first `{`/last `}` slice.
- Returns `{score, attributes, gaps, violations, totalCostUsd, durationMs}`.
- `runRefinement(jobDir, sessionId, gaps, violations)`: builds a prompt from gaps + violations, runs `claude --resume` with Read,Edit,Write. Edit timeout (4 min).

## LA.3 — Wire critic+refinement into runJob.ts (30 min)
- After tailoring + setJobSession + setJobStatus('ready'):
  1. `runCritic` (graceful: catch + log + skip on failure).
  2. `setQualityScore`.
  3. `logUsage` type='D'.
  4. If `score < QUALITY_THRESHOLD || violations.length > 0` AND `gaps + violations not empty`:
     - `runRefinement`.
     - `logUsage` type='E'.
     - Update sessionId if changed.
     - Mark `refinementApplied = true`.
- Build `scoreNote = "🎯 Quality: X/100 (refined)"` (or without "(refined)").

## LA.4 — Caption + follow-up message (15 min)
- Update `STRINGS.v1Ready(summary, scoreNote)` to optionally include scoreNote.
- After replyWithDocument, send a follow-up `<pre>`-formatted message with:
  - "Attributes scored" list (each at X/10).
  - "Gaps addressed" (only when refinementApplied).
  - "Unsupported claims removed" (only when refinementApplied).
- Truncate at 3900 chars.

## LA.5 — Tunable threshold + score in /status (15 min)
- `.env`: add `QUALITY_THRESHOLD=80` (defaults to 80 if missing/invalid).
- `src/config.ts`: parse with bounds check.
- `src/handlers/status.ts`: query `quality_score` column, show in active job + recent jobs.

## LA.6 — Smoke checklist
- [ ] Send a JD that triggers the critic loop (likely most jobs).
- [ ] Log shows `critic_done` with `score`, `gaps`, `violations`.
- [ ] If score < 80 or violations > 0, log shows `refine_done`.
- [ ] PDF caption includes `🎯 Quality: X/100 (refined)`.
- [ ] Follow-up message has attribute scores + gaps + violations.
- [ ] `/status` shows quality score for active job and recent jobs.
- [ ] Bump `QUALITY_THRESHOLD=90` in `.env` and restart → next job almost always refines.
- [ ] Bump to `QUALITY_THRESHOLD=50` → fewer refinements, faster jobs.

---

# Build Step Reupload-Reonboard — Lifecycle reset commands

## RR.1 — `/reupload` extended (15 min)
- `src/handlers/reupload.ts` checks `getOnboardingState`:
  - `awaiting_confirm` → existing behavior (clear staged + reprompt).
  - `onboarded` → confirmation prompt with `[✅ Yes, replace resume] [❌ Cancel]`.
  - `fresh` → just send the onboarding prompt.

## RR.2 — `/reonboard` new (15 min)
- `src/handlers/reonboard.ts`:
  - `fresh` state → "No onboarding state to reset. Run /start to begin."
  - else → confirmation prompt: clears base_resume + CLAUDE.md + context.md, archives active jobs, onboarded=0.

## RR.3 — Confirmation callbacks (15 min)
- `src/handlers/resetActions.ts`: `reuploadCallback` and `reonboardCallback`.
- Both wipe what they're supposed to and send the §13.6 onboarding prompt for the next upload.
- Wire `reupload:` and `reonboard:` prefixes into `callbackRouter`.

## RR.4 — Smoke checklist
- [ ] `/reupload` post-onboarding → confirmation; tap Cancel → "❌ Cancelled — base resume unchanged."
- [ ] `/reupload` again → tap Yes → "✅ Base resume cleared." → onboarding prompt → upload new file.
- [ ] `/reonboard` → confirmation; tap Yes → "✅ Full reset done (N jobs archived)." → onboarding prompt.
- [ ] After /reonboard: `/jobs` no longer shows ready jobs (all archived); `~/bot/users/<id>/context.md` gone.

---

# Build Step Help-Status-Misc — Polish commands

## HSM.1 — `/help` (10 min)
- `src/handlers/help.ts`: HTML-formatted message listing all 12 public commands.
- Tips section explaining auto-scrape, disambig prompt, /context, etc.
- `link_preview_options: { is_disabled: true }` so linked URLs don't auto-render cards.

## HSM.2 — `/status` rich (15 min)
- Active job: id, role at company, status, quality_score, last activity timestamp.
- Recent jobs: 5-row list with status emoji + score.
- 24h spend total from usage table.

## HSM.3 — `/done` stub (5 min)
- Replies §13.6 finalize string. Full /save flow shipped separately as Step 6.

---

# Build Step Polish — Hardening

## P.1 — API timeout 60s (5 min)
- `src/bot.ts`: `client: { timeoutSeconds: 60 }` on Bot constructor.
- Prevents Telegram-API-hang from stalling the bot indefinitely (post-incident; ADR-012).

## P.2 — LinkedIn scrape resilience (45 min)
- `src/scrape.ts`:
  - Drop cookie loading per ADR-002.
  - Add `playwright-extra` + stealth plugin per ADR-003.
  - URL-only auth-wall detection (selector check produced false positives on the sign-in widget LinkedIn embeds in every page).
  - Title parsing for LinkedIn 3-segment format ("Role | Company | LinkedIn").
  - Retry with backoff on AUTH_WALL — kept the structure, mostly redundant after stealth+no-cookies.

## P.3 — Render fallback (already shipped step 4)
- `src/render.ts`: tectonic+LaTeX path if typst fails. Documented in ADR-001's footnote.

---

# Build Step Q — Headless `cli-tailor` for System B integration
*Add a second top-level entry point so System B (job-intake) can invoke the tailoring pipeline as a subprocess. ADR-021. Bot stays untouched.*

## Q.1 — `src/cli-tailor.ts` (30 min)
- New file, NOT imported from `src/index.ts` (so no Telegram bot startup).
- Args: `--jd-path`, `--chat-id`, `--output-dir` (optional), `--output-format json`.
- Pipeline: `createJobWorkspace` → `runTailoring` → `runCritic` → `runRefinement` (if score < `QUALITY_THRESHOLD` and gaps/violations) → `renderResumePdf`.
- Output (single JSON line on stdout): `{ok, pdf_path, last_change, score, refinement_applied, duration_ms, error}`.
- Exit codes: 0 ok, 1 caught failure, 2 bad args.
- No DB writes (CLI is stateless; bot owns the job history).

## Q.2 — Build & smoke (5 min)
- `npm run typecheck` clean.
- `npm run build` produces `dist/cli-tailor.js` alongside `dist/index.js`.
- Manual invocation:
  ```
  node dist/cli-tailor.js \
    --jd-path /tmp/test_jd.md \
    --chat-id 1089113785 \
    --output-format json
  ```
  Expect a JSON line with `ok:true` and a real PDF path.

## Q.3 — Smoke checklist
- [ ] Telegram bot still starts cleanly via `npm start` (no regression in import order).
- [ ] CLI exits 0 with valid args and a real JD.
- [ ] CLI exits 1 with a malformed JD path (file missing).
- [ ] CLI exits 2 with missing `--chat-id`.
- [ ] PDF lands at `~/bot/users/<chat_id>/jobs/<job_id>/final.pdf`; copied to `--output-dir/<job_id>.pdf` if provided.
- [ ] `last_change.txt` content surfaces in JSON `last_change`.
- [ ] Critic score (when present) surfaces in JSON `score`.

---

## Out of scope (current)

- Restore-from-tarball for archived jobs (ADR-010 noted).
- Multi-resume support per user.
- Scheduled posting (cron-trigger on a saved JD).
- Pre-commit doc-check git hook (manual `npm run docs:sync` only).
- Two-stage classifier (lever c) — superseded by lever A.

---

# Build Step Watchdog — Heartbeat + auto-restart (ADR-022)

*Two failure modes hit during build (process crash + process hang) require self-healing. Crash is caught by PID check; hang requires a heartbeat. Both fixed via in-bot heartbeat + external launchd watchdog.*

## W.1 — Heartbeat module (15 min)
- `src/heartbeat.ts`: `setInterval` writes `Date.now()` to `~/bot/.heartbeat` every 60s.
- `startHeartbeat()` / `stopHeartbeat()` exported.
- Timer `.unref()`'d so it doesn't pin the event loop on shutdown.

## W.2 — Wire into `src/index.ts` (5 min)
- Import alongside `archiveCron`.
- `startHeartbeat()` after `startArchiveCron()`, before `bot.start()`.
- `stopHeartbeat()` in the SIGINT/SIGTERM shutdown handler.

## W.3 — Watchdog script (30 min)
- `scripts/watchdog.sh`:
  - `find_bot_pids()` — `pgrep -f "node dist/index\.js$"` filtered by `lsof` cwd matching `$REPO_ROOT` (so other unrelated bots don't false-match).
  - `kill_bot()` — SIGINT + 5s + SIGKILL fallback.
  - `start_bot()` — `cd $REPO_ROOT && nohup npm start >> $LOG_FILE 2>&1 &`. `disown` so it detaches.
  - `notify_admin()` — reads `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_IDS` from `.env`, curls `sendMessage` for each admin. Silent on failure.
- Three restart paths, each with a different DM message:
  - No process → "Bot was down (no process running). Watchdog restarted it."
  - Heartbeat file missing → "Bot was running but heartbeat file was missing. Watchdog killed and restarted (was likely hung mid-startup)."
  - Heartbeat stale (>180s) → "Bot was hung (heartbeat ${age}s stale, threshold ${THRESHOLD}s). Watchdog killed and restarted."
- All-good path: log "ok" ~10% of runs (visibility without spam).
- Logs to `~/bot/logs/watchdog.log`.

## W.4 — launchd plist + install/uninstall (15 min)
- `scripts/com.deepesh.resume-bot-watchdog.plist`:
  - Label: `com.deepesh.resume-bot-watchdog`
  - `StartInterval`: 120 (every 2 min)
  - `RunAtLoad`: true
  - `EnvironmentVariables.PATH` includes `~/.local/share/fnm/aliases/default/bin` so `node`/`npm` resolve.
  - stdout/stderr to `~/bot/logs/watchdog.{stdout,stderr}.log`.
- `scripts/install-watchdog.sh` — copies plist to `~/Library/LaunchAgents/`, `bootout`+`bootstrap` (idempotent), `kickstart -k` for immediate run.
- `scripts/uninstall-watchdog.sh` — `bootout` + remove plist.

## W.5 — Smoke checklist
- [ ] `bash scripts/install-watchdog.sh` succeeds; `launchctl print` shows state=running.
- [ ] After install, `~/bot/logs/watchdog.log` shows watchdog runs every 2 min.
- [ ] Bot startup writes `~/bot/.heartbeat`; file age `< 60s` while bot is alive.
- [ ] Kill bot manually (`kill -KILL <pid>`) → within 2 min, watchdog detects → bot restarts → admin DM arrives "🔄 Bot was down...".
- [ ] Simulate hang (touch the heartbeat to old: `echo 0 > ~/bot/.heartbeat`) → wait 2-3 min → watchdog detects stale → kills + restarts → admin DM arrives.
- [ ] Watchdog log has both `[ts] no bot process` / `[ts] heartbeat stale` lines and `[ts] started; new pids:` follow-ups.
- [ ] `bash scripts/uninstall-watchdog.sh` removes the agent; bot keeps running but no longer auto-restarts.

## W.6 — Out of scope
- External dead-man's-switch for laptop-off scenarios (Healthchecks.io ping; would be a separate ADR if implemented).
- Watchdog self-monitoring (if launchd itself is unhealthy, no recovery).
- Per-restart cool-down to prevent thrashing if bot crashes repeatedly (current: restart every 2 min indefinitely).

---

# Build Step External-Trigger — `/healthz` + `/restart` HTTP endpoints (ADR-023)

*Third-party uptime monitors (UptimeRobot, Healthchecks.io, custom) need an HTTP API to ASK liveness and TRIGGER restart on hang detection. The launchd watchdog (W.*) is the local self-healer; this is the third-party-trigger interface.*

## ET.1 — env keys (5 min)
- `.env.example` adds `HEALTH_PORT=8787` (default) and `WATCHDOG_RESTART_TOKEN=` (empty = disabled).
- `src/config.ts` parses both with sane defaults (port 8787, token empty string).

## ET.2 — `src/health.ts` (30 min)
- Plain `node:http` server bound to `127.0.0.1:HEALTH_PORT`.
- `GET /healthz`: reads `~/bot/.heartbeat` age. 200 + JSON if <180s, 503 + JSON otherwise.
- `POST /restart`: validates `X-Watchdog-Token` header against `WATCHDOG_RESTART_TOKEN`. 401 if invalid, 501 if token unset, 202 + scheduled `process.exit(1)` after 500ms if valid.
- `startHealthServer()`/`stopHealthServer()` exported.
- Graceful: if HEALTH_PORT=0, skip server entirely.

## ET.3 — Wire into `src/index.ts` (5 min)
- Import + call `startHealthServer()` after `startHeartbeat()`, before `bot.start()`.
- `stopHealthServer()` in shutdown handler.

## ET.4 — Smoke checklist
- [ ] `curl http://127.0.0.1:8787/healthz` → 200 with `heartbeat_age_ms < 60000`.
- [ ] Touch heartbeat to old: `echo 0 > ~/bot/.heartbeat` → `curl /healthz` → 503.
- [ ] `curl -X POST /restart` → 401 (no token).
- [ ] `curl -X POST -H "X-Watchdog-Token: wrong" /restart` → 401.
- [ ] `curl -X POST -H "X-Watchdog-Token: $TOKEN" /restart` → 202, bot exits within 1s.
- [ ] launchd watchdog (or `bash scripts/watchdog.sh`) respawns the bot within 2 min.
- [ ] Set `HEALTH_PORT=0` and restart → no HTTP server starts; `/healthz` connection refused.
- [ ] Set `WATCHDOG_RESTART_TOKEN=` (empty) → `/restart` returns 501 even with valid-looking header.

## ET.5 — Out of scope
- Tunneling setup (Cloudflare Tunnel / ngrok) — documented in how-to-journey.md, user-managed.
- Webhook integration with specific monitors (Healthchecks.io, UptimeRobot) — pluggable per user.
- Rate limiting on `/restart` (currently no throttle; trust the token).

---

# Build Step Filename — Descriptive PDF filenames (ADR-024)

*`final.pdf` is generic and overrides previously-saved files. Friend feedback during testing.*

## FN.1 — `src/pdfName.ts` (15 min)
- `sanitize(s)`: `[^A-Za-z0-9_-] → _`, collapse, trim, max 40 chars per segment.
- `getCandidateName(chat_id)`: parse `# <Name>` H1 from `base_resume.md`. Returns `{first, last}`. Empty strings if not parseable.
- `buildPdfFilename({candidate, role, company, jobId})`: joins parts with `_`, falls back to `${jobId}.pdf` if fewer than 2 sanitized parts available.

## FN.2 — Wire into runJob.ts + runEdit.ts (10 min)
- Import + use `buildPdfFilename` to compute Telegram-side filename.
- `new InputFile(pdfPath, downloadName)` instead of just `new InputFile(pdfPath)`.
- On-disk path stays at `jobDir/final.pdf` (predictable for render + tests).

## FN.3 — Smoke checklist
- [ ] After a tailoring, the Telegram-attached PDF shows as `Deepesh_Rathod_Software_Engineer_2_Customer_Journey_Abnormal_AI.pdf` (or similar derived from base resume H1 + jobs.role + jobs.company).
- [ ] Pasted-text JD with no role/company → falls back to `{jobId}.pdf`.
- [ ] H1-less base resume → falls back to `{jobId}.pdf`.
- [ ] Multiple jobs from the same chat → distinct filenames, no overwrite when user saves.
- [ ] Edits via `runEditFlow` use the SAME naming (job_row's role/company).

---

# Build Step Watchdog-Hardening — pid file, attribution, /restart, /commands, autocomplete (ADR-025)

*ADR-022's watchdog hit four failure modes in production: macOS TCC blocked the launchd-spawned bash from reading scripts under `~/Documents/`; `lsof` cwd-disambiguation failed inside the launchd sandbox; the "fall back to all pgrep matches" path killed an unrelated `welog/relay` bot in a sibling directory; and the DM didn't tell the user who triggered the restart. While fixing those, also add a `/restart` Telegram command, a tappable `/commands` list, autocomplete via `setMyCommands`, and a graceful port-8787 release on shutdown.*

## WH.1 — Bot-side pid file + restart reason file (15 min)
- `src/heartbeat.ts`: export `BOT_PID_FILE = ~/bot/.bot.pid` and `RESTART_REASON_FILE = ~/bot/.restart-reason`.
- `startHeartbeat()`: write `process.pid` to `BOT_PID_FILE` synchronously before scheduling the tick.
- `stopHeartbeat()`: only `unlink` the file if the recorded pid matches `process.pid` (so a fast crash-and-restart doesn't wipe the new claim).

## WH.2 — Async stopHealthServer + SIGINT-based /restart (10 min)
- `src/health.ts`: `stopHealthServer` becomes `async`. Calls `server.closeAllConnections()` (Node 18+) then awaits `server.close()`. Without this the next bot launch hits EADDRINUSE on 8787.
- `src/index.ts` shutdown handler awaits `stopHealthServer()` before `process.exit`.
- `/restart` HTTP and the new `/restart` Telegram handler both write `RESTART_REASON_FILE` then `process.kill(process.pid, 'SIGINT')` so they go through the same graceful shutdown path. No more bare `process.exit(1)`.

## WH.3 — `/restart` Telegram command (10 min)
- `src/handlers/restart.ts`: admin-only via `isAdmin`. Reason string `Telegram /restart by @<username|chat_id>`.
- Register in `src/index.ts`. Add `restart` to `ONBOARDING_COMMANDS` in `src/middleware/preOnboarding.ts` so admins aren't blocked from restarting if their onboarding state is somehow off.

## WH.4 — `/commands` Telegram command + autocomplete via setMyCommands (15 min)
- New `src/menus.ts`: single source of truth for `PUBLIC_COMMAND_MENU` and `ADMIN_COMMAND_MENU` (each entry = `{command, description}`).
- New `src/handlers/commands.ts`: replies with a tappable list of `/commands`. Includes admin commands when `isAdmin(ctx.from?.id)`. No descriptions in the reply (that's `/help`'s job).
- `src/index.ts`: at boot, `bot.api.setMyCommands(PUBLIC_COMMAND_MENU, { scope: { type: 'default' } })`, then for each `ADMIN_CHAT_ID`, `bot.api.setMyCommands([...PUBLIC, ...ADMIN], { scope: { type: 'chat', chat_id: id } })`. Wrapped in try/catch — failure here doesn't block bot start.

## WH.5 — Watchdog rewrite (20 min)
- `scripts/watchdog.sh`: heartbeat-first detection. If heartbeat fresh → exit 0 silently with ~10% sample logging. If stale → look up bot via `~/bot/.bot.pid` (NOT `pgrep`/`lsof`). If pid alive → SIGINT → wait → SIGKILL → start. If pid dead/missing → just start. After respawn: read + delete `RESTART_REASON_FILE`, DM the recorded reason or `⚠️ Bot crashed (no process running)` if absent.
- DM template: `🔄 Bot restarted: <reason> · respawned by resume-builder watchdog · HH:MM TZ`. Hung path: `🔄 Bot was hung (heartbeat Xs stale, threshold 180s) · killed + restarted by resume-builder watchdog · …`.
- Reads config from `~/bot/.watchdog.env` (NOT `$REPO_ROOT/.env` — see WH.6).

## WH.6 — `install-watchdog.sh` deploys outside `~/Documents/` (10 min)
- Copies `scripts/watchdog.sh` → `~/bot/bin/watchdog.sh` (chmod 755).
- Extracts `TELEGRAM_BOT_TOKEN` + `ADMIN_CHAT_IDS` from `.env` → `~/bot/.watchdog.env` (chmod 600).
- Plist's `ProgramArguments[1]` updated to `/Users/deepeshz2/bot/bin/watchdog.sh`.
- `uninstall-watchdog.sh` removes the deployed script + env file.

## WH.7 — Smoke checklist
- [ ] `kill -9 $(cat ~/bot/.bot.pid)` → `~/bot/logs/watchdog.log` shows `no bot pid (file missing or pid dead) — starting`, fresh pid in `~/bot/.bot.pid`, DM arrives `⚠️ Bot crashed (no process running) · respawned by resume-builder watchdog · …`. Sibling `node dist/index.js` processes from other repos are **not** killed.
- [ ] `curl -X POST -H "X-Watchdog-Token: $TOKEN" -H "X-Watchdog-Source: smoke-test-http" http://127.0.0.1:8787/restart` → bot exits gracefully (port 8787 fully released, `lsof -tiTCP:8787` shows nothing), `~/bot/.restart-reason` says `HTTP /restart from smoke-test-http`, watchdog respawns and DM says `🔄 Bot restarted: HTTP /restart from smoke-test-http · respawned by resume-builder watchdog · …`.
- [ ] Send `/restart` from Telegram as an admin → bot replies `♻️ Restarting now…`, exits gracefully, watchdog respawns and DM says `🔄 Bot restarted: Telegram /restart by @<you> · respawned by resume-builder watchdog · …`.
- [ ] Send `/commands` from Telegram → reply is a list of `/start /help /commands …` lines (tappable). As admin, also includes the `— admin —` block ending in `/restart`.
- [ ] In Telegram client: type `/` and verify autocomplete pops up the command list. Public chats see public-only; admin chats also see admin commands.
- [ ] `launchctl print "gui/$(id -u)/com.deepesh.resume-bot-watchdog" | grep "last exit"` shows `last exit code = 0`. `~/bot/logs/watchdog.stderr.log` has no new `Operation not permitted` lines after install.

---

# Build Step Quality-of-Life — render-base CLI, daily backup, /users with username, weekly budget alert, Healthchecks.io ping (ADR-026, ADR-027, ADR-028)

*Drains the out-of-scope queue from the deleted `next-session-tasks.md`. Five small features that round out operational hygiene without expanding feature surface in the bot itself.*

## QOL.1 — `npm run render-base` headless renderer (15 min)
- New `src/render-base.ts`: `--chat-id <id>` or `--all`. Stages `base_resume.md` into a temp dir, calls `renderResumePdf` (existing `pandoc → typst` pipeline), copies `final.pdf` back to `<userDir>/base_resume.pdf`.
- Wire `npm run render-base` in `package.json`.
- Useful when an admin edits `base_resume.md` out-of-band and needs to refresh the sibling PDF without going through the Telegram `/reupload` flow.

## QOL.2 — Daily backup launchd cron (15 min)
- `scripts/backup.sh`: `sqlite3 .backup` → `~/bot/backups/bot_YYYYMMDD_HHMMSS.tar.gz`, includes `users/` + `archive/`, excludes runtime transients (`.heartbeat`, `.bot.pid`, `.restart-reason`, `logs/`). Retention: keep last 14, prune older.
- `scripts/install-backup.sh` mirrors the watchdog install pattern (ADR-025): copies the script to `~/bot/bin/backup.sh` and bootstraps a `StartCalendarInterval` plist firing at 03:00 local.
- `scripts/uninstall-backup.sh` boots out the agent and removes the deployed script. Existing tarballs preserved.
- ADR-026.

## QOL.3 — `/users` shows @username (10 min)
- Migration: `ALTER TABLE users ADD COLUMN username TEXT` (idempotent — caught by the duplicate-column swallow in `src/db.ts`).
- `upsertUser` accepts an optional `username`; `startHandler` and `documentHandler` now pass `ctx.from?.username`.
- `listAllowedUsers` and `listBlockedUsers` `LEFT JOIN users` to pull `username` into their row types.
- `usersHandler` displays `@username` when present, falls back to `display_name`.

## QOL.4 — Weekly Claude spend alert at 80% (30 min)
- New env var `CLAUDE_WEEKLY_BUDGET_USD` (0/empty disables).
- New `src/budget.ts`: `getWeeklySpendUsd()` (sum from `usage` table, last 7 days) + `checkAndAlertIfOver80(bot)` (DM admins once per 24h cooldown when crossed). State in `~/bot/.budget-alert.json`.
- Called from `runJob`'s and `runEdit`'s `finally` blocks so any job-driven invocation gets the check.
- ADR-027.

## QOL.5 — Healthchecks.io external ping (Pattern C) (15 min)
- New env var `HEALTHCHECKS_URL` (empty disables).
- `src/heartbeat.ts` `tick()` GETs the URL on every 60s heartbeat. 10s `AbortController` timeout, single warn on failure, recovery message when it returns.
- Detects laptop-off scenarios that the local launchd watchdog can't catch.
- ADR-028.

## QOL.6 — Smoke checklist
- [ ] `npm run render-base -- --chat-id <id>` writes a fresh `base_resume.pdf` whose mtime is newer than `base_resume.md`.
- [ ] `bash scripts/install-backup.sh` → `launchctl print` shows `last exit code = 0` and a tarball appears in `~/bot/backups/`. Re-running install is idempotent.
- [ ] After 14 successful backups, only the most recent 14 remain in `~/bot/backups/`.
- [ ] `/users` reply renders `@username` for users who interacted post-migration. Older rows fall back to `display_name`.
- [ ] Set `CLAUDE_WEEKLY_BUDGET_USD=0.10` and run a job → admins get a single DM `⚠️ Claude weekly spend at NN% of cap …`. Re-run within 24h → no second DM. After 24h → eligible to re-fire.
- [ ] Set `HEALTHCHECKS_URL` to a valid Healthchecks.io URL → check shows `up` within 60s of bot start. Stop the bot → check transitions to `down` after the configured grace period.
- [ ] All env vars are optional — bot boots cleanly with `CLAUDE_WEEKLY_BUDGET_USD=` and `HEALTHCHECKS_URL=` empty (no warnings, no crashes).

---

# Build Step UserStatus — admin drill-in for "who's active and how much did it cost"

*Closing the gap between `/users` (a flat list) and "I want to see this one user's whole picture without writing SQL". The bot already has the data — usage rows are tagged with `chat_id` and `invocation_type`, jobs rows have `quality_score` and `last_active_at`. We just need a focused query + render.*

## US.1 — `src/handlers/userStatus.ts` (15 min)
- Exported `formatUserStatus(chat_id: number): string` that renders the full picture as HTML in a single message:
  - Identity: chat_id, @username, display_name, joined timestamp, onboarded flag.
  - Allow/block state: allowed_at + expiry, OR blocked_at + reason, OR "users-table row but not on allowlist", OR "no users-row but found in usage history".
  - Activity: total job count, active job (id + status + score), last claude call (type + cost + timestamp).
  - Spend: 24h / 7d / all-time totals + run counts.
  - 7d breakdown by `invocation_type` (with human label: tailor / critic / refine / edit).
  - Recent 5 jobs with status emoji, role/company subject, and quality score.
- Two entry points share the formatter: `userStatusHandler` (slash) and `userStatusCallback` (inline button).

## US.2 — Callback wiring (5 min)
- New prefix `userstatus:<chat_id>` registered in `src/handlers/callbacks.ts` `callbackRouter`.
- Per CLAUDE.md convention: prefix-based dispatch only, no `bot.on('callback_query:data', …)` siblings.

## US.3 — `/users` becomes drill-in-able (10 min)
- `usersHandler` now appends an `inline_keyboard` to the existing reply: one `📊 @username` (or `📊 chat_id`) button per allowed and blocked user, packed two per row.
- Tapping a button fires the `userstatus:<chat_id>` callback, same content as the slash command.

## US.4 — Wire registrations (5 min)
- `src/index.ts`: `bot.command('userstatus', userStatusHandler)`.
- `src/menus.ts` `ADMIN_COMMAND_MENU`: `{ command: 'userstatus', description: 'drill into a user: /userstatus chat_id' }` — surfaces in Telegram autocomplete only for admin chats (per `setMyCommands` chat-scoped registration in ADR-025).
- `src/middleware/preOnboarding.ts` `ONBOARDING_COMMANDS`: `'userstatus'` allowlisted alongside `'restart'` so an admin in a weird onboarding state isn't blocked.
- `src/db.ts` `UserRow`: `username` field added to the type (the column was added by the QOL.3 migration but the type didn't reflect it).

## US.5 — Smoke checklist
- [ ] `/userstatus 1089113785` (admin) returns the full report with all five sections present and at least one row in `7d breakdown by call type`.
- [ ] `/userstatus 99999999` (unknown chat_id) replies `No user with chat_id <99999999> in db.` instead of a half-empty report.
- [ ] `/userstatus` with no arg replies with the usage hint, not a crash.
- [ ] Non-admin chat sending `/userstatus 1089113785` gets no reply (silent ignore, same pattern as `/users`).
- [ ] `/users` (admin) renders an inline keyboard with one `📊 …` button per allowed + blocked user. Tapping a button fires the `userstatus:` callback and posts the report as a fresh message.
- [ ] Telegram autocomplete in admin chat shows `userstatus` after typing `/`. In a non-admin chat, autocomplete does NOT show it.

---

# Build Step RestartAttribution-BugFix — Move post-restart DM into the bot's boot path (ADR-029)

*ADR-025 put the post-restart DM logic in the watchdog: after a /restart, the watchdog read + deleted `~/bot/.restart-reason` and DMed admins. Caught the failure mode in production: a sibling supervisor (job-intake's `python -m web.server`) beat the watchdog to spawn a new bot, watchdog's race-cleanup deleted the reason file silently, no DM. Fix: the bot itself reads + deletes the file on boot and DMs admins. The watchdog stays silent when a reason file exists.*

## RA.1 — Bot reads + DMs on boot (10 min)
- New helper in `src/index.ts` `announceRestartAfterRespawn()`. Reads `RESTART_REASON_FILE`, deletes the file, DMs `config.ADMIN_CHAT_IDS` with `🔄 Bot back online — <reason> · HH:MM TZ`. Delete-before-DM so a partial DM failure can't loop on the same reason.
- `formatTime()` helper mirrors the watchdog's `date '+%H:%M %Z'` so DM timestamps look the same regardless of emitter.
- Called as `void announceRestartAfterRespawn()` at boot, in parallel with `bot.start()` (the call is just `bot.api.sendMessage` HTTP, no polling dependency).

## RA.2 — Watchdog drops reason-file handling (5 min)
- Delete `read_and_clear_reason()` function entirely.
- Healthy-path race-cleanup line `[ -f "$RESTART_REASON_FILE" ] && rm -f "$RESTART_REASON_FILE"` removed — that was the actual bug.
- Spawn-path and hung-restart-path DMs gated by `[ ! -f "$RESTART_REASON_FILE" ]` — watchdog stays silent when the bot will speak for itself.

## RA.3 — Smoke checklist
- [ ] Stop the bot, manually `echo "Telegram /restart by @smoke" > ~/bot/.restart-reason`, start the bot. Reason file disappears within ~5s of boot, admins receive `🔄 Bot back online — Telegram /restart by @smoke · …`. Confirms RA.1.
- [ ] `kill -9 $(cat ~/bot/.bot.pid)` (no reason file present). Watchdog's next tick spawns a new bot AND DMs `⚠️ Bot crashed (no process running) · respawned by resume-builder watchdog · …`. Bot boots, no reason file, no second DM. 1 DM total.
- [ ] `/restart` from Telegram (the original failure case). Even if a sibling supervisor (job-intake's web.server, manual `npm start`) beats the watchdog to spawn a new bot, admins still get exactly one DM `🔄 Bot back online — Telegram /restart by @<you> · …`.
- [ ] `~/bot/logs/watchdog.log` after a /restart shows no `started; new pid:` entry IF a sibling beat the watchdog (consistent with the watchdog's correct "I see a healthy bot" behavior). The bot's `~/bot/logs/$(date +%Y-%m-%d).log` shows the `event: "restart_announced"` log line on the new bot's boot.

---

# Build Step Restart-UX — confirmation flow + interrupted-job cleanup (ADR-030)

*ADR-025's `/restart` was a one-shot fire — easy to mis-tap, and any job currently in `status='generating'` evaporated silently because the shutdown handler doesn't await in-flight `runJob` promises. Add a two-step confirm prompt with active-job count, mark in-flight rows as `'interrupted'` on shutdown, and on the next boot DM affected users so they know to retry.*

## RU.1 — `/restart` confirmation flow (15 min)
- `src/handlers/restart.ts` becomes two handlers:
  - `restartHandler` (slash): query `COUNT(*) FROM jobs WHERE status='generating'`, reply with inline keyboard `[✅ Yes, restart] [❌ Cancel]`. If count > 0, message body includes `⚠️ N jobs are currently generating — they will be interrupted. Affected users will get a DM after the bot is back online.`
  - `restartCallback` (button): `restart:confirm` runs the existing reason-write + SIGINT logic; `restart:cancel` edits to "Restart canceled" and bails. Per project convention, callback routed via `callbackRouter` `restart:` prefix in `src/handlers/callbacks.ts`.

## RU.2 — Mark in-flight jobs on shutdown (5 min)
- New DB helper `markGeneratingAsInterrupted()` in `src/db.ts`: `UPDATE jobs SET status='interrupted', last_active_at=now() WHERE status='generating'`.
- Called from `src/index.ts` shutdown handler before `closeDb()` (only after `bot.stop()` so we don't race a still-active runJob writing to the same row).

## RU.3 — Boot-time DM + cleanup (15 min)
- New DB helpers `listRecentInterruptedJobsByChat()` and `flushInterruptedToFailed()` in `src/db.ts`.
- New `notifyInterruptedUsers()` in `src/index.ts` runs at boot in parallel with `bot.start`:
  - Scan `WHERE status IN ('interrupted','generating') AND created_at >= now()-24h GROUP BY chat_id`.
  - Per chat, DM (singular/plural-aware): `⚠️ Your last job was interrupted by an admin restart of the bot. Please retry…`
  - Then `UPDATE jobs SET status='failed' WHERE status IN ('interrupted','generating')` (any age — DB hygiene).
- The boot scan deliberately includes `'generating'` not just `'interrupted'` so a `kill -9` (which skips the shutdown handler) is also cleaned up.

## RU.4 — Smoke checklist
- [ ] `/restart` (admin, no active jobs) → reply `♻️ Restart the bot? [✅ Yes, restart] [❌ Cancel]`. Tap Cancel → message edits to "❌ Restart canceled." Bot does NOT restart.
- [ ] `/restart` while ≥1 job is in `status='generating'` → prompt body includes `⚠️ N jobs are currently generating …`. Admin sees the warning before tapping confirm.
- [ ] Tap [✅ Yes, restart] → message edits to "♻️ Restarting now. Back online in ~10-15s — you'll get a DM." Bot exits gracefully via SIGINT, port 8787 fully released, watchdog respawns within ~2 min OR sibling supervisor beats the watchdog (either is fine — ADR-029 makes the post-restart DM survive the race).
- [ ] After respawn, admin gets `🔄 Bot back online — Telegram /restart by @user · …` (from ADR-029). Each affected user gets one DM about their interrupted jobs.
- [ ] Smoke-test (b) with a kill -9: `kill -9 $(cat ~/bot/.bot.pid)` (status='generating' rows survive in DB). Watchdog respawns. Boot scan picks up `'generating'` rows and DMs users — even though shutdown handler never ran. Confirms the fallback path.
- [ ] After boot scan, all rows previously in `'generating'`/`'interrupted'` are now `'failed'`. `sqlite3 ~/bot/db.sqlite "SELECT status, COUNT(*) FROM jobs GROUP BY status"` shows zero `'interrupted'`, zero `'generating'` (modulo any job started since boot).

---

# Build Step Sysstatus-Preflight — boot preflight + always-on file logging + failure-streak alert + /sysstatus (ADR-031)

*Hours after the previous shipping push, every Telegram-side job silently failed with `spawn claude ENOENT`. Bot was responding, watchdog said healthy, /healthz returned 200, daily log file didn't exist. RCA: sibling job-intake's web.server spawned the bot with a stripped PATH, AND dev-mode pino was writing to stdout (which web.server captured into its own log file) instead of the expected `~/bot/logs/$(date +%Y-%m-%d).log`. No layer caught the degradation because the watchdog only checks heartbeat freshness. Fix in four parts: (1) PATH augmentation at boot, (2) always-on daily-file logging, (3) failure-streak alert, (4) /sysstatus human-layer command.*

## SP.1 — Boot preflight (`src/preflight.ts`) (15 min)
- `augmentPath()` prepends `~/.local/bin`, `~/.local/share/fnm/aliases/default/bin`, `/opt/homebrew/bin`, `/usr/local/bin` to `process.env.PATH`. Idempotent — order-preserving dedup.
- `runPreflight()` runs `command -v claude`, `command -v pandoc`, `command -v typst` and `<cmd> --version` for each.
- On success: `event: 'preflight_ok'` log with resolved paths + version lines.
- On failure: `level: fatal, event: 'preflight_failed'` AND `dmAdminsIfPreflightFailed()` posts a single DM to admins with which CLI is missing and the augmented PATH so the supervisor that mis-configured them can be identified.
- Called as the FIRST thing in `src/index.ts` (before middleware, handlers, bot.start). Bot keeps booting even on failure so admins can still drill in via /sysstatus.

## SP.2 — Always-on file logging (`src/logger.ts`) (5 min)
- Dev mode now uses a `transport.targets` array: `pino-pretty` to stdout AND `pino/file` to `LOG_DIR/YYYY-MM-DD.log` (mkdir true).
- Prod mode unchanged — `pino.destination` to the same file.
- Invariant: `~/bot/logs/$(date -u +%Y-%m-%d).log` exists and is being written to as long as the bot is running, regardless of who owns the bot's stdout.

## SP.3 — Failure-streak alert (`src/failureStreak.ts`) (15 min)
- Threshold: ≥3 of the last 5 jobs (across all chats) failed within the last 1h.
- Cooldown: 30 min, persisted to `~/bot/.failure-streak-alert.json`.
- Called from `runJob`/`runEdit` `finally` blocks (alongside the existing `checkAndAlertIfOver80` budget check).
- DM body includes a sample of the failed `job_id`s and the most recent failed row's chat_id + timestamp, plus a hint pointing at `/sysstatus` for diagnosis.
- Does NOT crash the bot or fail the user-facing reply; pure side-channel observability.

## SP.4 — /sysstatus admin command (`src/handlers/sysstatus.ts`) (20 min)
- Single-message HTML reply with five sections:
  - **Runtime:** pid, uptime, NODE_ENV, today's daily log file (✅/❌ + size), heartbeat age vs 180s threshold.
  - **Binaries:** claude/pandoc/typst resolved path + first version line OR ❌ "not on PATH".
  - **Workers:** watchdog last-log mtime ("3m ago"), backup last-log mtime + tarball count on disk.
  - **Jobs (24h):** count grouped by status with status emoji (🟢 ready, ⚪️ archived, 🔴 failed, 🟡 generating, 🟠 interrupted); recent 5 failed jobs.
  - **Disk:** users / logs / backups / archive footprint via `du -sk`.
- Registered in `src/index.ts` (`bot.command('sysstatus', sysstatusHandler)`), added to `ADMIN_COMMAND_MENU`, allowlisted in `ONBOARDING_COMMANDS`.

## SP.5 — Smoke checklist
- [ ] Bot startup log shows `event: "preflight_ok"` with `claude_version: "2.x.y (Claude Code)"`. If `event: "preflight_failed"`, admin chat has a `🚨 Bot booted in a degraded state` DM with the broken PATH.
- [ ] `~/bot/logs/$(date -u +%Y-%m-%d).log` exists, is being written to (`tail -f` shows JSON lines), even when the bot is started by a parent process that captures stdout (test by running `npm start > /tmp/cap.log 2>&1 &` and confirming the daily file still grows).
- [ ] `/sysstatus` (admin) returns the five-section snapshot. Each section renders correctly with at least one emoji marker. Run on a healthy bot → no ❌. Run after `mv ~/.local/bin/claude /tmp/`-style break → `claude: ❌ not on PATH` line shows up.
- [ ] Failure-streak smoke: temporarily break claude (`mv ~/.local/bin/claude /tmp/claude.bak`), have a friend send 3+ JDs in quick succession, all fail. Within seconds of the 3rd failure, admins get `🚨 Failure streak detected` DM. Restore claude. 30 min later, the same scenario alerts again (cooldown lapsed).
- [ ] `/sysstatus` "today's log" shows ✅ + nonzero size after running the bot through stdout-capturing parent (`web.server`, `nohup ... > /dev/null`, etc.).
