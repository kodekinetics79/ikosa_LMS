#!/usr/bin/env bash
#
# Completes a `next build --output standalone` bundle so it can actually serve a
# page.
#
# `next build` writes `.next/standalone/server.js` and the server manifests, but
# it does NOT copy `.next/static` (or `public`) into that tree — the Next.js
# documentation says to do it yourself, and this repository's Dockerfile does.
# Nothing else did.
#
# The consequence was invisible in the API tests and fatal in the browser ones:
# every request for `/_next/static/chunks/*.js` returned 404 with a `text/plain`
# body, the browser refused it as a script, and every page rendered with no
# stylesheet and no client JavaScript at all. So every Playwright journey that
# clicked anything was driving a page whose React had never hydrated.
#
# Runs after `npm run build`, and is idempotent.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Vercel builds its own output: next.config.ts sets `output: undefined` when the
# VERCEL env var is present, precisely because a standalone build makes Vercel
# report `No Output Directory named "public"`. So an absent bundle is a normal,
# correct state there and must not fail the build — chaining this into
# `npm run build` without this branch broke every Vercel deployment while CI
# stayed green, because CI is the only place that produces a standalone bundle.
if [[ ! -f .next/standalone/server.js ]]; then
  printf 'No standalone bundle in this build (Vercel builds its own output); nothing to assemble.\n'
  exit 0
fi

if [[ ! -d .next ]]; then
  printf 'No .next directory at all. The build did not run.\n' >&2
  exit 1
fi

if [[ ! -d .next/static ]]; then
  printf 'No .next/static to copy. The build did not complete.\n' >&2
  exit 1
fi

mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -R .next/static .next/standalone/.next/static

# `public/` is optional in this repository and absent today. Copy it if a later
# change adds one, rather than leaving a second thing to remember.
if [[ -d public ]]; then
  rm -rf .next/standalone/public
  cp -R public .next/standalone/public
fi

printf 'Standalone bundle assembled: %s static file(s).\n' "$(find .next/standalone/.next/static -type f | wc -l | tr -d ' ')"
