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

*New decisions append below this line.*
