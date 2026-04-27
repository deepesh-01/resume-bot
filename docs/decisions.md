# Architecture Decisions

*A log of non-obvious choices made during the build, with reasoning so future-you (or a collaborator) can reconstruct the why. New decisions go at the bottom.*

---

## ADR-001 · Typst over LaTeX for PDF rendering
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** A PRD proposed switching from `pandoc → typst` to `pandoc → tectonic LaTeX` for "Overleaf-grade typesetting".

**Decision.** Keep Typst.

**Reasoning.**
- Typst is a peer of LaTeX, not a step down. Same microtypography (kerning, ligatures), same hot-metal-quality output. A hiring manager cannot distinguish a Typst-generated PDF from a `moderncv` LaTeX one.
- Typst compiles in **~1 second**; Tectonic adds ~5-10s on first run while it downloads packages.
- Typst's error messages are surgical (line/column pinpoint); LaTeX's are notoriously cryptic. The "self-healing loop" the PRD proposed (read .log, fix syntax, retry) is solving a problem we don't have, because pandoc emits valid Typst that compiles cleanly.
- Migration cost (~6 hr, plus tectonic ops complexity) buys no measurable quality gain.

**The PRD's actual 10x lever was orthogonal** — the "score-based quality gate" idea. We shipped that as ADR-014 (lever A). LaTeX vs Typst was engineering theater.

**Consequence.** Any future "switch to LaTeX" proposal needs to ship a concrete visible quality gap from a specific Typst run, not a generic claim.

---

## ADR-002 · Drop LinkedIn cookies from scrape requests
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Original §13 spec instructed loading a cookie file (`~/bot/secrets/li_cookies.json`) into the Playwright context for LinkedIn job pages.

**Decision.** Strip cookie loading. Public job pages (`/jobs/view/<id>`) are scraped anonymously.

**Reasoning.**
- Cookies become stale almost immediately (any login from another browser invalidates the original `li_at`). Stale cookies submit an "invalid session" pattern to LinkedIn.
- LinkedIn's bot detection treats "invalid session" as **higher-risk than no session**, triggering authwall redirects.
- Empirical: with cookies, 0/3 scrapes succeeded after the initial run flagged us. Without cookies + stealth plugin, **5/5 scrapes succeeded** consistently.
- Public job views don't need auth — the JD body is rendered for logged-out visitors.

**Consequence.** The cookie file path and config key are preserved in `.env` so future flows that legitimately need authenticated views (recruiter messages, member-only fields) can re-enable. For now: don't touch cookies.

---

## ADR-003 · Stealth plugin for Playwright
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Bare Playwright triggers LinkedIn's bot detection because automation fingerprints (`navigator.webdriver`, missing chrome runtime, permissions API quirks) are visible.

**Decision.** Use `playwright-extra` + `puppeteer-extra-plugin-stealth`.

**Reasoning.** Empirically the difference between consistent auth-walling and 5/5 success. Bare Playwright + cookies: ~0%. Stealth + cookies: ~30%. Stealth + no cookies: ~100% (combined with ADR-002).

**Consequence.** Two extra dependencies. The plugin is compatible with both pages and contexts; we apply it once at module load.

---

## ADR-004 · Critic threshold = 80, max 1 refinement
**Date:** 2026-04-26 · **Status:** Accepted, tunable via env

**Context.** Lever A (critic + auto-refinement) needs a quality threshold below which the system runs an automatic refinement pass.

**Decision.** Threshold 80/100 by default (env: `QUALITY_THRESHOLD`). Refinement runs at most once. No re-critique after refinement.

**Reasoning.**
- 80 captures most "good but not great" outputs. Lower (60-70) lets too much through; higher (90+) over-refines and most jobs cycle, doubling cost.
- Re-critiquing after refinement costs another claude call ($0.20-0.40) for marginal additional information; if the refinement was good, the score improves; if not, we'd loop forever.
- Trusting the refinement to help (without verification) keeps the loop bounded at 3 calls (tailor + critic + refine) and ~$0.70-1.00 per job.

**Consequence.** Score in caption is the **pre-refinement** score, with a `(refined)` indicator. Users know it was likely better than that number suggests.

---

## ADR-005 · 70-word threshold for "is this a JD or an edit?"
**Date:** 2026-04-26 · **Status:** Accepted, tunable via constant

**Context.** When a user has an active job and sends new text, is it an edit instruction or a new JD? Telegram clients also split long pastes into multiple messages, fragmenting JDs.

**Decision.** Long text (≥70 words) + active job → present a 3-button prompt asking intent. New messages while pending → append to buffer + update prompt. Short text (<70 words) routes immediately as edit.

**Reasoning.**
- 70 words is below most pasted JDs (typically 200+) and above most natural-language edit instructions ("trim summary to 1 line", "add Stripe to skills" are <30 words).
- The "More coming" button **handles split pastes naturally**: Msg A triggers prompt, Msg B appends to buffer + updates prompt count, user clicks Process when complete. No need for a debouncer (which we tried and abandoned for being a guess-the-cadence band-aid).
- Threshold is conservative enough that long edit instructions ("Lead with founding-engineer track record. Reframe security/compliance...") may trigger the prompt, but the user can just tap [Edit current job] — minor friction.

**Consequence.** Routing is layered: Save-pending → URL → Disambig-pending → short text → long text. Each layer is one if-block; no race conditions because grammY processes updates sequentially.

---

## ADR-006 · Friends 7-day session, admins permanent
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Allowlist must support both seeded admins (the owner) and rolling friend access.

**Decision.** `allowed_users.expires_at`: NULL = permanent (admins, pre-seeded), datetime = revoke at this point (friends, 7 days). Both seeded from `ADMIN_CHAT_IDS` and `ALLOWED_CHAT_IDS` env vars at boot.

