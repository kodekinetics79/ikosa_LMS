# SaaS control-plane provisioning

This runbook provisions the **global platform-owner control plane** introduced by
`database/postgres/003_saas_control_plane.sql` and the managed-tenant lifecycle
gate introduced by `database/postgres/004_tenant_lifecycle_gate.sql`.

The control plane is intentionally separate from the tenant runtime. A tenant
administrator must never gain the ability to enumerate or create other tenants,
and the normal `ik_osa_app` role must not be widened just because the commercial
operator needs tenant provisioning.

## 1. Apply migration 003

Apply `database/postgres/003_saas_control_plane.sql` with the normal migration
owner. It creates only schema objects and contains no credential.

Objects added:

- `osa.platform_operators`
- `osa.platform_sessions`
- `osa.tenant_control`
- `osa.platform_audit_events`

`platform_audit_events` is append-only for the application by privilege: the
control-plane role receives `SELECT, INSERT` and never `UPDATE` or `DELETE`.

## 2. Create a dedicated restricted login role

**Do not use a provider-created role until its effective privileges are proven.**
On the Neon project used during rehearsal, an API-created role inherited
`neon_superuser` and therefore reported `BYPASSRLS`, `CREATEROLE` and `CREATEDB`.
That is a release blocker.

Create/provision a role equivalent to:

```sql
CREATE ROLE ik_osa_control_plane
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS
  NOREPLICATION;
```

Set the password through the provider's secure credential mechanism. Never put a
real password or connection string in this repository.

Required role proof:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
FROM pg_roles
WHERE rolname = 'ik_osa_control_plane';
```

Expected:

```text
rolsuper=false
rolbypassrls=false
rolcreaterole=false
rolcreatedb=false
rolinherit=false
```

The role must also have no inherited memberships:

```sql
SELECT granted.rolname
FROM pg_auth_members membership
JOIN pg_roles member ON member.oid = membership.member
JOIN pg_roles granted ON granted.oid = membership.roleid
WHERE member.rolname = 'ik_osa_control_plane';
```

Expected result: empty.

## 3. Grant the narrow control-plane matrix

```sql
GRANT USAGE ON SCHEMA osa TO ik_osa_control_plane;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO ik_osa_control_plane;

GRANT SELECT, INSERT, UPDATE ON osa.platform_operators TO ik_osa_control_plane;
GRANT SELECT, INSERT, UPDATE, DELETE ON osa.platform_sessions TO ik_osa_control_plane;
GRANT SELECT, INSERT, UPDATE ON osa.tenant_control TO ik_osa_control_plane;
GRANT SELECT, INSERT ON osa.platform_audit_events TO ik_osa_control_plane;

-- Tenant bootstrap only. Forced RLS remains enabled on tenant-owned tables.
GRANT SELECT, INSERT, UPDATE ON osa.tenants TO ik_osa_control_plane;
GRANT SELECT, INSERT, UPDATE ON osa.org_units TO ik_osa_control_plane;
GRANT SELECT, INSERT, UPDATE ON osa.users TO ik_osa_control_plane;
GRANT SELECT, INSERT, UPDATE, DELETE ON osa.user_roles TO ik_osa_control_plane;
GRANT EXECUTE ON FUNCTION osa.current_tenant_id() TO ik_osa_control_plane;
```

The role receives no direct access to courses, evidence, assessments, TNA
studies, learner records or other tenant business data.

Verify platform audit immutability:

```sql
SELECT
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','SELECT') AS can_select,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','INSERT') AS can_insert,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','UPDATE') AS can_update,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','DELETE') AS can_delete;
```

Expected: `true, true, false, false`.

## 4. Apply migration 004 and lifecycle grants

`004_tenant_lifecycle_gate.sql` makes managed tenant state enforceable at the
PostgreSQL RLS layer. It adds:

- `osa.runtime_tenant_control()` — returns commercial state only for the tenant
  already established in `app.tenant_id`;
- `osa.tenant_runtime_enabled()` — the boolean used by tenant RLS policies;
- `osa.revoke_tenant_sessions(uuid)` — narrow cross-tenant operation used by the
  platform owner when tenant state changes.

After applying migration 004, grant only these runtime capabilities:

```sql
GRANT EXECUTE ON FUNCTION osa.runtime_tenant_control() TO ik_osa_app;
GRANT EXECUTE ON FUNCTION osa.revoke_tenant_sessions(uuid) TO ik_osa_control_plane;
```

Lifecycle behavior is intentionally fail-closed:

```text
Unmanaged tenant                 -> allowed (backward-compatible rollout)
Managed + active                 -> allowed
Managed + unexpired trial        -> allowed
Managed + expired trial          -> denied by RLS
Managed + suspended              -> denied by RLS
Suspend/reactivate state change  -> all tenant sessions revoked
```

The control-plane role still receives no `SELECT` on `osa.sessions`; it can only
invoke the single-purpose revocation function and receive the number revoked.

The rehearsal on an isolated Neon branch proved this using the actual
`ik_osa_app` runtime role:

- unmanaged Northstar: 5 visible users;
- managed active Northstar: 5 visible users;
- expired trial: 0 visible users;
- suspended: 0 visible users;
- future trial: 5 visible users;
- restricted control-plane role revoked one test session through
  `osa.revoke_tenant_sessions()` while direct session-table reads remained denied.

## 5. Configure application secrets

Store a connection string for the restricted control-plane role as an encrypted
deployment secret:

```text
CONTROL_PLANE_DATABASE_URL=<restricted role connection string>
```

Production deliberately refuses to fall back to the tenant `DATABASE_URL` for
control-plane work. Startup also verifies the connected role has no superuser,
BYPASSRLS, CREATEROLE, CREATEDB, inherited memberships or OSA table ownership.

Configure platform-owner bootstrap secrets:

```text
PLATFORM_ADMIN_NAME=<operator display name>
PLATFORM_ADMIN_EMAIL=<operator email>
PLATFORM_ADMIN_PASSWORD=<strong bootstrap password>
PLATFORM_AUTH_SECRET=<at least 32 random bytes>
```

On the first successful `/platform-admin/login`, if no platform operator exists,
those bootstrap credentials create one operator. Once an operator exists, the
bootstrap path stops creating accounts.

## 6. Verify tenant provisioning

A successful **New tenant** operation is one transaction:

```text
osa.tenants
  -> SET LOCAL app.tenant_id = new tenant
  -> osa.org_units (root)
  -> osa.users (first admin)
  -> osa.user_roles (tenant_admin)
  -> osa.tenant_control (plan, capacity, modules)
  -> osa.platform_audit_events
  -> COMMIT
```

Any failure rolls back the complete customer setup.

Tenant-admin account and organization changes are also transactionally coupled
to the normal tenant audit chain. Password reset changes the password hash,
revokes that user's sessions and appends its audit event in one transaction.

## 7. Production gate

Do not enable `/platform-admin` for customer operations until all are true:

- migrations 003 and 004 are applied;
- the control-plane login passes the role-attribute and privilege checks above;
- `CONTROL_PLANE_DATABASE_URL` uses that restricted login, not a migration owner;
- platform bootstrap secrets are configured through the deployment secret store;
- platform login succeeds;
- one throwaway pilot tenant is created and its first tenant admin can sign in;
- tenant suspension blocks runtime access and revokes sessions;
- tenant-admin password reset invalidates prior sessions;
- cross-tenant reads remain empty under the new tenant context;
- platform audit UPDATE/DELETE are denied;
- release evidence and cleanup are retained for the pilot gate.
