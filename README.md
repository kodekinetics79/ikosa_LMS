# iK Operational Skills Assurance

Enterprise continuous-TNA and workforce-readiness platform: from a business change to a defensible claim that a named person was qualified at the moment they did the work.

## What makes this different from an LMS

Most learning platforms answer *"did they complete the course?"*. This one answers *"can they do the work, and can you prove it?"*. The learning module is not a separate product bolted alongside the assurance spine — it is the fulfilment engine for the intervention step:

```text
Signal → TNA study → Requirement → Gap case → Intervention → Course → Evidence → Ledger
```

The rule that makes the claim defensible: **a course may only emit competence evidence if it actually assesses.** An attendance-only briefing records attendance and emits nothing. An assessed course that was failed emits nothing, and stays open so the learner can retake it. Manufacturing competence evidence from a watched video is how a training log quietly becomes an unqualified person on a safety-critical roster.

Emitted evidence is machine-attested (`assessorUserId` is null), carries confidence derived from the achieved score rather than assumed, expires according to the course's validity period, and is written to a tamper-evident ledger in the same transaction as the completion.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://127.0.0.1:3000` and sign in with a seeded identity from `.env.example`.

## Verification

```bash
npm run verify     # typecheck + unit tests + production build
npm run test:e2e   # Playwright journeys (requires the dev server running)
```

Release gates and the manual verification checklist live in `docs/`. Nothing is considered delivered because it renders: `docs/TEST_STRATEGY.md` sets the standard, and `docs/RELEASE_EVIDENCE_CHECKLIST.md` is the sign-off.

## Architecture

- **Authorization** is server-side and default-deny. Tenant context comes from the session, never from a request parameter. Delegated organizational paths scope every record, and `src/proxy.ts` gates the authenticated shell before render while the route group layout performs the authoritative check. An authorization decision must never exist only in UI code — see `database/ADR-001-tenant-data-security.md`.
- **The audit ledger** is append-only and chained **per tenant** with HMAC-SHA256 under a per-tenant derived key, so an auditor holding only their own tenant's events can reproduce the chain, and an attacker holding the datastore cannot forge one. Tamper detection is proven by tests, not asserted.
- **Persistence** is currently a single-file JSON store, correct for a demo and explicitly not for a customer: it rewrites the whole file per write and cannot run multi-instance. `database/postgres/` holds the production schema with forced row-level security; `docs/ADR-002-persistence-migration.md` records the cutover plan.
- **Evidence is the single authority on capability.** An enrollment records learning progress only. Readiness is derived from evidence at request time; no screen may display a figure the system of record disagrees with.

## Known limitations

These are real and deliberately stated rather than discovered later:

- The JSON datastore is a hard scaling ceiling and is single-instance only. The login throttle is in-memory for the same reason.
- Learning content standards (SCORM, xAPI, cmi5, LTI) are not implemented; the module model reserves a `scorm` kind to land against.
- There is no identity provider integration (SSO/SAML/OIDC/SCIM) and no user administration — accounts exist only through seeding.
- The notification sweep has no scheduler; it runs when invoked.
- The Arabic toggle switches document direction and alignment but does not translate copy.
