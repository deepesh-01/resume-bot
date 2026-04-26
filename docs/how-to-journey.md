# Resume Tailoring Bot — Operating Guide

*Status: shipped, v1 + lever A · Updated 2026-04-26*

A private Telegram bot that tailors your resume to specific job descriptions. Send a URL or paste a JD, get a tailored PDF back. Reply with edits to refine. Promote good edits back into your base resume with `/save`.

---

## What you actually have

**Three running pieces:**
1. **Telegram bot** (`@jdrBuilderBot`) — the user-facing surface
2. **Bot process** (Node.js, on your laptop) — handles incoming messages, orchestrates everything
3. **Claude Code CLI** (`claude -p`) — does the actual tailoring/critique/refinement work

**Three persistence layers:**
1. **SQLite** at `~/bot/db.sqlite` — users, jobs, usage, allowed_users, pending_access, blocked_users
2. **Per-user workspaces** at `~/bot/users/<chat_id>/` — base_resume.md, CLAUDE.md, context.md, jobs/
3. **Archive** at `~/bot/archive/<chat_id>/<job_id>.tar.gz` — jobs idle >30 days

**One critical innovation past v1:** every job runs a 3-pass quality loop (tailor → critic → refinement) when score < 80 or invented claims are found.

---

## Quick start (~3 min)

You're already onboarded. Daily flow:
1. **Paste a JD or send a URL** to `@jdrBuilderBot`.
2. **Get a tailored PDF** in ~3 minutes with a quality score.
3. **Reply with edits** ("make summary punchier", "lead with security") to refine — short text routes immediately as edits.
4. **`/save`** to promote good wording back into your base resume.
5. **`/done`** when satisfied.

---

## Prerequisites (one-time)

### System
- macOS or Linux (`tar`, `pandoc`, `typst`, `claude` in PATH)
- Node 20+, npm
- `pandoc` (`brew install pandoc`)
- `typst` (`brew install typst`) — 0.14.x tested
- Inter font (`brew install --cask font-inter`) — recommended
- Claude Code CLI (`claude --version`) authenticated

### Telegram bot
- Created via `@BotFather` (`/newbot`)
- `/setprivacy` → Disable (so the bot reads non-command text)
- `/setcommands` (optional, for autocomplete) — see `Commands` section

### Files
- `.env` at `~/Documents/resume-builder/` populated (see Setup)
- `~/bot/secrets/li_cookies.json` (currently NOT loaded — see ADR-002 — but kept for future flows)

---

## Setup

### Layout
- **Code:** `~/Documents/resume-builder/` (TypeScript, NodeNext ESM)
- **Workspace data:** `~/bot/` (separate, never wiped by code-clean operations)
- **Docs:** `~/Documents/resume-builder/docs/` (this file, `tasks.md`, `decisions.md`, `resume-bot-design.md`). Symlinked to `~/Documents/resume-builder/` for backward compat.

### `.env`
```ini
TELEGRAM_BOT_TOKEN=<from @BotFather>
ALLOWED_CHAT_IDS=<owner chat_id>
ADMIN_CHAT_IDS=<owner chat_id>     # subset of ALLOWED_CHAT_IDS, can run admin commands
OWNER_CHAT_ID=<same as above>
WORKSPACE_ROOT=/Users/deepeshz2/bot/users
TEMPLATES_DIR=/Users/deepeshz2/bot/templates
LOG_DIR=/Users/deepeshz2/bot/logs
DB_PATH=/Users/deepeshz2/bot/db.sqlite
PLAYWRIGHT_LINKEDIN_COOKIE_PATH=/Users/deepeshz2/bot/secrets/li_cookies.json
NODE_ENV=development
QUALITY_THRESHOLD=80               # critic threshold; refinement below this
```

### Boot
```bash
cd ~/Documents/resume-builder
npm install
npm run init-workspace          # mkdirs ~/bot/{users,archive,logs,templates,secrets}, chmod 700
npm run build
npm start                       # runs node dist/index.js
```

For development: `npm run dev` (tsx watch).

### Caffeinate (Mac)
The bot only runs while your laptop is awake. To keep awake while the bot is running:
```bash
caffeinate -dims -w $(pgrep -f "node dist/index.js")
```
Or use `launchd` for a proper daemon.

---

## The bot in 5 routing layers

When a text message arrives, the handler walks these in order:

