# Release evidence checklist

Release: __________  Commit/tag: __________  Environment: __________  Owner: __________

## Product truth

- [ ] Scope maps to approved stories and acceptance criteria.
- [ ] TNA and readiness calculations reconcile to named fixtures.
- [ ] Unknown evidence is not presented as failure or competence.
- [ ] Training and non-training interventions are both supported.
- [ ] AI output remains draft and requires authorized human action.

## Automated evidence

- [ ] Backend unit and PostgreSQL integration tests pass.
- [ ] Frontend component/type/lint/build checks pass.
- [ ] Critical Chromium Playwright journeys pass with report retained.
- [ ] Cross-tenant API, route, export and authorization negative tests pass.
- [ ] Axe scan has no serious/critical violation on critical routes.
- [ ] Dependency, secret, SAST, IaC and container scans meet policy.
- [ ] SBOM and signed artifact digest are attached.

## Human verification

- [ ] Product owner completed TNA journey using realistic data.
- [ ] Keyboard-only critical journeys pass.
- [ ] NVDA/Chrome or equivalent desktop screen-reader journey passes.
- [ ] VoiceOver/iOS or equivalent mobile journey passes.
- [ ] Arabic native reviewer approves critical terminology and RTL behavior.
- [ ] Responsive verification completed at 320, 375, 768, 1280 and 1440 CSS pixels.
- [ ] Empty, loading, validation, permission-denied and degraded states are truthful.

## Security and privacy

- [ ] Threat model and abuse cases reflect this release.
- [ ] No caller-supplied tenant identifier can widen scope.
- [ ] Session, CSRF, CSP, rate and upload controls verified.
- [ ] Audit chain verification passes; authorization denials generate telemetry.
- [ ] Retention, export and deletion behavior has evidence or an explicit scope statement.
- [ ] Secrets and local demo credentials are absent from production configuration.

## Operability and recovery

- [ ] `/api/health` passes and the production readiness probe verifies database connectivity plus migration state.
- [ ] Dashboard/log/trace correlation verified without sensitive payloads.
- [ ] Database migration, rollback and backup restore rehearsed.
- [ ] Deployment rollback uses the same signed artifact by digest.
- [ ] On-call runbook, support notes and known limitations are current.

## Decision

- [ ] GO
- [ ] CONDITIONAL GO — approved exceptions attached with owner and expiry
- [ ] NO-GO

Approvers: Product ______  Engineering ______  Security ______  Accessibility ______  Operations ______
