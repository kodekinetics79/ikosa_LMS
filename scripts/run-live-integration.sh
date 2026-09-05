#!/usr/bin/env bash
#
# Runs the live API suite against a production bundle.
#
# PostgreSQL is the system of record, so that is what this exercises. When a
# disposable database is reachable the bundle runs the way a deployment runs:
# NODE_ENV=production, real secrets, migrations applied, connected as the
# restricted ADR-001 runtime role, with RLS enforcing the tenant boundary.
#
# WITHOUT a database it falls back to the deterministic local fixture mode and
# says so. That mode is a real, explicitly-selected configuration — not a
# production instance with its checks removed. The production fail-closed
# behaviour is unchanged in both cases: a bundle with NODE_ENV=production and no
# DATABASE_URL still refuses to start, which is the whole point of the check.
#
# Environment:
#   IK_ADMIN_DATABASE_URL   admin connection to a DISPOSABLE database.
#                           Defaults to the compose service on 127.0.0.1:5432.
#   IK_SKIP_DB              set to 1 to force fixture mode.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .next/standalone/server.js ]]; then
  printf 'Production bundle not found; run npm run build first.\n' >&2
  exit 1
fi

# `next build` does not copy .next/static into the standalone tree. Without it
# every page serves with no stylesheet and no client JavaScript.
./scripts/assemble-standalone.sh >/dev/null

port="${IK_INTEGRATION_PORT:-3000}"
base_url="http://127.0.0.1:${port}"
work_dir="$(mktemp -d /tmp/ik-osa-integration.XXXXXX)"
server_log="$work_dir/server.log"
runtime_url_file="$work_dir/runtime-url"

# Test-only secrets, generated per run. They are never a production value and
# never leave this machine; the point is that the bundle boots with the same
# requirements a deployment has rather than with the requirements relaxed.
auth_secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
audit_secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

admin_url="${IK_ADMIN_DATABASE_URL:-postgresql://ik_osa:local-only-change-me@127.0.0.1:5432/ik_osa}"
mode="fixture"

if [[ "${IK_SKIP_DB:-0}" != "1" ]] && node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.argv[1], connectionTimeoutMillis: 3000 });
  c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
' "$admin_url" >/dev/null 2>&1; then
  mode="postgres"
fi

if [[ "$mode" == "postgres" ]]; then
  printf '== PostgreSQL mode: provisioning a disposable database ==\n'
  IK_ADMIN_DATABASE_URL="$admin_url" IK_RUNTIME_URL_FILE="$runtime_url_file" \
    ./scripts/provision-test-database.sh >"$work_dir/provision.log" 2>&1 || {
      printf 'Provisioning failed:\n' >&2; cat "$work_dir/provision.log" >&2; exit 1;
    }
  printf '== Starting the production bundle against PostgreSQL ==\n'
  DATABASE_URL="$(cat "$runtime_url_file")" \
  AUTH_SECRET="$auth_secret" \
  AUDIT_HASH_SECRET="$audit_secret" \
  DEFAULT_TENANT_SLUG=northstar \
  HOSTNAME=127.0.0.1 PORT="$port" \
    node .next/standalone/server.js >"$server_log" 2>&1 &
else
  printf '== No database reachable at %s ==\n' "$(node -e 'try{const u=new URL(process.argv[1]);process.stdout.write(u.hostname+":"+(u.port||5432))}catch{process.stdout.write("(unparseable)")}' "$admin_url")"
  printf '== Fixture mode: assessment coverage will report as skipped ==\n'
  # Explicitly a fixture-mode bundle over the JSON store. NOT a production
  # instance with its datastore checks disabled: fixture mode is a named
  # configuration that refuses to start if a real datastore is reachable, and a
  # bundle without it still fails closed. `NODE_ENV=development` cannot be used
  # here - Next.js overwrites it inside the standalone server.
  IK_RUNTIME_MODE=fixture \
  DATABASE_URL= \
  CONTROL_PLANE_DATABASE_URL= \
  AUTH_SECRET="$auth_secret" \
  AUDIT_HASH_SECRET="$audit_secret" \
  IK_DATA_DIR="$work_dir/data" \
  HOSTNAME=127.0.0.1 PORT="$port" \
    node .next/standalone/server.js >"$server_log" 2>&1 &
fi
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! ./scripts/wait-for-http.sh "$base_url/api/health" 60; then
  printf 'Server did not become healthy. Log follows:\n' >&2
  cat "$server_log" >&2
  exit 1
fi

set +e
E2E_BASE_URL="$base_url" node --test --test-concurrency=1 tests/integration/live-api.test.mjs
status=$?
set -e

if [[ $status -ne 0 ]]; then
  printf '\n== Server log ==\n' >&2
  cat "$server_log" >&2
fi
exit $status
