# Next-Session Pickup — Auto-restart on hang/crash (Pattern B)

*Created 2026-04-27. Previous session approached its turn limit mid-implementation. Heartbeat is live; watchdog scripts exist but not yet wired to DM admin and not yet loaded into launchd.*

---

## Goal

Pattern B from the watchdog discussion: watchdog auto-restarts the bot on hang or crash, AND DMs admin via Telegram when it does. Zero noise during normal operation; signal only when something's wrong. Pattern C (Healthchecks.io / external dead-man's switch for laptop-off detection) is a separate future task.

## What's already in place (committed and working)

- **`src/heartbeat.ts`** — bot writes UTC epoch ms to `~/bot/.heartbeat` every 60s. Wired in `src/index.ts` (`startHeartbeat()` on boot, `stopHeartbeat()` in shutdown handler). Verified writing — file present at `~/bot/.heartbeat`.
- **`scripts/watchdog.sh`** — health check + restart script. Currently:
  - Detects no-process state via `pgrep -f "node dist/index\.js$"` + cwd check → restarts via `nohup npm start`
  - Detects stale heartbeat (>3 min) → SIGINT → wait 5s → SIGKILL → restart
  - Logs every restart to `~/bot/logs/watchdog.log`
  - Logs "ok" lines occasionally (10% sample)
  - **Does NOT yet DM admin** — that's the missing piece below.
- **`scripts/com.deepesh.resume-bot-watchdog.plist`** — launchd config (`StartInterval = 120` seconds, `RunAtLoad = true`, env `PATH` includes `~/.local/share/fnm/aliases/default/bin`).
- **`scripts/install-watchdog.sh`** — `launchctl bootstrap` the plist. Idempotent (`bootout` first).
- **`scripts/uninstall-watchdog.sh`** — `launchctl bootout` and remove the plist.

## Pending tasks

### T1 — Add admin DM to `scripts/watchdog.sh` (15 min)

Add a `notify_admin()` shell function that:
1. Reads `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_IDS` from `$REPO_ROOT/.env`. Parse `ADMIN_CHAT_IDS` as comma-separated IDs.
2. For each admin chat_id, calls `curl -s https://api.telegram.org/bot${TOKEN}/sendMessage -d chat_id=$ID --data-urlencode "text=$MSG"`. Suppress curl errors (`|| true` and redirect stderr to /dev/null).
3. Logs success/failure to the watchdog log.

Call sites:
- After successful restart from "no process" path: `notify_admin "🔄 Bot restarted by watchdog · reason: process-down · time: $(date '+%H:%M %Z')"`
- After successful restart from "heartbeat stale" path: `notify_admin "🔄 Bot restarted by watchdog · reason: heartbeat stale (${AGE_MS}ms) · pids before: $PIDS · time: $(date '+%H:%M %Z')"`

Edge cases:
- If `notify_admin` itself fails (network down, token revoked), don't loop — log and continue.
- Don't DM on the watchdog's own startup if bot is already healthy. Only on restart events.

### T2 — Install the launchd entry (2 min)

```bash
cd ~/Documents/resume-builder
bash scripts/install-watchdog.sh
```

Verify:
```bash
launchctl print "gui/$(id -u)/com.deepesh.resume-bot-watchdog" | grep -E '(state|last exit)'
tail -f ~/bot/logs/watchdog.log
```

Expect first-run "ok" log within ~2 min.

### T3 — Smoke test the full loop (15 min)

**Process-down path:**
```bash
PID=$(pgrep -f "node dist/index\.js$" | head -1)
kill -9 $PID
# Wait up to 2 min for watchdog tick
```
- Watch `~/bot/logs/watchdog.log` for `"no bot process — starting"`.
- Verify Telegram DM arrived: `"🔄 Bot restarted by watchdog · reason: process-down ..."`.
- Verify new bot process: `pgrep -f "node dist/index\.js$"`.
- Verify heartbeat resumes: `cat ~/bot/.heartbeat` (should be recent).