**Reasoning.**
- 7 days balances "convenient enough to not hit the approval flow constantly" with "if a friend stops using the bot, their access naturally expires".
- Renewal is automatic: friend `/start`s after expiry → new pending request → admin re-approves.
- Permanent admins can't accidentally have their session expire and lock themselves out.
- `/revoke` and `/block` admin commands explicitly refuse to act on admin chat_ids — defense in depth.

**Consequence.** Any future "tier" of access (e.g. paid users) just becomes another expires_at policy.

---

## ADR-007 · Inline keyboard buttons over text replies for confirmations
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Several flows need confirmation: friend approval, /reupload (post-onboarding), /reonboard, /reset JOB_ID, the "complete or more coming" disambig prompt, /save selection.

**Decision.** Inline keyboard buttons for binary/trinary choices (approve/reject, yes/cancel). Text reply for selection from a numbered list (/save).

**Reasoning.**
- One-tap UX on mobile.
- Callback data (`access:approve:CODE`, `pend:new`, etc.) is unambiguous — no parsing of "yes"/"y"/"YES" variants.
- For /save's numbered hunks (potentially 20+), buttons would be unwieldy; freetext "1 3 5"/"all"/"none" is cleaner.

**Consequence.** A single `callback_query:data` handler (`callbackRouter`) dispatches by prefix. Adding a new button-driven flow = pick a unique prefix and add to the dispatcher.

---

## ADR-008 · Per-user mutex via `Map<chat_id, Promise>`
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Concurrent jobs from the same user would collide (same workspace dir, race on resume.md). Different users should run concurrently — they have separate workspaces.

**Decision.** In-memory mutex keyed by `chat_id`. New requests chain after the previous promise resolves. No cross-user serialization.

**Reasoning.**
- N=3-5 friends, single laptop, single Claude Code subscription. The actual bottleneck is claude's per-account rate limit, not the mutex.
- A real queue (Redis, etc.) would be over-engineering at this scale.
- In-memory state is lost on restart — but restart implies job interruption anyway, so users would re-send.

**Consequence.** Mutex doesn't apply across grammY's update routing layer (URL detection, save-pending check). Long-running runJob calls hold the lock until they complete — this is fine.

---

## ADR-009 · grammY default sequential update processing
**Date:** 2026-04-26 · **Status:** Implicit, depended on

**Context.** When a user pastes a long JD that Telegram splits into Msg A + Msg B, both arrive at the bot in quick succession.

**Decision.** Rely on grammY's default `bot.start()` behavior, which processes updates sequentially within a poll cycle.

**Reasoning.**
- Sequential processing means Msg A's `jobMessageHandler` fully runs (including setting save-pending or disambig-pending state) **before** Msg B's handler sees the chat.
- This makes append-to-buffer logic deterministic without explicit locking.
- Concurrent processing would require additional in-memory locking around pending state mutations.

**Consequence.** If we ever need higher throughput (concurrent processing across many users), this assumption breaks. For N=5 users this is fine. Documented here so the limitation is visible.

---

## ADR-010 · 30-day archive idle threshold
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Job workspaces accumulate on disk. We need a cleanup policy.

**Decision.** Daily sweep finds `jobs.last_active_at < now - 30d AND workspace_path IS NOT NULL`, tar.gzs the workspace into `~/bot/archive/<chat_id>/<job_id>.tar.gz`, removes the working dir, sets `workspace_path = NULL`.

**Reasoning.**
- 30 days = realistic upper bound on "I might still want to revisit this job".
- DB rows are preserved (history visible in `/jobs` and `/status`); only on-disk workspace is reclaimed (~50-100KB per job).
- Tarballs preserve everything (`final.pdf`, `resume.md`, `resume.typ`, `last_change.txt`, etc.) for manual archaeology.
- `/edit JOB_ID` on an archived (workspace-cleared) job currently fails with a polite error suggesting `/reset` + re-run; v2 could offer a "restore from tarball" path.

**Consequence.** Disk usage grows linearly with active jobs only, not all-time job count.

---

## ADR-011 · Use native `tar` over pure-JS lib
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Archive cron needs to tar.gz workspace dirs.

**Decision.** Spawn `tar -czf ...` via `child_process`. No `node-tar` dependency.

**Reasoning.**
- `tar` is on every macOS / Linux box. No install.
- `node-tar` works fine but adds 5MB of node_modules for one operation.
- Native binary is faster on large dirs (negligible here, but principle).

**Consequence.** Bot only runs on systems with `tar` in PATH. macOS, Linux: yes. Windows: would need WSL or a different approach.

---

## ADR-012 · 60s API timeout on grammY client
**Date:** 2026-04-26 · **Status:** Accepted (post-incident)

**Context.** A `replyWithDocument` hung indefinitely on the linkedin_4 job — Telegram processed the upload, but our await never resolved. Bot dead-locked for 7 minutes until manual restart.

**Decision.** `client: { timeoutSeconds: 60 }` on the Bot instance.

**Reasoning.**
- grammY's default has no per-API-call wall-clock timeout; a swallowed response stalls forever.
- 60s is generous for any individual API call (sendMessage, sendDocument, getFile). PDF uploads usually finish in 1-2s.
- On timeout: error bubbles to outer try/catch in `runJob`, logged as `job_failed`, surfaced to user as a generic failure. Bot stays responsive.

**Consequence.** Any API call that genuinely takes >60s (very large file? slow upstream?) will fail. Acceptable trade-off.

---

## ADR-013 · CLAUDE.md regenerated on every job creation
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** When the CLAUDE.md template is upgraded (lever A), already-onboarded users have stale CLAUDE.md from their original `/confirm`.

