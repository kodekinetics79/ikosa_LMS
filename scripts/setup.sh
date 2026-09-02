#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

for tool in docker node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing required tool: %s\n' "$tool" >&2
    exit 1
  fi
done

if [[ ! -f .env ]]; then
  cp .env.example .env
  printf 'Created .env from safe local defaults. Change all secrets before shared deployment.\n'
fi

docker compose -f compose.infrastructure.yaml up -d --wait

if [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f package.json ]]; then
  npm install
fi

if [[ -f e2e/package-lock.json ]]; then
  npm --prefix e2e ci
elif [[ -f e2e/package.json ]]; then
  npm --prefix e2e install
fi

printf '\nSetup complete. Start product processes with: ./scripts/run-local.sh\n'
