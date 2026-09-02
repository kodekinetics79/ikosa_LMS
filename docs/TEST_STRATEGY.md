# Verification strategy

## Release principle

No screen is considered delivered because it renders. A release must prove the complete browser-to-API-to-database story, authorization boundaries, audit evidence and recovery behavior using realistic roles and data.

## Test layers

1. Domain unit tests protect readiness, evidence-strength, gap, intervention and state-transition rules.
2. Live API integration tests exercise the current persisted developer adapter; the PostgreSQL adapter must later repeat the same suite plus RLS, migration, concurrency and rollback checks before production readiness.
3. Contract tests protect the web/API boundary and health/operability endpoints.
4. Real-browser Playwright journeys exercise Chrome first, then Firefox/WebKit and representative mobile profiles.
5. Accessibility combines axe gates with keyboard, screen-reader, zoom/reflow, forced-colors and reduced-motion verification.
6. Security verification covers OWASP ASVS L2 controls, tenant escape, CSRF/XSS, object/field authorization, upload safety, export scope and session hardening.
7. Operational tests cover backup/restore, migration rollback, duplicate/out-of-order events, dependency loss and truthful degraded states.

## Required seed scenario

Northstar Utilities operates regional field teams. Lockout/Tagout is mandatory at proficiency level 4 under the named regulatory and SOP source, while fault diagnosis is required at level 3 after a corrective action. Sam Rivera has recent but below-threshold evidence. The verified flow creates a TNA, records an authorized manager observation, routes a non-training process intervention, and lets an authorized administrator trace resulting events through the hash chain.

Gulf Energy Services is a second tenant containing uniquely recognizable fixtures. No Northstar identity, filter, export, ID guess, search, async job, file URL or cache key may reveal Gulf data.

## Critical acceptance journeys

- Invalid and valid authentication, logout and hardened session behavior.
- TNA scope → requirement → evidence plan → gap → root cause → intervention → approval.
- Evidence submission → review → readiness recalculation → acknowledgement/appeal.
- Role- and organization-scoped access, including direct URL and API negative tests.
- Auditor drill-through and hash-chain verification with no mutation controls.
- English LTR and Arabic RTL at desktop and mobile widths.
- Keyboard-only and automated WCAG 2.2 AA checks on every critical path.

## Release gates

- Zero unresolved severity 1 or 2 defects.
- Zero exploitable cross-tenant or privilege-escalation defect.
- No serious or critical axe violation on covered critical routes; manual critical-path accessibility pass recorded.
- Critical Playwright journeys pass in Chromium; supported-engine matrix passes before GA.
- All calculations reconcile to fixtures and show source, freshness, confidence and as-of time.
- Audit events exist for authentication, authorization denials, TNA approval, evidence, readiness override and export.
- Database migration upgrade and rollback are rehearsed on a production-shaped snapshot.
- Restore test meets the declared RPO/RTO evidence gate for the edition.
