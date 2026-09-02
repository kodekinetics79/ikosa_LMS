# Operations runbook

## Health contract

- `/api/health`: reports process status and the active persistence adapter without leaking configuration or secrets.
- Production readiness must additionally verify authoritative database connectivity and migration state before receiving traffic.
- Dependency-specific metrics expose Redis, object storage and worker degradation without leaking credentials or tenant data.

## First response

1. Confirm incident time, environment, release digest and affected tenant/region.
2. Check readiness, request error rate, latency and saturation before reading individual logs.
3. Trace one failed correlation ID across edge, authorization, application, database and event processing.
4. Preserve audit/security evidence. Never repair the audit ledger with direct mutation.
5. Prefer traffic drain, feature kill switch, consumer pause or deployment rollback over ad hoc production edits.

## Failure modes

| Symptom | First checks | Safe response |
|---|---|---|
| Login failure spike | identity-provider health, cookie/config change, clock skew | pause rollout; keep break-glass controlled and audited |
| Readiness endpoint fails | database connectivity, migration state, connection pool | remove instance from service; do not mark live process dead |
| Evidence upload fails | object-store health, size/type policy, signed URL expiry | retain draft metadata; retry idempotently; show truthful state |
| Projection lag | queue depth, consumer errors, poison event/DLQ | preserve source event; isolate poison item; rebuild projection |
| Cross-tenant suspicion | authorization decisions, route/tenant resolution, cache/index labels | declare security incident; disable affected surface; preserve logs |
| Audit chain mismatch | sequence gap, manifest signature, clock/source | freeze export claims; preserve store; escalate to security owner |

## Recovery evidence

Quarterly, restore the latest production-shaped backup into an isolated environment, verify migrations, tenant counts, evidence object checksums and audit manifest validation, then record measured RPO/RTO. A successful provider snapshot alone is not a restore test.
