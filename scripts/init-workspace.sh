#!/usr/bin/env bash
# Idempotent. Creates the workspace tree under ~/bot/.
# See resume-bot-design.md §4 (filesystem layout) and §8 (security).

set -euo pipefail

ROOT="${HOME}/bot"

mkdir -p \
  "${ROOT}/users" \
  "${ROOT}/archive" \
  "${ROOT}/logs" \
  "${ROOT}/templates" \
  "${ROOT}/secrets"

# 0700 on dirs that hold user data and credentials.
chmod 700 "${ROOT}/users"
chmod 700 "${ROOT}/secrets"

echo "workspace ready at ${ROOT}"
