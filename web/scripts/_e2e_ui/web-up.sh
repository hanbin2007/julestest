#!/usr/bin/env bash
# LANE B — launch the ISOLATED web on alternate port 3001, pointed at the isolated
# DB + isolated gateway. Stays up until killed (SIGINT/SIGTERM/kill).
#
# Isolation (NEVER touches prod :3000 / :8808 / ~/.youdao_course/app.db):
#   PORT=3001
#   GATEWAY_ORIGIN=http://127.0.0.1:18808   (isolated gateway; may be offline — status route has DB fallback)
#   DATABASE_URL=file:/tmp/yd_e2e_ui/app.db (isolated sqlite, seeded by seed.mjs)
#
# The worktree's .next build already exists (prior `npm run build`). If missing, build first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"   # .../web

# Keep these in sync with cfg.mjs (WEB_PORT / GW_PORT / DB_FILE).
PORT="${PORT:-3001}"
GATEWAY_ORIGIN="${GATEWAY_ORIGIN:-http://127.0.0.1:18808}"
DATABASE_URL="${DATABASE_URL:-file:/tmp/yd_e2e_ui/app.db}"

cd "$WEB_DIR"

if [ ! -f ".next/BUILD_ID" ]; then
  echo "[web-up] .next build missing → building (this is a one-time cost)…"
  PORT="$PORT" GATEWAY_ORIGIN="$GATEWAY_ORIGIN" DATABASE_URL="$DATABASE_URL" npm run build
fi

echo "[web-up] starting isolated web: PORT=$PORT GATEWAY_ORIGIN=$GATEWAY_ORIGIN DATABASE_URL=$DATABASE_URL"
exec env \
  PORT="$PORT" \
  GATEWAY_ORIGIN="$GATEWAY_ORIGIN" \
  DATABASE_URL="$DATABASE_URL" \
  npm start
