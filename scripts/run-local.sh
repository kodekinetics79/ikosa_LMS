#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  printf 'Run ./scripts/setup.sh first.\n' >&2
  exit 1
fi

docker compose -f compose.infrastructure.yaml up -d --wait
npm run dev &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true' EXIT INT TERM

./scripts/wait-for-http.sh "${APP_URL:-http://localhost:3000}/api/health" 120
printf 'iK OSA is ready: %s\n' "${APP_URL:-http://localhost:3000}"
wait "$app_pid"

