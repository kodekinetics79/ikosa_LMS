#!/usr/bin/env bash
set -euo pipefail

app_url="${E2E_BASE_URL:-http://127.0.0.1:3000}"
curl --fail --silent --show-error "$app_url/api/health" >/dev/null
curl --fail --silent --show-error "$app_url/login" >/dev/null
printf 'Smoke checks passed for %s\n' "$app_url"