**Decision.** `createJobWorkspace` writes `~/bot/users/<chat_id>/CLAUDE.md` from the current template constant on every job creation. Idempotent.

**Reasoning.**
- Picks up template upgrades for existing users without requiring `/reonboard`.
- Cheap (single file write per job).
- If a user hand-edits their CLAUDE.md, they'd lose the edit on the next job — accepted because we explicitly restrict CLAUDE.md to the in-code template per §13.10.

**Consequence.** The template is the single source of truth. Template changes propagate automatically to all new jobs across all users.

---

## ADR-014 · Lever A: Critic + auto-refinement (vs static prompting)
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Initial tailoring quality plateaued; the user critiqued specific gaps (Founding Engineer dilution, security framing as checkbox, missing Cursor/Copilot mention). The PRD proposed a LaTeX swap; we identified the actual lever as a quality scorecard.

**Decision.** Three-pass per job: tailor (A) → critic (D, read-only, JSON output) → refinement (E, --resume, applies critic's gap+violation list). Critic identifies 3-5 attributes from the JD, scores each, lists gaps and rule-#2 violations.

**Reasoning.**
- Single-pass tailoring is good but conservative; the critic explicitly hunts for invented claims and missing JD-emphasized angles.
- Score and gaps surfaced in the chat (caption + follow-up message) so the user sees what was caught.
- Doubles cost per job (~$0.40 → $0.70-1.00) but objectively sharper output.
- Gracefully degrades: if critic times out or returns malformed JSON, the bot ships v1 anyway.

**Consequence.** The critic's `attributes` list is the system's understanding of the JD's priorities. If a user wants different priorities, they can `/edit` the v1 with explicit guidance.

---

## ADR-015 · `context.md` as second source of truth
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** §13.4 CLAUDE.md hard rule #2 forbids invention. But many "true facts" about a candidate aren't in their resume document (side projects, off-resume metrics, infra they self-host). The agent has no source-of-truth file to draw from for these.

**Decision.** Per-user `~/bot/users/<chat_id>/context.md` is auto-copied into each new job's workspace. CLAUDE.md template instructs the agent to treat it as a SECOND source of truth alongside `resume.md`. Edited via `/context` command.

**Reasoning.**
- Solves "the agent can't surface what isn't in source data" without polluting the formal resume.
- User-controlled: the friend decides what facts to declare.
- Truth-anchored: still bound by rule #2 (no invention beyond resume + context).

**Consequence.** Quality of tailoring is now bounded by the QUALITY of context.md as much as base_resume.md. Critic's "violations" list often surfaces context.md drift (claims that combine truthful facts in not-quite-truthful ways).

---

## ADR-016 · Manual confirmation flow over message debouncer (for split pastes)
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Telegram splits pastes >4096 chars into multiple messages. Initial fix was a 3-second idle debouncer (auto-coalesce). The user pushed back: "rather than guessing, ask the user."

**Decision.** Long text (≥70 words) opens a pending state with a [Process now] [More coming, wait] prompt. Subsequent messages append to the buffer + update the prompt's word count. User explicitly clicks when complete.

**Reasoning.**
- Debouncer is a magic wait — wrong cadence breaks the UX.
- Manual confirmation is explicit; user is in control.
- Buffer-update pattern handles arbitrarily many messages.
- Doesn't add friction for short edits (which route immediately).

**Consequence.** A second long message arriving while pending is alive auto-appends — no separate "is this still the same JD?" decision.

---

## ADR-017 · `/save` uses `diff` library's structuredPatch + applyPatch
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** `/save` needs to: diff resume.md vs base_resume.md, present hunks numbered, let user pick a subset, apply only those.

**Decision.** Use `diff` (npm) `structuredPatch` for the diff and `applyPatch` for selective application. Section labels derived by walking back through baseLines for the most recent `## Header`.

**Reasoning.**
- `applyPatch` uses fuzzy context matching (tolerates minor whitespace drift).
- Subset application works because hunks are matched by their context lines, not absolute line numbers — applying hunks 1 and 3 (skipping 2) just leaves 2's lines unchanged in the result.
- Section labels make the numbered list legible (`SUMMARY: "old" → "new"` rather than raw `+`/`-` lines).

**Consequence.** v8 of the `diff` lib renamed `Hunk` → `StructuredPatchHunk`; lock or migrate explicitly when bumping.

---

## ADR-018 · Score persisted, gaps not (cost vs value)
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** Critic produces score, attributes, gaps, violations. Should we persist all of these in the DB?

**Decision.** Persist `quality_score` only (column on `jobs` table). Gaps and violations sent to chat in the post-PDF follow-up message and discarded.

**Reasoning.**
- Score is useful long-term (sortable, searchable in `/status` and `/jobs`).
- Gaps/violations are job-specific; rarely revisited after the immediate refinement.
- Storing them would require a separate `critic_runs` table with arrays — over-engineering for v1.
- If a user wants the gap list later, they can `/edit JOB_ID` and the critic runs again on the next refinement (well, currently doesn't auto-re-run on edit; would need explicit re-critique).

**Consequence.** Historical analysis ("what gaps did the critic catch over time?") not directly queryable. Acceptable for personal use.

---

## ADR-019 · `/reonboard` separate command from `/reupload`
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** User asked for two reset levels: replace base resume only (light), and full reset including context.md + active jobs (heavy).

**Decision.** Two separate commands: `/reupload` (extended to work post-onboarding for light reset) and `/reonboard` (new, for full wipe). Both have inline-button confirmations.

**Reasoning.**
- Distinct verbs for distinct intents. Light reset shouldn't surprise the user by also wiping context.md.
- Confirmations protect against accidental destructive action.
- `/reupload` matches the existing onboarding-time semantic ("I want to re-upload"); just extends to allow it later too.

**Consequence.** Two commands to maintain instead of one with a flag. Worth it for clarity.

---

## ADR-020 · Code lives at `~/Documents/resume-builder/` (not `~/code/resume-bot/`)
**Date:** 2026-04-26 · **Status:** Accepted (consolidation)

**Context.** The original §13.10 build prompt prescribed `~/code/resume-bot/` for code and `~/Documents/resume-builder/` for the design doc. That split made docs and code live in different repos:
- Broke GitHub README links (relative paths to docs at `~/Documents/...` couldn't resolve from a repo at `~/code/...`)
- Required a `docs/` subdir migration anyway (between commits 0384dcc and 7497197)
- Two separate working directories with different histories was friction without payoff

**Decision.** Consolidate everything into `~/Documents/resume-builder/`. Code, docs, .git, .env, node_modules — all under one root. Removed `~/code/resume-bot/` entirely.

**Reasoning.**
- One working directory means one `cd`, one git remote, one `npm install`.
- Docs and code share a repo, so README links resolve naturally on GitHub.
- The historical split was prescribed for "workspace data separate from code" cleanliness — but workspace data is at `~/bot/`, and that separation IS preserved. The code-vs-docs split was incidental, not load-bearing.

**Consequence.**
- Instructions in `tasks.md` (historical build log) and `resume-bot-design.md` (frozen v1 spec) referencing `~/code/resume-bot/` were left in place to preserve build history. Forward-looking text uses `~/Documents/resume-builder/`.
- `.git` moved with rsync; remote URL unchanged (`origin = https://github.com/deepesh-01/resume-bot.git`).
- Pre-commit hook intact at `.git/hooks/pre-commit`.
- `~/bot/` workspace data unchanged.

---

## ADR-021 · Headless `cli-tailor` entry parallel to the Telegram bot
**Date:** 2026-04-26 · **Status:** Accepted

**Context.** A sibling project — System B (`job-intake`, Python at
`~/Documents/ready-to-apply/`) — scrapes job boards into a Google Sheet.
When the user marks a Sheet row `status=tailor`, System B's processor
needs to invoke System A's tailoring pipeline. System A is TypeScript/
Node, System B is Python; in-process linking is not viable. The original
§13.10 (System B design) called for a subprocess CLI on this side; until
now, no headless entry existed (only `src/index.ts` → Telegram bot).

**Decision.** Add `src/cli-tailor.ts` as a second top-level entry,
compiled to `dist/cli-tailor.js`. Reuses `createJobWorkspace`,
`runTailoring`, `runCritic`, `runRefinement`, `renderResumePdf` from
existing modules. Takes args `--jd-path`, `--chat-id`, optional
`--output-dir`, `--output-format json`. Emits one JSON line on stdout:
`{ok, pdf_path, last_change, score, refinement_applied, duration_ms,
error}`. Exit 0 on success, 1 on caught failure, 2 on bad args. Does
NOT write to the SQLite DB (the bot owns DB writes; the CLI is a
stateless invocation).

**Reasoning.**
- Reusing existing modules means tailoring quality, prompts, critic, and
  refinement gate match the Telegram path exactly. No drift.
- Subprocess JSON IO is the standard cross-language bridge.
- Skipping DB writes keeps the bot's job history uncluttered. If we ever
  want CLI-triggered jobs to be `/edit`-able from Telegram, that becomes
  a follow-up ADR.
- New file only — no edits to `src/index.ts`. The bot keeps running as a
  background service, unaffected.

**Consequence.**
- `package.json` keeps `start` as `node dist/index.js` (bot). To run the
  CLI: `node dist/cli-tailor.js …` directly. Could add an npm script
  later if invocation becomes frequent.
- Per-job workspace at `~/bot/users/<chat_id>/jobs/<job_id>/` is shared
  with bot-created jobs. Same cleanup/archive policy applies.
- Resume artifacts produced via CLI are NOT delivered through Telegram.
  System B copies the PDF into its own `data/tailored/` and writes the
  path back to the Sheet row.
- `--allowedTools Read,Edit,Write` contract preserved (uses existing
  `runTailoring()` which sets it).

---

## ADR-022 · Heartbeat file + launchd watchdog for self-healing
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** Two failure modes were observed during the build:
1. **Process crash** — uncaught exception kills `node dist/index.js`. PID gone, bot dead, no recovery.
2. **Process hang** — process is alive (PID present, port listening) but stuck. Specifically observed on linkedin_4: `replyWithDocument` started, Telegram processed the upload, the bot's `await` never resolved, bot was unresponsive for 7 minutes until manual restart.

A simple `pgrep` health check catches (1) but not (2). And without an external watcher, even (1) requires manual `npm start`.

**Decision.** Two-part self-healing system:

1. **In-bot heartbeat** (`src/heartbeat.ts`) — `setInterval` writes the current epoch ms to `~/bot/.heartbeat` every 60s. Started/stopped with the bot's lifecycle.
2. **External watchdog** (`scripts/watchdog.sh` + launchd plist) — runs every 2 min. Checks:
   - Is there a `node dist/index.js` process whose `cwd` is the repo? (cwd-filtered, so unrelated bots in other dirs don't false-match.)
   - Is `~/bot/.heartbeat` newer than 180s?
   If either fails: SIGINT → wait 5s → SIGKILL → spawn fresh `npm start`. Then DM admin via Telegram with the trigger reason ("no process" / "heartbeat missing" / "heartbeat 240s stale").

**Reasoning.**
- Heartbeat catches hangs that PID checks miss. The 60s tick + 180s threshold gives enough slack that a short GC pause or busy moment doesn't trigger a false restart, but a real hang is detected within 2-3 min.
- launchd is the right OS scheduler on macOS — survives logout, `KeepAlive` semantics aren't needed since `StartInterval` reruns every 2 min.
- DM-on-restart is the right notification pattern (ADR-derived from earlier discussion). Hourly "I'm alive" pings become noise; restart-only pings are pure signal.
- Bot heartbeat token is read from `.env` directly by the watchdog script — no separate config.
- Token + admin chat_ids are READ from `.env`, not embedded in the script — keeps the script portable across users.

**Consequence.**
- The bot has hard-to-test paths now: a stuck `replyWithDocument` self-heals within ~3 min, no human intervention.
- Watchdog can't recover from laptop-off scenarios (it lives on the same laptop). For full uptime alerting in that case, add an external dead-man's-switch (Healthchecks.io ping every hour from the bot — separate ADR if implemented).
- `npm start` from inside the watchdog detaches via `nohup` + `&` + `disown`. Process tree: launchd → watchdog.sh → npm → node. npm parent dies on completion; node becomes orphaned (parent=1). Acceptable.
- New scripts: `scripts/watchdog.sh`, `scripts/install-watchdog.sh`, `scripts/uninstall-watchdog.sh`, `scripts/com.deepesh.resume-bot-watchdog.plist`.
- New module: `src/heartbeat.ts` (started/stopped from `src/index.ts` boot path).

---

## ADR-023 · External-trigger HTTP endpoints (`/healthz`, `/restart`)
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** The launchd watchdog (ADR-022) lives on the same laptop as the bot. If the laptop is up but a third-party monitor (UptimeRobot, Healthchecks.io, custom) is what's checking liveness, that monitor needs:
1. A way to ASK whether the bot is alive (not just "did it ping me recently").
2. A way to TRIGGER a restart when it detects a hang, without SSH'ing or walking to the laptop.

**Decision.** Bot exposes a small HTTP server on `127.0.0.1:8787` (configurable via `HEALTH_PORT`):

- `GET /healthz` — no auth. Returns `200 {ok:true, heartbeat_age_ms, threshold_ms}` if the heartbeat file is younger than 180s. Returns `503 {ok:false, ...}` otherwise.
- `POST /restart` — requires `X-Watchdog-Token: <WATCHDOG_RESTART_TOKEN>` header. If token is configured AND matches: responds `202 {ok:true, restarting:true}`, then `process.exit(1)` after 500ms. Watchdog respawns within 2 min. If token is unset, returns `501`. If token is wrong, returns `401`.

Bound to `127.0.0.1` so the endpoints aren't reachable across the network. Users who want external access expose them via Cloudflare Tunnel / ngrok / SSH tunnel. The token requirement on `/restart` defends against accidental triggers if the tunnel is misconfigured.

**Reasoning.**
- A pure heartbeat-file approach (ADR-022) is opaque to external services. They'd need filesystem access to read the heartbeat. HTTP is the universal interface.
- Separation of concerns: `/healthz` lets ANY tool ping for liveness; `/restart` is privileged.
- 127.0.0.1-binding is a meaningful default — exposing it externally must be deliberate.
- Token in env (not hardcoded), generated via `openssl rand -hex 32`. Empty token disables `/restart` entirely.
- Not extending the Telegram bot itself for this — when bot is hung, Telegram is unreachable through it. HTTP is independent of the polling loop.

**Consequence.**
- Two new env keys: `HEALTH_PORT` (default 8787, set to 0 to disable the server), `WATCHDOG_RESTART_TOKEN` (default empty = restart disabled).
- A future Cloudflare Tunnel config (per-user setup, not committed) can map a subdomain to localhost:8787.
- Local dev: `curl http://127.0.0.1:8787/healthz` works from the same machine; `curl -X POST -H "X-Watchdog-Token: ..." http://127.0.0.1:8787/restart` triggers restart for testing.
- The launchd watchdog (ADR-022) and this HTTP endpoint complement each other: launchd is the local self-healer; HTTP is the third-party-trigger interface.

---

## ADR-024 · Descriptive PDF filenames (vs `final.pdf`)
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** Tailored resumes were sent through Telegram with the on-disk filename `final.pdf`. Users (notably during friend testing) flagged two real problems:

1. Saving multiple resumes from the bot all collide: `final.pdf` overwrites the previous one in the user's downloads folder.
2. The name is generic and unhelpful — months later, the user can't tell from the filename which resume was for which role.

**Decision.** Telegram-side filename: `{First}_{Last}_{Role}_{Company}.pdf`. Built per-job:
- First/last name parsed from the H1 of `base_resume.md` (`# DEEPESH RATHOD` → `Deepesh`/`Rathod`).
- Role and company come from the job row (extracted at scrape time, or null if pasted-text JD).
- All parts sanitized: `[^A-Za-z0-9_-]+ → _`, collapsed underscores, trimmed, max 40 chars per segment.
- Fallback to `{job_id}.pdf` if name parts can't be resolved (e.g., manual paste with no extracted role/company AND base resume H1 missing).

On-disk file at `jobDir/final.pdf` is unchanged — keeps internal addressing predictable and matches existing render/copy/test code paths. The override happens only at the `new InputFile(path, filename)` call.

**Reasoning.**
- The disk filename and the wire filename serve different audiences. Internal: predictable. User-facing: descriptive.
- Pulling from base_resume.md keeps it dynamic — when the user changes their resume name, future tailorings reflect it.
- Sanitization is conservative (alphanumeric + underscore + dash) to play nicely with macOS, Linux, Windows, and Telegram's UI.
- Fallback to job_id ensures Telegram never sees an empty or weird filename.

**Consequence.**
- New module `src/pdfName.ts` with `getCandidateName(chat_id)` and `buildPdfFilename({candidate, role, company, jobId})`.
- Used in both `runJob.ts` (initial v1 send) and `runEdit.ts` (post-edit re-render send).
- ADR-021's `cli-tailor` continues to write to `final.pdf` on disk; if a future caller wants the descriptive name, it can call `buildPdfFilename` itself.

---

## ADR-025 · Watchdog hardened: pid file + heartbeat-first detection + relocation outside `~/Documents`
**Date:** 2026-04-27 · **Status:** Accepted · **Supersedes parts of:** ADR-022

**Context.** The Pattern B watchdog from ADR-022 went into production and immediately hit four failure modes:

1. **macOS TCC blocked launchd from reading the script.** `~/Documents/` is gated by macOS's "Files & Folders" privacy. launchd-spawned `/bin/bash` got `Operation not permitted` when reading `scripts/watchdog.sh`. We could ask the user to grant Full Disk Access to `bash` via System Settings, but that's a per-machine manual step and a surprise for any new contributor.
2. **`lsof`-based cwd matching was unreliable in launchd's sandbox.** The script disambiguated `pgrep -f "node dist/index.js$"` matches by checking each candidate's `cwd`. Under launchd, `lsof` returned nothing for processes with files open in `~/Documents/`, so the disambiguation collapsed.
3. **Fall-back to "kill all pgrep matches" was actively dangerous.** When `lsof` failed for every candidate, the script killed every `node dist/index.js` it could see — including an unrelated `welog/relay` bot in a sibling directory. Discovered in smoke testing.
4. **Generic DMs gave the user no signal about what triggered a restart.** ADR-022's DM said `🔄 Bot was down (no process running). Watchdog restarted it.` regardless of whether the bot crashed, was killed manually, was killed by `POST /restart` from a third-party uptime monitor, or asked itself to restart.

The notify_admin loop was DM'ing every 2 minutes because all of (1)-(3) compounded: the script couldn't even execute, then when it did execute it misidentified the resume-bot as "down" because lsof was blocked, then it killed innocent processes, then it failed to spawn a new bot because the real one was holding port 8787, etc.

**Decision.** Five interlocking changes:

1. **Relocate the watchdog out of `~/Documents/`.** `install-watchdog.sh` now copies `scripts/watchdog.sh` → `~/bot/bin/watchdog.sh` and the relevant `.env` keys → `~/bot/.watchdog.env` (chmod 600). The plist points launchd at the deployed copy. `scripts/watchdog.sh` in the repo is the source of truth; reinstall after editing.
2. **Bot writes a pid file as the authoritative identifier.** `src/heartbeat.ts` writes `~/bot/.bot.pid` synchronously on `startHeartbeat()` and removes it in `stopHeartbeat()` only if the recorded pid still matches `process.pid` (so a fast crash-and-restart doesn't wipe out the new process's claim). The watchdog reads that file and uses `kill -0` to check liveness. **No `pgrep`, no `lsof` in the disambiguation path.**
3. **Heartbeat-first detection.** If `~/bot/.heartbeat` is fresh (≤180s), the watchdog exits 0 silently with no further checks. The pid-file lookup is reserved for the (rare) act-on-stale path.
4. **No more "fall back to all pgrep matches".** If pid-file lookup fails, the watchdog spawns a fresh bot and trusts the new pid file going forward — it does NOT scan and kill every `node dist/index.js` on the box. Killing a sibling project's bot is not an acceptable failure mode.
5. **Restart attribution via a free-form reason file.** `~/bot/.restart-reason` is written by anyone who wants to ask the bot to restart (currently `POST /restart` and the new Telegram `/restart` command). The watchdog reads + deletes the file post-respawn and DMs the recorded string. DM template is now `🔄 Bot restarted: <reason> · respawned by resume-builder watchdog · HH:MM TZ`. Three reason values ship today: `HTTP /restart from <X-Watchdog-Source>`, `Telegram /restart by @user`, and (no file) `⚠️ Bot crashed (no process running)` for unattributed exits.

Also rolled in: `stopHealthServer` is now `async` and awaits `server.closeAllConnections()` + `server.close()` before `process.exit`, so port 8787 is fully released on graceful shutdown and the next bot launch never EADDRINUSEs. The `/restart` HTTP handler and the new `/restart` Telegram handler both `process.kill(SIGINT)` so they go through the same shutdown path rather than `process.exit` directly.

**Reasoning.**
- (1) is the cheap fix for the TCC issue. Granting `bash` Full Disk Access works but is a hidden trap for any reinstall. Moving the script out of `~/Documents/` is permanent and self-documenting.
- (2) is the right shape regardless of TCC: **a process should be identifiable by something it itself wrote, not by us heuristically introspecting kernel state.** A pid file is the simplest such identifier and it's authoritative.
- (3) means the watchdog has zero overhead in the steady state — no `lsof`, no `pgrep`, just a stat on the heartbeat file and a math check. Both a performance win and a correctness win (fewer code paths that can misbehave).
- (4) is a hard rule: **the watchdog must never kill a process it can't positively identify.** The cost of a missed restart is one extra cycle of the 2-min watchdog tick. The cost of killing a sibling project's bot is real data loss for a user who doesn't even know this watchdog exists.
- (5) addresses the "who triggered this" question that surfaced as soon as `POST /restart` and a Telegram `/restart` command shipped. A free-form reason string is more flexible than a typed enum: any new caller (a future shell script, a Healthchecks.io webhook, a dashboard button) can write its own attribution without a code change in the watchdog.

**Consequence.**
- New runtime files in `~/bot/`: `bin/watchdog.sh` (copy of repo script), `.watchdog.env` (chmod 600 — token + admin chat ids), `.bot.pid` (current bot's pid), `.restart-reason` (transient).
- New module exports in `src/heartbeat.ts`: `BOT_PID_FILE`, `RESTART_REASON_FILE`.
- Existing watchdog DM template changed; admins who memorised the old wording will see the new format starting next restart.
- The "macOS TCC gotcha" troubleshooting block in `how-to-journey.md` was removed — relocation makes it irrelevant.
- A future cross-repo restart-log contract (sibling projects writing to a shared `~/bot/logs/restarts.log`) is **not** introduced here; if needed, a separate ADR will define the schema.
- New Telegram command `/restart` (admin-only) and `/commands` (public, tappable list). `setMyCommands` is called on bot boot to populate Telegram's autocomplete menu — public scope by default, admin commands additionally registered per `ADMIN_CHAT_IDS` chat.

---

## ADR-026 · Daily backup cron via launchd, kept inside `~/bot/`
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** The bot's only authoritative state is `~/bot/db.sqlite` (jobs, usage, allowed_users, etc.) plus `~/bot/users/<chat_id>/` (base resumes + context). Time Machine covers the laptop, but it's hourly snapshots of the whole machine — slow to find a specific bot row from a week ago, and not portable to a different machine. We want a small, scoped, fast-to-restore backup of just the bot's state.

**Decision.** Three pieces, mirroring the watchdog pattern (ADR-025):

1. `scripts/backup.sh` — date-stamped tarball at `~/bot/backups/bot_YYYYMMDD_HHMMSS.tar.gz`. DB captured via `sqlite3 .backup` (consistent across WAL); users/ + archive/ tar'd directly. Excludes the runtime transients (`.heartbeat`, `.bot.pid`, `.restart-reason`, `logs/`). Retention: keep last 14, prune older.
2. `scripts/install-backup.sh` — copies the script to `~/bot/bin/backup.sh` (TCC sidestep, same as ADR-025) and bootstraps a `StartCalendarInterval` launchd agent that fires daily at 03:00 local.
3. `scripts/uninstall-backup.sh` — bootout + remove the deployed script. Existing tarballs in `~/bot/backups/` are left in place.

**Reasoning.**
- `sqlite3 .backup` is the only safe way to copy a live SQLite DB while the bot is writing. A naive `cp` of `db.sqlite` while WAL is open can produce a torn file.
- `StartCalendarInterval` (vs. `StartInterval`) is right for a daily job — it fires on a wall clock instead of N seconds since last run, so missing one day because the laptop was asleep doesn't push subsequent backups out of phase.
- Retention at 14 is a "two weeks of recovery" target. Tarballs are ~1-2 MB each so storage cost is negligible.
- Keeping backups under `~/bot/backups/` (not `~/Backups/`) makes the bot's stateful surface area self-contained — one directory to back up off-machine if needed.

**Consequence.**
- New scripts: `scripts/backup.sh`, `scripts/install-backup.sh`, `scripts/uninstall-backup.sh`, `scripts/com.deepesh.resume-bot-backup.plist`.
- New runtime dirs: `~/bot/backups/`, `~/bot/bin/` (shared with the watchdog).
- New log: `~/bot/logs/backup.log`.
- Recovery: `tar xzf ~/bot/backups/bot_YYYYMMDD_HHMMSS.tar.gz -C ~/bot.restored/` and either point the bot at the restored dir via `WORKSPACE_ROOT`/`DB_PATH`, or `mv` the existing `~/bot` aside and `mv` the restore in.

---

## ADR-027 · Weekly Claude spend alert at 80% of cap (proactive, not reactive)
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** Claude Code's subscription has a rolling weekly cap. When the user crosses it mid-job, the bot surfaces `CLAUDE_RATE_LIMIT` to whoever asked — disruptive UX, especially for friends who don't know what's going on. We log every invocation's `total_cost_usd` to the `usage` table, so we can see the cap coming.

**Decision.** Add `CLAUDE_WEEKLY_BUDGET_USD` (env var, default 0=disabled). After every job-driven `logUsage`, query `SUM(total_cost_usd) WHERE created_at >= now-7d` and compare against the cap. When the rolling spend crosses 80%, DM admins once. Persist `last_alert_ms` to `~/bot/.budget-alert.json` with a 24h cooldown so a flapping spend curve doesn't spam the chat.

**Reasoning.**
- One configurable cap, one threshold (80%), one cooldown (24h) — fewer moving parts than tracking percent-of-cap-per-day or compute-per-friend allotments.
- Default-disabled keeps onboarding simple and avoids wrong-cap noise (the actual subscription cap varies per plan).
- Calling it from `runJob`/`runEdit`'s `finally` block (one budget check per user-facing job) is cheap — one indexed `SUM` on the usage table.
- We deliberately do NOT block jobs at 80% — only DM. Deciding to throttle the user's own work is a policy call we don't want to bake in here.

**Consequence.**
- New env var `CLAUDE_WEEKLY_BUDGET_USD`. Documented in `how-to-journey.md` Setup snippet and in the Cost-tracking section.
- New module `src/budget.ts` exporting `getWeeklySpendUsd()` and `checkAndAlertIfOver80(bot)`.
- New runtime file `~/bot/.budget-alert.json` (single small JSON object).

---

## ADR-028 · External uptime ping (Pattern C) via Healthchecks.io
**Date:** 2026-04-27 · **Status:** Accepted

**Context.** The launchd watchdog (ADR-022/025) is a *local* self-healer — it lives on the same laptop as the bot. It catches process crashes and process hangs, but it's blind to the laptop being off, sleeping, or completely off the network. We need a truly external observer for that case.

**Decision.** Use [Healthchecks.io](https://healthchecks.io)'s pull-based ping model. Add `HEALTHCHECKS_URL` env var. The bot's existing 60s heartbeat tick `GET`s that URL on every fire. The remote service alerts (email / SMS / webhook / etc — the user configures it server-side) when it stops hearing from us for longer than its configured grace period.

**Reasoning.**
- We already had a 60s tick — adding a second side-effect to it costs us nothing.
- Pull-only model: we don't have to expose the bot to the public internet. Outbound HTTPS is universally allowed.
- Empty env var disables the ping cleanly, including the `fetch` cost. No-op for users who don't need this.
- Failure handling: `try/catch + AbortController` 10s timeout, log a single warn on failure, suppress further warns until a successful ping recovers (so a flaky network doesn't spam the log).
- Healthchecks.io specifically (vs Better Uptime, UptimeRobot, etc.): free tier is generous, server-side alerting is configurable per-check, and the ping URL is opaque (no inbound exposure). Any pull-based pinger with a unique URL would work — the contract is just "GET this every minute"; the env var name is generic enough to point at any equivalent service.

**Consequence.**
- New env var `HEALTHCHECKS_URL`. Documented in `how-to-journey.md` Setup snippet and in a new "External uptime ping" subsection.
- `src/heartbeat.ts` gains a `pingHealthchecks()` helper called from `tick()`. No bot logic depends on the response.

---

## ADR-029 · Restart-attribution DM moves from the watchdog into the bot's boot path
**Date:** 2026-04-27 · **Status:** Accepted · **Supersedes parts of:** ADR-025

**Context.** ADR-025 put the post-restart DM logic inside the launchd watchdog: after the watchdog respawned the bot, it read + deleted `~/bot/.restart-reason` and DMed admins with the recorded attribution string. This worked when the watchdog was the only supervisor.

In production at 05:21 IST on 2026-04-27 we caught the failure mode: a sibling project's `python -m web.server` (job-intake's webapp at `~/Documents/ready-to-apply/`, which runs `npm start` to keep this bot up too) beat the watchdog by ~90 seconds to spawn a new bot after a Telegram `/restart`. Process-tree confirmation: `pid 22892 → npm start (22881) → python -m web.server (9392)`. By the time the watchdog's next 2-min tick ran, the bot was already healthy. The watchdog took the happy path, hit a "race-cleanup" line that deleted the orphan reason file, and stayed silent. The user got their pre-exit `♻️ Restarting now…` reply but never the post-respawn confirmation. The DM was eaten by the race.

The architectural mistake: **post-restart attribution belongs to the BOT, not the watchdog.** Only the bot itself can confirm it's actually serving Telegram again — `process started` is not the same as `process is healthy and polling`. The watchdog's job is to detect failures the bot can't speak for itself (crash, hang).

**Decision.** Move the reason-file consumer from the watchdog into the bot's boot path:

1. **Bot, on boot** (`src/index.ts` `announceRestartAfterRespawn`): if `~/bot/.restart-reason` exists, read it, DM admins `🔄 Bot back online — <reason> · HH:MM TZ`, then delete the file. Runs in parallel with `bot.start()` since `bot.api.sendMessage` is a stateless HTTP call. Delete-before-DM ordering so a partial DM failure can't loop on the same reason next boot.
2. **Watchdog** (`scripts/watchdog.sh`): `read_and_clear_reason()` removed. Race-cleanup line in the healthy path removed. Spawn-path DMs and hung-restart DMs gated by `[ ! -f "$RESTART_REASON_FILE" ]` — the watchdog stays silent when a reason file exists because the bot will speak for itself once it's up.

**Reasoning.**
- The bot is the only process that can prove "Telegram polling is up" after a restart. The watchdog can confirm "a process is alive at a pid" but not that the new process is actually serving requests. Distinguishing these two is the whole point of the heartbeat — apply it consistently.
- The bug the old design carried — silent reason-file cleanup whenever a sibling supervisor wins the spawn race — gets fixed by construction. The bot's boot is the authoritative consumer regardless of which supervisor (launchd watchdog, sibling project's `npm start`, manual run) won the race.
- The "respawned by resume-builder watchdog" language in the old DMs was already a stretch in practice — the watchdog's `start_bot` calls `nohup npm start &`, npm dies once node is up, and the actual bot process gets reparented to init. Saying "respawned by the watchdog" was tracking *intent*, not *parentage*. The new DM (`back online`) describes a state the bot can verify.
- Watchdog DMs are preserved for the cases the bot can't speak for itself: crash with no reason file (`⚠️ Bot crashed (no process running) · respawned by resume-builder watchdog · …`) and hang (`🔄 Bot was hung (heartbeat Xs stale) · killed + restarted by resume-builder watchdog · …`).

**Consequence.**
- New helper in `src/index.ts`: `announceRestartAfterRespawn()`. Reads `RESTART_REASON_FILE`, DMs `config.ADMIN_CHAT_IDS`, deletes the file. `formatTime()` mirrors the watchdog's `date '+%H:%M %Z'` output so DM timestamps stay visually consistent across emitters.
- Watchdog code is shorter: `read_and_clear_reason()` deleted entirely, three call sites simplified to `[ ! -f "$RESTART_REASON_FILE" ] && notify_admin "..."`.
- DM count per restart event:
  - `/restart` (any supervisor respawns): 1 DM, from the bot. Bug fixed.
  - Crash without reason: 1 DM, from the watchdog (unchanged).
  - Hang without reason: 1 DM, from the watchdog (unchanged).
  - Crash *or* hang while a reason file happened to be present (rare race): 1 DM, from the bot. Watchdog stays silent.
- DM wording changes from `🔄 Bot restarted: <reason> · respawned by resume-builder watchdog · TZ` to `🔄 Bot back online — <reason> · TZ`. The `back online` framing is more honest about what the bot can observe.

---

*New decisions append below this line.*