1. **`/save` selection pending?** → parse "1 3 5" / "all" / "none" / typo retry
2. **URL match (`^https?://`)?** → clear any pending, run new job from URL
3. **Disambig pending?** → append text to buffer, refresh the prompt's word count
4. **Active job + short text (<70 words)?** → run as edit on that job
5. **Long text (≥70 words) + active job?** → open disambig prompt with [Edit] [New] [More coming]
6. **No active job?** → run new job (pasted JD)

This layering is **why split pastes work cleanly**: layer 5 opens a buffer; subsequent messages hit layer 3, append, the prompt updates with the new word count. User clicks [Process] when complete. No debouncer, no guessing.

---

## Full command reference

### Public (in /help)

| Command | What |
|---|---|
| `/start` | Begin onboarding (if non-allowlisted: trigger access request flow) |
| `/help` | This reference |
| `/confirm` | Accept extracted resume during onboarding |
| `/reupload` | During onboarding: re-upload the staged file. After onboarding: confirmation prompt → clears base_resume + onboarded=0 (keeps context.md, jobs) |
| `/reonboard` | Full reset: clears base_resume + CLAUDE.md + context.md, archives active jobs |
| `/context` | (no args) show current `context.md`. (with text) write `context.md` |
| `/status` | Active job + score + recent 5 jobs + 24h spend |
| `/jobs` | Recent ~30 jobs with status emoji + quality score + time-ago |
| `/edit JOB_ID instruction` | Reactivate an old job and run an edit pass on it |
| `/reset` | End the current job (archives row; reversible) |
| `/reset JOB_ID` | Confirmation prompt → wipe job dir + DB rows for that job |
| `/done` | Finalize current job (replies with the §13.6 finalize string) |
| `/save` | Diff active job's resume.md vs base_resume.md → numbered hunks → reply with selection |

### Admin (gated by `ADMIN_CHAT_IDS`, NOT in /help)

| Command | What |
|---|---|
| `/pending` | List active access requests (codes, usernames, expiries) |
| `/allow CODE` | Approve a pending request (manual fallback to the inline button) |
| `/deny CODE` | Reject a pending request |
| `/users` | List all allowed users + blocked users |
| `/revoke CHAT_ID` | Remove from allowed_users + archive their active jobs + DM |
| `/block CHAT_ID [reason...]` | Same as revoke + adds to blocked_users + DM with the block notice |
| `/unblock CHAT_ID` | Remove from blocked_users (does NOT re-grant; they need to /start again) |

### Headless CLI (System B integration, ADR-021)

Not a Telegram command — a separate entry point compiled to
`dist/cli-tailor.js`. Used by the sibling `job-intake` project to
produce a tailored resume PDF for a JD without going through Telegram.

```sh
node dist/cli-tailor.js \
  --jd-path /path/to/job_description.md \
  --chat-id 1089113785 \
  [--output-dir /path/to/copy/pdf/to] \
  --output-format json
```

Outputs one JSON line on stdout: `{ok, pdf_path, last_change, score,
refinement_applied, duration_ms, error}`. Reuses the same tailoring +
critic + refinement pipeline as the bot. Does not write to the SQLite
DB. Per-job workspace lands in `~/bot/users/<chat_id>/jobs/<job_id>/`
alongside bot-created jobs.

### Reply-to-prompt selections (no slash)

- After `/save`: type `1 3 5`, `all`, or `none`
- After disambig prompt: tap an inline button — [📄 Process / New job / Edit current job] / [⏳ More coming]
- After `/reset JOB_ID` confirmation: tap [🗑️ Wipe job] / [❌ Cancel]
- After `/reupload` (post-onboarding) or `/reonboard` confirmation: tap [✅ Yes ...] / [❌ Cancel]
- After friend onboarding admin notification: tap [✅ Approve · 7 days] / [❌ Reject]

---

## Flows

### Onboarding (first-time user)
1. `/start` → bot replies with the §13.6 onboarding prompt
2. Upload resume (PDF/DOCX/MD)
3. Bot extracts to `base_resume.md`, replies with first 500 chars + "/confirm or /reupload"
4. `/confirm` → CLAUDE.md template (§13.4 + ADR-013/015 extensions) written to user's dir, `users.onboarded = 1`

