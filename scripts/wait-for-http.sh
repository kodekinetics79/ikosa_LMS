#!/usr/bin/env bash
set -euo pipefail

url="${1:?Usage: wait-for-http.sh URL [SECONDS]}"
timeout_seconds="${2:-90}"
start_epoch="$(date +%s)"

until curl --fail --silent --max-time 5 "$url" >/dev/null; do
  now_epoch="$(date +%s)"
  if (( now_epoch - start_epoch >= timeout_seconds )); then
    printf 'Timed out waiting for %s after %ss\n' "$url" "$timeout_seconds" >&2
    exit 1
  fi
  sleep 2
done
