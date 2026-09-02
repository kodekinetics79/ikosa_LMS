# Data layer

Local development uses a dependency-free persistent JSON database at `.data/ik-osa-dev.json`. It is created and realistically seeded on first API access. Writes are serialized and committed with a same-filesystem atomic rename. Set `IK_DATA_DIR` to move the development data directory.

The production baseline is `postgres/001_initial.sql` for PostgreSQL 16+. It models tenant-qualified composite foreign keys, valid-time fields where decisions can change, append-only audit events, and forced row-level security on every tenant table.

Production transactions must derive the tenant and actor from the validated identity, then run:

```sql
BEGIN;
SET LOCAL app.tenant_id = 'authenticated-tenant-uuid';
SET LOCAL app.user_id = 'authenticated-user-uuid';
-- parameterized domain statements
COMMIT;
```

The runtime database role must not own tables and must not have `BYPASSRLS`. Request payloads, query parameters, and browser headers are never authoritative sources of tenant context.

Development reset is deliberately disabled unless `IK_ENABLE_DEV_RESET=true` and `IK_DEV_RESET_KEY` is set. Then `POST /api/dev/reset` requires the key in `x-dev-reset-key`. The route always returns 404 in production.
