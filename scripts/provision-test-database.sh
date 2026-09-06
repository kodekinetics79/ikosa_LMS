#!/usr/bin/env bash
#
# Provisions a DISPOSABLE PostgreSQL database to the shape the application
# expects: every migration applied, a runtime login that satisfies ADR-001
# (NOBYPASSRLS, not a superuser, owns no table in schema osa), and the demo
# fixture loaded through the same write-mapping the application uses.
#
# This is the harness both CI and a local rehearsal run, so "it worked on my
# machine" and "it worked in CI" mean the same thing.
#
# IT MUST NEVER BE POINTED AT PRODUCTION. It creates roles, applies DDL and
# loads fixture accounts with a published password. The guard below refuses any
# host that is not local unless IK_ALLOW_REMOTE_PROVISION=yes is set
# deliberately.
#
# Usage:
#   IK_ADMIN_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/ik_osa \
#     ./scripts/provision-test-database.sh
#
# Writes the runtime connection string to $IK_RUNTIME_URL_FILE (default
# /tmp/ik-runtime-url) so nothing has to echo a credential to a build log.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

admin_url="${IK_ADMIN_DATABASE_URL:-${DATABASE_URL_UNPOOLED:-}}"
if [[ -z "$admin_url" ]]; then
  printf 'IK_ADMIN_DATABASE_URL is not set. Point it at a disposable database.\n' >&2
  exit 1
fi

runtime_role="${IK_RUNTIME_ROLE:-ik_osa_app}"
runtime_password="${IK_RUNTIME_PASSWORD:-}"
runtime_url_file="${IK_RUNTIME_URL_FILE:-/tmp/ik-runtime-url}"

# --- Refuse anything that is not obviously disposable ------------------------
host="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.hostname)' "$admin_url")"
is_local=no
case "$host" in
  127.0.0.1|localhost|::1|postgres|db) is_local=yes ;;
  *)
    if [[ "${IK_ALLOW_REMOTE_PROVISION:-no}" != "yes" ]]; then
      printf 'Refusing to provision %s: it is not a local host.\n' "$host" >&2
      printf 'This script creates roles and loads demo credentials. Set IK_ALLOW_REMOTE_PROVISION=yes only for a throwaway database branch.\n' >&2
      exit 1
    fi
    ;;
esac

# The migrations are forward-only, not idempotent: re-running 001 against a
# migrated database stops at `type "record_status" already exists`. A test
# database is supposed to be reproducible from nothing, so drop the schema
# first. On a local host that is the default; anywhere else it must be asked
# for by name, because DROP SCHEMA CASCADE is not a thing to do by accident.
reset="${IK_RESET_TEST_DATABASE:-}"
if [[ -z "$reset" ]]; then
  reset=$([[ "$is_local" == "yes" ]] && echo yes || echo no)
fi

if [[ -z "$runtime_password" ]]; then
  runtime_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
fi

psql_admin() { psql "$admin_url" -v ON_ERROR_STOP=1 --quiet "$@"; }

if [[ "$reset" == "yes" ]]; then
  printf 'Resetting schema osa on %s\n' "$host"
  psql "$admin_url" -v ON_ERROR_STOP=1 --quiet -c 'DROP SCHEMA IF EXISTS osa CASCADE'
fi

printf 'Provisioning runtime role %s\n' "$runtime_role"
# The runtime login is created BEFORE the migrations so migration 002's grant
# section finds it and applies the narrow grant matrix rather than skipping with
# a NOTICE. NOBYPASSRLS/NOSUPERUSER/NOCREATEDB/NOCREATEROLE are the ADR-001
# release blockers; the migration itself re-checks two of them and aborts.
psql_admin <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${runtime_role}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', '${runtime_role}', '${runtime_password}');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', '${runtime_role}', '${runtime_password}');
  END IF;
END
\$\$;
SQL

for migration in database/postgres/0*.sql; do
  printf 'Applying %s\n' "$migration"
  # `osa.runtime_role` is read by the grant sections of 002 and 007.
  PGOPTIONS="-c osa.runtime_role=${runtime_role}" psql_admin -f "$migration"
done

# Compose the runtime connection string from the admin one so the host, port,
# database and sslmode are identical and only the credentials differ.
runtime_url="$(node -e '
  const url = new URL(process.argv[1]);
  url.username = process.argv[2];
  url.password = process.argv[3];
  process.stdout.write(url.toString());
' "$admin_url" "$runtime_role" "$runtime_password")"

umask 077
printf '%s' "$runtime_url" > "$runtime_url_file"
printf 'Runtime connection string written to %s\n' "$runtime_url_file"

printf 'Loading demo fixture\n'
IK_ADMIN_DATABASE_URL="$admin_url" \
IK_RUNTIME_DATABASE_URL="$runtime_url" \
IK_RUNTIME_URL_FILE="$runtime_url_file" \
  node --import tsx scripts/provision-postgres.mjs

printf 'Disposable database ready.\n'
