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

## Out of scope (current)

- Restore-from-tarball for archived jobs (ADR-010 noted).
- Multi-resume support per user.
- Scheduled posting (cron-trigger on a saved JD).
- Pre-commit doc-check git hook (manual `npm run docs:sync` only).
- Two-stage classifier (lever c) — superseded by lever A.
