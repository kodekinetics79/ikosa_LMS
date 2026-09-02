#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .next/standalone/server.js ]]; then
  printf 'Production bundle not found; run npm run build first.\n' >&2
  exit 1
fi

test_data_dir="$(mktemp -d /tmp/ik-osa-integration.XXXXXX)"
server_log="$test_data_dir/server.log"
HOSTNAME=127.0.0.1 PORT=3000 IK_DATA_DIR="$test_data_dir/data" node .next/standalone/server.js >"$server_log" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

./scripts/wait-for-http.sh http://127.0.0.1:3000/api/health 30
node --test --test-concurrency=1 tests/integration/live-api.test.mjs
