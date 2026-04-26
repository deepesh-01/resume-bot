#!/usr/bin/env bash
# docs-sync.sh — claude-driven doc audit + update
#
# Compares the current code surface (commands, schema, env, handlers, claude
# invocations) against the three docs and either:
#   --check (default) → prints drift; non-zero exit if any
#   --apply           → asks claude to write the updates back to the docs
#
# Cost: ~$0.05-0.20 per check, ~$0.30-0.50 per apply.
#
# Pre-req: claude CLI authenticated; pandoc-typst-tectonic NOT needed for this.

set -euo pipefail

MODE="${1:-check}"   # 'check' or 'apply'
case "$MODE" in
  --check|-c|check) MODE=check ;;
  --apply|-a|apply) MODE=apply ;;
  *) echo "usage: $0 [check|apply]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"

[ -d "$DOCS_DIR" ] || { echo "docs dir not found: $DOCS_DIR" >&2; exit 1; }

PROMPT_BASE="You are a documentation maintenance assistant for a Telegram resume-tailoring bot.

Read these files (paths under $REPO_ROOT for code, $DOCS_DIR for docs):

CODE (source of truth):
- src/index.ts (handler registrations + boot order)
- src/bot.ts (bot config)
- src/db.ts (schema + migrations + helpers)
- src/config.ts (env keys)
- src/runJob.ts (main flow including critic+refine)
- src/claude.ts (claude invocation wrappers)
- src/scrape.ts (Playwright scraper)
- src/render.ts (PDF render pipeline)
- src/middleware/allowlist.ts and preOnboarding.ts (gates)
- All files under src/handlers/
- src/templates/claudemd.ts (per-user template)

DOCS (target):
- $DOCS_DIR/how-to-journey.md (operational guide)
- $DOCS_DIR/tasks.md (build log; append-only — DO NOT edit prior sections)
- $DOCS_DIR/decisions.md (ADRs; append-only)

Reference (frozen):
- $DOCS_DIR/resume-bot-design.md (original v1 spec; do NOT modify)

Your job: identify drift between what the code does and what the docs say. Specifically check:
1. Every command registered in src/index.ts (bot.command(...)) is documented in how-to-journey.md command reference + present in /help if public.
2. Every env key required in src/config.ts is in how-to-journey.md Setup section.
3. Every DB table in src/db.ts schema is mentioned in how-to-journey.md Architecture or covered in tasks.md.
4. Every callback prefix dispatched in callbacks.ts is documented in how-to-journey.md.
5. Every claude invocation_type in src/claude.ts has a corresponding entry in tasks.md and (for non-trivial choices) an ADR in decisions.md.
6. ADR-014 (lever A) flow described in how-to-journey.md matches the code in runJob.ts."

if [ "$MODE" = "check" ]; then
  echo "🔍 Auditing docs vs code (read-only)..."
  PROMPT="$PROMPT_BASE

Output strictly in this format:

DRIFT_DETECTED: yes | no

If yes, list each drift item on its own line:
- <doc_file>: <missing or wrong>: <one-line description>

Be concise. No prose, just the list. If everything is in sync, output 'DRIFT_DETECTED: no' alone."

  cd "$REPO_ROOT"
  RESULT=$(claude -p "$PROMPT" --output-format text --allowedTools Read 2>&1)
  echo "$RESULT"
  if echo "$RESULT" | grep -qi "DRIFT_DETECTED: yes"; then
    echo
    echo "❌ Drift detected. Run '$0 apply' to have claude write the updates."
    exit 1
  fi
  echo "✅ Docs and code in sync."

elif [ "$MODE" = "apply" ]; then
  echo "✏️  Applying doc updates via claude (this may modify $DOCS_DIR/...)"
  PROMPT="$PROMPT_BASE

Apply the necessary updates to bring docs into sync with code.

Rules:
- Edit how-to-journey.md anywhere it has drifted (rewrite sections as needed; PRESERVE the overall structure).
- For tasks.md: ONLY append a new section at the end. Do NOT edit prior sections.
- For decisions.md: ONLY append a new ADR (next available ADR-NNN number). Do NOT edit prior ADRs.
- Do NOT modify resume-bot-design.md.
- Do NOT introduce new docs files.
- After editing, write a one-line summary of changes to $DOCS_DIR/.docs-sync-last.txt.

Use Read,Edit,Write tools."

  cd "$REPO_ROOT"
  claude -p "$PROMPT" --output-format text --allowedTools Read,Edit,Write
  echo
  if [ -f "$DOCS_DIR/.docs-sync-last.txt" ]; then
    echo "📝 $(cat "$DOCS_DIR/.docs-sync-last.txt")"
  fi
  echo "Done. Diff the docs and commit if it looks right."
fi