### Tailoring (URL or paste)
1. Send URL or paste JD text (≥200 chars)
2. **Tailor pass** (§13.1 invocation A): claude -p with cwd=jobDir, edits resume.md in place, writes last_change.txt
3. **Critic pass** (lever A, type D): claude reads files, scores 0-100, lists gaps + violations, JSON output
4. **Refinement** (type E, --resume): only if score < 80 OR violations exist; applies critic's gap+violation list to resume.md
5. **Render**: pandoc → resume_body.typ, copy templates/resume.typ → resume.typ, typst compile → final.pdf
6. **Reply**: PDF doc + caption "v1 ready. {summary} · 🎯 {score}/100 (refined)" + follow-up message with attribute scores, gaps addressed, claims removed

Total time: ~2-3 min per job. Cost: ~$0.70-1.00.

### Editing
- **Implicit (short text + active job):** routes through layer 4 → `runEditFlow` → claude --resume with the instruction → re-render → updated PDF with "Updated. {summary}" caption.
- **Explicit (`/edit JOB_ID instruction`):** reactivates the specified job (sets status=ready, touches last_active_at), then runs the edit. Subsequent short text edits land on this job.

### Save to base
1. `/save` on an active job
2. Bot computes structured diff (npm `diff` lib), labels each hunk with its enclosing `## Section`
3. Reply: numbered list of hunks (max 25 shown), e.g.:
   ```
   [1] SUMMARY: "Backend engineer" → "Founding Engineer..."
   [2] SKILLS: + "AI-augmented development (Cursor, Claude)"
   ...
   ```
4. Reply with `1 3` / `all` / `none`
5. `applyPatch` with selected hunks → write back to `base_resume.md`
6. Reply: "Base updated. N changes applied."

### Friend onboarding
**Friend side (one tap after `/start`):**
1. Friend `/start`s the bot.
2. Bot replies "🔐 Access request sent to admin. You'll be notified when approved."

**Admin (you) side:**
3. Bot DMs you in your existing chat: "🔔 New access request · From: @friend · Code: ABC123 (24h) · [✅ Approve · 7 days] [❌ Reject]"
4. Tap [✅ Approve] → bot adds friend to `allowed_users` (expires_at = now+7d), DMs friend "✅ Welcome! Send /start to begin onboarding."
5. Friend `/start`s again → onboarding flow proceeds.

**Fallback admin commands** (if buttons fail):
- `/pending` to list active codes
- `/allow CODE` / `/deny CODE`

