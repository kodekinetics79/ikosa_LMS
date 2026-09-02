# ADR-001: Tenant data and authorization spine

**Status:** Accepted for R0/R1  
**Decision date:** 2026-08-25

## Decision

1. PostgreSQL is the production source of truth. The R0 downloadable build uses a persistent, atomically written local datastore so it starts without external infrastructure; its repository boundary is intentionally replaceable.
2. Tenant context is derived from the authenticated session. APIs do not accept a tenant identifier as authorization evidence.
3. Authorization combines understandable roles with delegated organizational paths and relationship checks. The server defaults to deny, and the browser is never the enforcement point.
4. Every tenant table contains `tenant_id`, uses tenant-qualified foreign keys, and has forced PostgreSQL RLS in production. The runtime role cannot own tables or receive `BYPASSRLS`.
5. Evidence creation enforces assessor/subject separation of duties. Learners can see only their own subject records. Tenant administrators and analysts remain limited to delegated organizational scope.
6. Security and business events use an append-only SHA-256 hash chain. This is tamper-evident, not immutable; durable production exports should additionally use a signed manifest and retention-locked object storage.
7. State-changing APIs require a session-bound CSRF token. Sessions are HttpOnly, SameSite cookies and become Secure in production.

## Consequences

- A missed application predicate is still blocked by database RLS in production.
- Pooled regional cells can be offered safely while dedicated databases remain an enterprise deployment option.
- Organizational restructuring and historical readiness require later bitemporal expansion; the initial schema already preserves validity periods and versions on decision-critical records.
- Search, object storage, queues and caches must repeat the same tenant namespace and authorization labels before being introduced.

## Release blockers

- Any successful cross-tenant read or write.
- Runtime database role has table ownership or `BYPASSRLS`.
- An authorization decision exists only in UI code.
- Evidence can be self-verified by an assessor.
- Audit-chain verification fails or required privileged events are absent.
