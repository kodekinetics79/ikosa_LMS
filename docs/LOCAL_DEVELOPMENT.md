# Local development and VS Code handoff

## Prerequisites

- Docker Desktop or Docker Engine with Compose v2
- Node.js 22 LTS and npm 10+
- Git and a current Chrome browser

## One-command setup

```bash
cp .env.example .env
./scripts/setup.sh
```

The setup starts PostgreSQL, restores application dependencies and keeps local infrastructure data in a named Docker volume. The current developer adapter stores seeded application data under `IK_DATA_DIR`; the production relational schema is under `database/postgres`. The values in `.env.example` are development-only and must never be used in a shared environment.

Start the API and web application from one terminal:

```bash
./scripts/run-local.sh
```

Open `http://localhost:3000`. Health is exposed at `http://localhost:3000/api/health`.

To run every component in containers:

```bash
docker compose up --build --wait
```

## Realistic demonstration identities

| Role | Email | Intended verification |
|---|---|---|
| Tenant admin | `admin@northstar.example` | administration and scoped access |
| TNA analyst | `analyst@northstar.example` | complete TNA lifecycle |
| Manager | `manager@northstar.example` | observations, evidence and interventions |
| Learner | `technician@northstar.example` | personal readiness and authorization denial checks |
| Auditor | `admin@northstar.example` | immutable audit exploration in this initial slice |

Local password: `Demo!2026`. A second seeded tenant exists only to prove isolation. Northstar personas must never retrieve its records.

## Verification

With the application running:

```bash
./scripts/smoke.sh
npm run test:e2e -- --project=chromium --grep @critical
./scripts/verify.sh
```

Playwright retains traces, screenshots and video only on failure. Open the HTML report with `npx playwright show-report e2e/playwright-report`.

## Reset local data

Reset is destructive and intended only for local development:

```bash
docker compose -f compose.infrastructure.yaml down
docker volume ls --filter name=ik-osa-infrastructure
```

Remove only the explicitly named local PostgreSQL volume after confirming its name. Then rerun `./scripts/setup.sh`; the development data adapter recreates its seed on first API access.
