# Resume Tailoring Bot

A private Telegram bot that tailors your resume to specific job descriptions. Send a URL or paste a JD, get a tailored PDF with a quality score. Reply with edits to refine. Promote good edits back into your base resume with `/save`.

Personal-scale: runs on a laptop, uses your Claude Code CLI subscription, ~3 friends max.

> **Production rendering backend for an end-to-end job-application pipeline.** The orchestrator is [`deepesh-01/job-intake`](https://github.com/deepesh-01/job-intake) (live at [takejob.deepesh-engg.in](https://takejob.deepesh-engg.in)) — a Python scout cron scrapes job boards into a Google Sheet, a FastAPI + React webapp triages and scores postings, and triage actions invoke this repo's headless [`cli-tailor.js`](./src/cli-tailor.ts) (ADR-021) to produce tailored PDFs through a 3-pass quality loop (tailor → critic → refinement). The Telegram surface is the parallel manual-use entry point. A launchd watchdog with heartbeat-based detection, pid-file identification, and DM restart attribution (ADR-022, ADR-025) keeps the laptop-hosted bot self-healing through crash, hang, external HTTP `/restart`, and admin-issued `/restart` from inside Telegram. Shipped solo over a weekend.

---

## In production

Used as the rendering backend for a real job-application pipeline I run on my own laptop.

| Where | What | Link |
|---|---|---|
| **`deepesh-01/job-intake`** | Scout (Python cron) → Google Sheet → FastAPI + React triage UI → invokes `cli-tailor.js` from this repo → tailored PDF → Drive | [github.com/deepesh-01/job-intake](https://github.com/deepesh-01/job-intake) |
| **takejob.deepesh-engg.in** | Read-only public view of the triage UI (Cloudflare Tunnel → laptop) | [takejob.deepesh-engg.in](https://takejob.deepesh-engg.in) |

The repo you're reading is **System A** (resume rendering); `job-intake` is **System B** (sourcing + triage). They communicate by subprocess: `node dist/cli-tailor.js --jd-path <md> --chat-id <id> --output-dir <dir> --output-format json`. The Telegram bot in this repo is the parallel manual-use surface.

---

## Quick start

### Prerequisites
- macOS or Linux, Node 20+
- Claude Code CLI authenticated (`claude --version`)
- `pandoc`, `typst` in PATH (`brew install pandoc typst`)
- Telegram bot token from `@BotFather`

### Install
```bash
cd ~/Documents/resume-builder
npm install
npx playwright install chromium
cp .env.example .env             # then fill in token + chat_ids
npm run init-workspace
npm run build
npm start
```

### Use it
1. `/start` the bot in Telegram → upload your resume → `/confirm`
2. Paste a JD URL or text → wait ~3 min → tailored PDF arrives with a quality score
3. Reply with edits ("trim to one page", "lead with security") to refine
4. `/save` to promote good edits back to your base resume

`/help` in chat lists all commands.

---

## Architecture

```
~/Documents/resume-builder/        ← code (this repo)
~/bot/                    ← workspace data (separate from code)
  users/<chat_id>/
    base_resume.md        ← master resume
    CLAUDE.md             ← per-user agent instructions
    context.md            ← optional off-resume facts
    jobs/<job_id>/
      resume.md           ← tailored copy
      job_description.md  ← scraped/pasted JD
      final.pdf           ← rendered output
  archive/<chat_id>/
    <job_id>.tar.gz       ← jobs idle >30 days
  db.sqlite               ← jobs, usage, allowed_users, ...
  logs/<YYYY-MM-DD>.log   ← pino structured logs
```

Three claude calls per job (lever A): **tailor** (A) → **critic** (D, JSON-output, read-only) → **refinement** (E, --resume, applies critic's gap list) → render with pandoc + typst → reply with PDF + quality score.

---

## Documentation

- **[docs/how-to-journey.md](./docs/how-to-journey.md)** — full operational guide: setup, command reference, flows, debugging, ops, failure modes
- **[docs/tasks.md](./docs/tasks.md)** — chronological build log with smoke checklists per step
- **[docs/decisions.md](./docs/decisions.md)** — architecture decision records (Typst vs LaTeX, cookies-dropped, threshold values, lever A, etc.)
- **[docs/resume-bot-design.md](./docs/resume-bot-design.md)** — original v1 spec (frozen)
- **[CLAUDE.md](./CLAUDE.md)** — instructions for AI dev sessions on this codebase

---

## Operations

```bash
npm run dev          # tsx watch, dev mode
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run typecheck    # tsc --noEmit
npm run docs:check   # audit docs vs current code (~$0.05, claude-driven)
npm run docs:sync    # have claude apply doc updates  (~$0.30)
```

Tail logs: `tail -f ~/bot/logs/$(date +%Y-%m-%d).log | npx pino-pretty`

---

## Maintenance

When you add a feature, update the docs in the same change. The project's `CLAUDE.md` instructs every AI dev session to do this automatically. Manual fallback: `npm run docs:check` to audit, `npm run docs:sync` to apply.

A git pre-commit hook runs the audit and blocks commits with doc drift (escape with `git commit --no-verify` if needed).

---

## Privacy

- Allowlist-gated. Friends request access via `/start`; admin approves with one tap.
- Block/revoke admin commands available (see `how-to-journey.md`).
- All data on local laptop. Nothing leaves except final PDFs to Telegram.
- LinkedIn cookies path is in env but **not loaded** (per `decisions.md` ADR-002 — they poison requests when stale). File preserved for future flows.