**Block/revoke:** `/users` (see all), `/revoke CHAT_ID` (soft, can re-request), `/block CHAT_ID reason` (hard, can't reach access flow), `/unblock CHAT_ID`.

### Job management
- `/jobs` — full listing
- `/status` — active + recent 5 + 24h spend
- `/reset` — archive current active job (reversible)
- `/reset JOB_ID` — destructive wipe with confirmation; deletes workspace dir + DB rows
- `/edit JOB_ID instruction` — reactivate + edit

### Reset and reonboard
- `/reupload` (post-onboarding): replace base resume only. Keeps context.md, jobs, history. Confirmation prompt.
- `/reonboard`: full wipe. Clears base_resume + CLAUDE.md + context.md, archives active jobs. Confirmation prompt. Old job dirs stay on disk for history.

### Archive cron
Runs once on bot startup, then every 24h. Finds jobs with `last_active_at > 30 days` AND `workspace_path NOT NULL`, tar.gzs the workspace into `~/bot/archive/<chat_id>/<job_id>.tar.gz`, removes the workspace dir, sets `workspace_path = NULL`. DB row stays (history visible in `/jobs`/`/status`).

---

## Quality gate (lever A) — the 10x lever

The critic is **read-only** (`--allowedTools Read`) and outputs structured JSON:
```json
{
  "score": 76,
  "attributes": [{"name": "Customer onboarding & tenant lifecycle", "score": 8, "rationale": "..."}, ...],
  "gaps": ["specific gap 1", ...],
  "violations": ["claim that isn't in resume.md/base/context.md", ...]
}
```

**What good looks like (in the bot's chat output):**
- Score in caption: `🎯 88/100 (refined)`
- Follow-up message with attribute breakdown (e.g. "Customer onboarding & tenant lifecycle automation: 10/10")
- Gaps addressed list (only when refinement ran)
- Unsupported claims removed list (rule #2 violations the agent invented and the refinement scrubbed out)

**Tuning:** `QUALITY_THRESHOLD=80` in `.env`. Higher → more refinements, slower, sharper. Lower → fewer refinements, faster, cheaper.

**Critic vs refinement vs base tailoring** are three claude calls; cost is ~$0.70-1.00 per job vs ~$0.40 baseline. Trade-off worth it (per ADR-014).

---

## Architecture overview

```
┌────────────────┐
│ Telegram client│
└──────┬─────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ src/index.ts                         │
│   ↓ register middleware + handlers   │
│ src/middleware/                      │
│   allowlist  → blocked? allowed? request? reject  │
│   preOnboarding → onboarded? command-allowed?     │
│ src/handlers/                        │
│   start, help, confirm, reupload,    │
│   reonboard, context, status, jobs,  │
│   edit, reset, done, save,           │
│   document, jobMessage,              │
│   accessRequest, accessApproval,     │
│   admin (pending/allow/deny/users    │
│         /revoke/block/unblock),      │
│   resetActions, resetJob, callbacks  │
└────────────┬─────────────────────────┘
             │
       ┌─────▼──────────────────────┐
       │ src/runJob.ts              │
       │   tailor (A) → critic (D)  │
       │   → refine (E)             │
       │   → render (typst)         │
       │   → reply with PDF         │
       └─────┬──────────────────────┘
             │
       ┌─────▼──────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
       │ src/claude │ │ scrape │ │ render   │ │ saveDiff │
       │   (spawn)  │ │ (PWT)  │ │ (typst)  │ │ (diff)   │
       └────────────┘ └────────┘ └──────────┘ └──────────┘
```

**Key files:**
- `src/index.ts` — wiring, boot order
- `src/bot.ts` — grammY Bot instance, ctx logger, error handler
- `src/db.ts` — schema, migrations, all DB helpers
- `src/config.ts` — env validation
- `src/runJob.ts` — main job orchestration including critic+refine
- `src/runEdit.ts` — edit flow (--resume)
- `src/claude.ts` — claude CLI wrappers (runTailoring, runEdit, runCritic, runRefinement)
- `src/scrape.ts` — Playwright + stealth (no cookies per ADR-002)
- `src/render.ts` — pandoc + typst pipeline (tectonic fallback)
- `src/jobs.ts` — job ID generation, workspace creation
- `src/saveDiff.ts` + `src/handlers/save.ts` — /save flow
- `src/archiveCron.ts` — daily sweep
- `src/access.ts` — admin notify, code generation
- `src/disambiguate.ts` + `src/savePending.ts` — pending-state stores
- `src/middleware/allowlist.ts` + `preOnboarding.ts` — gates
- `src/textDebounce.ts` — REMOVED (ADR-016 superseded it)

---

## Debugging

### Where logs live
- Dev: stdout (pino-pretty)
- Prod: `~/bot/logs/<YYYY-MM-DD>.log` (pino JSON)

Useful greps:
```bash
LOG=~/bot/logs/$(date +%Y-%m-%d).log
tail -f $LOG | npx pino-pretty
grep '"event":"job_failed"' $LOG | tail -5
grep '"event":"critic_done"' $LOG
grep -A2 '"event":"render_ok"' $LOG | tail -10
```

### Inspect DB
```bash
sqlite3 ~/bot/db.sqlite '.tables'
sqlite3 ~/bot/db.sqlite 'SELECT job_id, status, role, company, quality_score FROM jobs ORDER BY created_at DESC LIMIT 10;'
sqlite3 ~/bot/db.sqlite 'SELECT chat_id, expires_at FROM allowed_users;'
sqlite3 ~/bot/db.sqlite 'SELECT chat_id, reason FROM blocked_users;'
sqlite3 ~/bot/db.sqlite 'SELECT job_id, invocation_type, total_cost_usd FROM usage ORDER BY created_at DESC LIMIT 20;'
```

### Inspect a job's workspace
```bash
JID=20260426_linkedin_4
ls -la ~/bot/users/<chat_id>/jobs/$JID/
cat ~/bot/users/<chat_id>/jobs/$JID/last_change.txt
```

### Resume claude session manually
```bash
SID=$(sqlite3 ~/bot/db.sqlite "SELECT session_id FROM jobs WHERE job_id='$JID';")
cd ~/bot/users/<chat_id>/jobs/$JID/
claude --resume "$SID"
```

### Telegram updates queue
If the bot is offline, updates queue at Telegram. To inspect:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?offset=-5" | python3 -m json.tool
```
Note: this consumes updates if the bot isn't running. Don't run while bot is running.

---

## Self-healing: heartbeat + watchdog (ADR-022)

The bot has two-part auto-recovery:

**Heartbeat** — bot writes current epoch ms to `~/bot/.heartbeat` every 60s while running.

**Watchdog** — `scripts/watchdog.sh` runs every 2 minutes via launchd:
- If no bot process matching this repo's `cwd` exists → restart
- If heartbeat file is older than 180s → kill stuck bot + restart
- After any restart: DMs admin via Telegram with the reason

**Install once:**
```bash
bash scripts/install-watchdog.sh
```
Loads `~/Library/LaunchAgents/com.deepesh.resume-bot-watchdog.plist`. Survives logout. Unload with `bash scripts/uninstall-watchdog.sh`.

**Verify it's running:**
```bash
launchctl print "gui/$(id -u)/com.deepesh.resume-bot-watchdog" | grep state
tail -f ~/bot/logs/watchdog.log
```

**What you'll see in your Telegram chat:**
- Nothing during normal operation.
- `🔄 Bot was hung (heartbeat 245s stale, threshold 180s). Watchdog killed and restarted.` when a hang is auto-recovered.
- `🔄 Bot was down (no process running). Watchdog restarted it.` after a crash.

**What it doesn't catch:** laptop entirely off. For that, add an external dead-man's-switch (e.g., Healthchecks.io ping every hour from the bot itself — see ADR-022 consequence).

**macOS permission gotcha:** `~/Documents/` is gated by macOS's "Files & Folders" privacy. launchd-spawned bash gets `Operation not permitted` when it tries to read `scripts/watchdog.sh`. Fix once: System Settings → Privacy & Security → Full Disk Access → click + → Cmd+Shift+G → type `/bin/bash` → add it. Re-run `bash scripts/install-watchdog.sh`. Verify: `launchctl print "gui/$(id -u)/com.deepesh.resume-bot-watchdog" | grep "last exit"` should show `0`. If `126`, permission still missing.

---

## External trigger: HTTP endpoints (ADR-023)

For third-party uptime monitors (UptimeRobot, BetterUptime, Healthchecks.io, custom) to check liveness AND trigger restart on hang, the bot exposes:

- `GET http://127.0.0.1:8787/healthz` — no auth. 200 if heartbeat fresh, 503 if stale (>180s) or missing. JSON body includes `heartbeat_age_ms` so monitors can graph it.
- `POST http://127.0.0.1:8787/restart` — requires `X-Watchdog-Token` header matching `WATCHDOG_RESTART_TOKEN` env. On match: 202 + bot exits → launchd watchdog respawns within 2 min.

**Bound to 127.0.0.1 only.** Expose to the internet deliberately via:
- **Cloudflare Tunnel** (recommended; persistent, free): `cloudflared tunnel --url http://127.0.0.1:8787`
- **ngrok**: `ngrok http 8787`
- **SSH reverse tunnel** to a VPS: `ssh -R 8787:localhost:8787 user@vps`

**Generate a strong token:**
```bash
openssl rand -hex 32
# add to .env: WATCHDOG_RESTART_TOKEN=<output>
```
Leaving it empty disables the `/restart` endpoint entirely (returns 501).

**Test from same laptop:**
```bash
curl -s http://127.0.0.1:8787/healthz
TOKEN=$(grep '^WATCHDOG_RESTART_TOKEN=' .env | cut -d= -f2-)
curl -X POST -H "X-Watchdog-Token: $TOKEN" http://127.0.0.1:8787/restart
```

**Disable the HTTP server entirely:** set `HEALTH_PORT=0` in `.env`.

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Bot doesn't reply | Process down, or 409 conflict (duplicate poller) | `pgrep -f "node dist/index.js"`, kill duplicates, restart |
| `bot.start()` exits with 409 | Another instance was polling | Single-instance only — `kill` the other |
| LinkedIn auth-walls | LinkedIn flagged session — see ADR-002/003 | Wait or use paste-text fallback. Cookies are intentionally NOT loaded; do not "fix" by re-enabling cookies |
| `CLAUDE_TIMEOUT` | claude exceeded the per-call hard timeout | Tailor: 5min, edit/refine: 4min, critic: 90s. If recurring, check claude CLI auth + network |
| `CLAUDE_AUTH` (DMs owner) | claude CLI lost auth | Open a terminal where the bot runs, run `claude` interactively, log back in |
| `CLAUDE_RATE_LIMIT` | Subscription cap hit | Wait. The bot tells the user to retry in N hours |
| Job stuck after `render_ok` log | grammY `replyWithDocument` hung — see ADR-012 | Now bounded by 60s timeout. If pre-fix, restart unblocks; PDF is on disk and recoverable via curl |
| `/save` "patch context mismatch" | base_resume.md changed since the diff was computed | Run `/save` again to regenerate the diff |
| Telegram "0 KB / X KB" with X icon on a file | Telegram client tap-to-download UI for non-rendered MIME types | Tap to download. PDFs render natively; markdown files don't |

---

## Operations

### Running
- Foreground: `cd ~/Documents/resume-builder && npm start` in tmux
- Or `npm run dev` for hot-reload during development
- One instance only. Multiple = 409 Conflict on getUpdates

### Updating
```bash
cd ~/Documents/resume-builder
git pull   # if you've git-init'd
npm install
npm run build
# kill old, restart
PID=$(ps -eo pid,command | grep -E "node dist/index.js$" | grep -v grep | awk '{print $1}')
[ -n "$PID" ] && kill -INT $PID
sleep 2
npm start &
```

### Backups
- `~/bot/db.sqlite` — the only stateful data that matters
- `~/bot/users/` — base_resume.md + context.md per user
- `~/bot/archive/` — historical job tarballs
- Time Machine covers it. For belt-and-suspenders:
  ```bash
  tar czf ~/Backups/bot-$(date +%Y%m%d).tgz ~/bot/{db.sqlite,users,archive}
  ```
- **Never sync `~/bot/secrets/`** to anything — credentials.

### Onboarding a friend
1. Friend opens `https://t.me/jdrBuilderBot` and taps Start.
2. You receive an inline-button DM. Tap [Approve · 7 days].
3. Friend gets the welcome DM and runs `/start` to begin resume upload.

### Renewing friend access
- 7-day expiry → friend `/start`s again → fresh approval request → tap approve. Done.

### Cost tracking
```bash
sqlite3 ~/bot/db.sqlite "
SELECT
  date(created_at) AS day,
  SUM(total_cost_usd) AS spent,
  COUNT(*) AS calls
FROM usage
WHERE created_at >= datetime('now','-7 days')
GROUP BY day
ORDER BY day DESC;
"
```

### Decommissioning
1. Stop the bot (Ctrl-C or kill PID)
2. (Optional) `tar czf ~/Backups/bot-final-$(date +%Y%m%d).tgz ~/bot/`
3. (Optional) `rm -rf ~/bot/`
4. `@BotFather` → `/deletebot` to revoke the token
5. `rm -rf ~/Documents/resume-builder/`

---

## Resilience guarantees

- **Per-API-call timeout** (60s, ADR-012) — no more bot-stall on a swallowed Telegram response
- **Critic + refinement degrade gracefully** — failure logs `critic failed; skipping quality gate` and ships v1 anyway
- **Mutex per chat_id** — same-user requests serialize; different users run concurrently
- **Patch context fuzz factor 2** — `/save` tolerates minor whitespace drift
- **Schema migrations idempotent** — `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` swallowed if duplicate
- **Tarball archives preserved** — DB workspace_path NULL'd but tar.gz keeps everything
- **Friend session auto-expires** — no permanent-access drift
- **Block check before allow check** — blocked users can't even reach the access-request flow
- **Admin self-protection** — `/revoke` and `/block` refuse on admin chat_ids

---

## Deferred / open items

- **Restore-from-tarball** for archived jobs — currently `/edit JOB_ID` on an archived job tells you to `/reset` and re-run from JD; could instead untar and reactivate
- **Multi-resume support** — single `base_resume.md` per user. Could add named variants (e.g. `base_resume_backend.md`, `base_resume_ml.md`) and a `/setbase NAME` command
- **Scheduled posting** — fire a JD URL on a schedule; not yet wired
- **Pre-commit doc check** — see `scripts/docs-sync.sh` and the project CLAUDE.md; currently manual run
- **Re-critique after refinement** — currently we trust the refinement; could re-score for transparency at +$0.20-0.40/job

---

## Companion docs

- **`tasks.md`** — chronological build log, by step, with smoke checklists
- **`decisions.md`** — architecture decision records (ADRs) with rationale
- **`resume-bot-design.md`** — original v1 design spec (frozen as historical reference)
- **`~/Documents/resume-builder/CLAUDE.md`** — instructions for AI dev sessions on this codebase (auto-discovered)
- **`~/Documents/resume-builder/scripts/docs-sync.sh`** — claude-driven doc audit + update tool

When you build a new feature: update `how-to-journey.md`, append to `decisions.md` if the choice was non-obvious, and (if you've git-init'd) commit them in the same change. Or run `npm run docs:sync` to have claude do it for you.
