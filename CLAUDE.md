# Resume Bot — AI Dev Session Guide

Auto-discovered by Claude Code when working in this repo. Read this first.

## Project shape

- **Language:** TypeScript (NodeNext ESM, strict + noUncheckedIndexedAccess)
- **Runtime:** Node 20+
- **Bot framework:** grammY
- **DB:** SQLite via better-sqlite3 (schema inlined in `src/db.ts`)
- **PDF render:** pandoc → typst (templates/resume.typ)
- **Code path:** `~/code/resume-bot/`
- **Workspace data:** `~/bot/` (separate; never wipe with code clean)
- **Docs:** `/Users/deepeshz2/Documents/resume-builder/` (`how-to-journey.md`, `tasks.md`, `decisions.md`, `resume-bot-design.md`)

## When you add or modify a feature

**You MUST update the docs in the same change.** Specifically:

1. **`how-to-journey.md`** — operational guide. Update if you:
   - Added a new command → list it under "Full command reference"
   - Changed a flow → update "Flows" section
   - Added a new failure mode or fixed one → update "Common failure modes"
   - Added a new file → update "Architecture overview"
   - Changed env vars → update "Setup → .env"

2. **`tasks.md`** — chronological build log. **Append a new section** (don't edit prior sections — they're historical). Use the established shape:
   ```
   # Build Step X — Title
   *Scope statement*

   ## X.1 — Subtask (estimate)
   - bullet
   - bullet

   ## X.2 — ...

   ## X.N — Smoke checklist
   - [ ] testable behavior
   - [ ] testable behavior
   ```

3. **`decisions.md`** — append a new ADR if the choice is non-obvious. Use the format:
   ```
   ## ADR-NNN · Title
   **Date:** YYYY-MM-DD · **Status:** Accepted

   **Context.** ...
   **Decision.** ...
   **Reasoning.** ...
   **Consequence.** ...
   ```
   Don't add an ADR for trivial choices. Add one when:
   - You picked option A over option B and the tradeoff matters
   - You deliberately deviated from the design doc
   - A future-you might re-litigate this choice without the rationale

## Code conventions

- **Tests:** none (manual smoke per `tasks.md`). Don't add a test framework unless asked.
- **Imports:** NodeNext requires `.js` extensions on relative imports (e.g. `from './bot.js'`).
- **Logging:** pino via `ctx.logger` in handlers, `logger` (top-level) elsewhere. Use structured fields (`event: 'job_done'`) — they're greppable.
- **Errors:** every external call (claude CLI, Telegram API, file I/O) needs a try/catch. Map errors to canonical user-facing strings in `src/strings.ts`. Don't echo raw error messages to chat.
- **DB:** all queries via prepared statements in `src/db.ts`. Don't inline SQL in handlers.
- **Pending state:** for multi-message flows, use the `Map<chat_id, ...>` pattern (see `src/disambiguate.ts`, `src/savePending.ts`). Routing layer in `jobMessage.ts` checks pending state first.
- **Callbacks:** all inline-button callbacks dispatch through `src/handlers/callbacks.ts` `callbackRouter` by prefix. Add new prefixes there, not as new `bot.on('callback_query:data', ...)` handlers (that breaks middleware chaining).
- **Schema migrations:** add to the migrations array in `src/db.ts` after the `db.exec(SCHEMA)` block. `ALTER TABLE ADD COLUMN` errors with "duplicate column name" are swallowed; that's the idempotency mechanism.
- **§13.10 binding:** don't invent CLAUDE.md template content (the per-user one at `src/templates/claudemd.ts`) or §13.6 user-facing strings (in `src/strings.ts`) without explicit ask. Both are source-of-truth files; changes are deliberate.

## Adding a new command (checklist)

1. `src/handlers/<name>.ts` exporting `<name>Handler(ctx)`.
2. Register in `src/index.ts`: `bot.command('<name>', <name>Handler)`.
3. If it should work pre-onboarding, add to `ONBOARDING_COMMANDS` in `src/middleware/preOnboarding.ts`.
4. If admin-only, gate inside the handler with `isAdmin(ctx.from?.id ?? -1)` from `src/access.ts`.
5. If admin-only, NOT in `/help` text (`src/handlers/help.ts`). Public commands ARE in `/help`.
6. Update `how-to-journey.md` "Full command reference" table.
7. Add to `tasks.md` — append a build-step section with smoke checklist.

## Adding a callback (inline button) flow

1. Pick a unique prefix (e.g. `myflow:`).
2. Handler file `src/handlers/<flow>.ts` exporting a callback function.
3. Add the prefix branch to `src/handlers/callbacks.ts` `callbackRouter`.
4. Reply markup: `{ inline_keyboard: [[{text: '...', callback_data: 'myflow:action:context'}]] }`.
5. Always `ctx.answerCallbackQuery({text: '...'})` before doing work, so Telegram clears the spinner.
6. Use `ctx.editMessageReplyMarkup({reply_markup: undefined})` to strip buttons after the action so they can't be double-tapped.

## Adding a new claude invocation (tailor/edit/critic-style)

1. Add a constant for the prompt and a hard timeout in `src/claude.ts`.
2. Wrap with `runClaude(args, cwd, hardMs)`. Don't bypass — it handles JSON parsing, error classification, timeouts uniformly.
3. If output is structured JSON (like the critic), parse `result.result` (assistant's text) inside the wrapper, defensively (strip code fences, fall back to `{` ... `}` slice).
4. Log `usage` row with the new `invocation_type` letter (extend the type union).
5. Add an ADR to `decisions.md` for the design choice.

## When you encounter ambiguity

- **Don't invent UX strings** — surface the question and let the user decide.
- **Don't invent CLAUDE.md content** — the §13.4 template (extended in ADR-013, ADR-015) is binding.
- **Don't widen `--allowedTools`** — Read,Edit,Write is the contract. Adding `Bash` opens prompt-injection risk that the wrapped JD content already presents.
- **Don't downgrade dependencies silently** — call out major version changes (e.g. `diff` v8 renamed `Hunk` → `StructuredPatchHunk`).

## Maintenance

- Run `npm run docs:check` to audit docs vs current code surface (claude-driven; ~$0.05).
- Run `npm run docs:sync` to ask claude to apply doc updates (one-shot, ~$0.20).
- Both scripts are at `scripts/docs-*.sh` — read them before relying on them.

## Build / restart loop

```bash
cd ~/code/resume-bot
npm run typecheck    # quick TS check, no emit
npm run build        # produces dist/
PID=$(pgrep -f "node dist/index.js" | head -1)
[ -n "$PID" ] && kill -INT $PID && sleep 2
npm start            # node dist/index.js (or `npm run dev` for tsx watch)
```

If a 409 Conflict appears in logs, two bot instances are polling — kill all and restart cleanly.

## Dev shortcuts

- Tail today's log: `tail -f ~/bot/logs/$(date +%Y-%m-%d).log | npx pino-pretty`
- Inspect DB: `sqlite3 ~/bot/db.sqlite '.tables'`
- Manually deliver a stuck PDF: `curl -F "chat_id=<ID>" -F "document=@<path>" "https://api.telegram.org/bot$TOKEN/sendDocument"`
- Trigger archive sweep: `node -e "import('./dist/archiveCron.js').then(m=>m.runArchiveSweep().then(console.log))"`

## Don't drift these docs

If the AI session adds something significant without updating `how-to-journey.md` / `tasks.md` / `decisions.md` in the same change, that's a regression. Run `npm run docs:check` before declaring work done.