**Heartbeat-stale path** (test in dev):
- Pause the bot process: `kill -STOP $PID`.
- Wait 4 minutes (heartbeat won't update; threshold is 3 min).
- Watchdog should detect, force-kill (since SIGINT won't work on STOPped process), restart.
- Verify Telegram DM: `"🔄 Bot restarted by watchdog · reason: heartbeat stale ..."`.
- Resume cleanup: process should be replaced cleanly.

### T4 — Add `ADR-021` to `docs/decisions.md` (5 min)

Document:
- **Heartbeat file vs in-memory ping**: external watchdog must be able to detect a hung process. A file mtime / contents on disk is observable from outside the process; an in-memory tick is not.
- **launchd vs cron**: launchd is macOS-native, supports `KeepAlive`, has per-user agent semantics, doesn't need anacron-style catchup hacks. Cron also works but launchd is the right tool here.
- **DM-on-restart (B) vs hourly heartbeat (A)**: notification fatigue is real; passive "alive" pings get muted by users within a week. Restart pings are actionable signal — they only fire when something needed attention.
- **Pattern C (external dead-man's switch)**: out-of-scope here, but mention Healthchecks.io as the natural next step if laptop-off scenarios need alerting.

### T5 — Update `docs/how-to-journey.md` (10 min)

Add a section under **Operations** titled "Self-healing (heartbeat + watchdog)":
- What it is (bot writes ~/bot/.heartbeat every 60s; launchd runs watchdog every 2 min).
- How to install: `bash scripts/install-watchdog.sh`.
- How to verify: `tail -f ~/bot/logs/watchdog.log`.
- How to disable: `bash scripts/uninstall-watchdog.sh`.
- What gets DMed and when.
- Threshold values (60s heartbeat, 3 min stale, 2 min watchdog interval — all hardcoded; document rationale in ADR-021).

Also update the **Resilience guarantees** section to add bullets:
- Bot writes a heartbeat every 60s; watchdog auto-restarts on hang or crash.
- Admin gets a Telegram DM on every watchdog-triggered restart.

### T6 — Commit + push (5 min)

Single commit:
```
feat(ops): watchdog DMs admin on bot restart (Pattern B)

- scripts/watchdog.sh: notify_admin via Telegram sendMessage
- ADR-021 added (heartbeat + watchdog architecture)
- how-to-journey.md: Self-healing section under Operations
- Install: bash scripts/install-watchdog.sh
```

Push as `deepesh-01`:
```bash
unset GITHUB_TOKEN && gh auth switch -u deepesh-01
git push
gh auth switch -u deepesh-zoca
```

The pre-commit `docs:check` hook should pass cleanly because we're updating docs in the same commit.

## Total estimated time
~50 minutes for a competent session.

---

## Out-of-scope (track for later)

These came up earlier but were not picked for this session:

| Item | Effort | Notes |
|---|---|---|
| Pattern C — Healthchecks.io external pinger | ~30 min | Truly server-independent; alert when laptop is off |
| BotFather `/setcommands` registration script | ~10 min | So commands appear in Telegram autocomplete |
| Backup script (cron tar of `~/bot/{db.sqlite,users,archive}`) | ~15 min | Date-stamped tarballs to a backup location |
| `/users` shows username | ~10 min | Currently only chat_id + display_name |
| Multi-resume support | ~3 hr | `base_resume_<name>.md` + `/setbase NAME` |
| Restore-from-tarball for archived jobs | ~1 hr | `/edit JOB_ID` on tar-archived jobs currently fails |
| Re-critique after refinement (lever A polish) | ~30 min | Show post-refine score for transparency |
| Rate-limit warning at 80% weekly cap (§8) | ~30 min | Surface budget before `CLAUDE_RATE_LIMIT` mid-run |
| Lever (c) two-stage classifier | ~3 hr | Deferred when lever (a) succeeded; revisit only if quality plateau on hard JDs |

---

## Context for next session

- **Codebase root:** `~/Documents/resume-builder/` (per ADR-020 — consolidated, was previously `~/code/resume-bot/`)
- **Workspace data:** `~/bot/` — separate from code, untouched by code-clean operations
- **Pre-commit hook:** runs `npm run docs:check` on `src/`, `scripts/`, `templates/`, `package.json`, `tsconfig.json`, or `CLAUDE.md` changes. Calls claude — costs ~$0.05, takes ~30s. Use `--no-verify` for confident commits; otherwise let it run.
- **GitHub remote:** `https://github.com/deepesh-01/resume-bot.git` (public, on `deepesh-01` account)
- **gh CLI default:** `deepesh-zoca` (work). For push: `unset GITHUB_TOKEN && gh auth switch -u deepesh-01 && git push && gh auth switch -u deepesh-zoca`.
- **Bot currently running** on the laptop. Verify: `pgrep -f "node dist/index\.js$"`.
- **CLAUDE.md (project root)** is auto-discovered by every Claude Code session — read it; it lists conventions and "update docs in same change" obligations.
- **All feature work** must update one or more of: `docs/how-to-journey.md`, `docs/tasks.md` (append-only), `docs/decisions.md` (append-only). Run `npm run docs:check` to audit.

When this is shipped, delete or archive this `next-session-tasks.md` file.
