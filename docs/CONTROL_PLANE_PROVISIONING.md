# SaaS control-plane provisioning

This runbook provisions the **global platform-owner control plane** introduced by
`database/postgres/003_saas_control_plane.sql`.

The control plane is intentionally separate from the tenant runtime. A tenant
administrator must never gain the ability to enumerate or create other tenants,
and the normal `ik_osa_app` role must not be widened just because the commercial
operator needs tenant provisioning.

## 1. Apply migration 003

Apply `database/postgres/003_saas_control_plane.sql` with the normal migration
owner. The migration creates only schema objects; it creates no login role and
contains no credential.

Objects added:

- `osa.platform_operators`
- `osa.platform_sessions`
- `osa.tenant_control`
- `osa.platform_audit_events`

`platform_audit_events` is application-append-only by privilege: the runtime
control-plane role receives `SELECT, INSERT` and never `UPDATE` or `DELETE`.

## 2. Create a dedicated restricted login role

**Do not use the generic Neon "create role" API result without inspecting it.**
On the managed Neon project used during migration rehearsal, an API-created role
was automatically a member of `neon_superuser` and reported `BYPASSRLS`,
`CREATEROLE` and `CREATEDB`. That is a release blocker for this workload.

Create the role from a controlled administrator connection instead. The role
must be a login role but must have no database-administration powers and no
inherited membership:

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

Set its password through the database provider's secure credential mechanism or
an administrator session. Never put it in this repository.

Before granting anything, prove the attributes:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
FROM pg_roles
WHERE rolname = 'ik_osa_control_plane';
```

Required result:

```text
rolsuper=false
rolbypassrls=false
rolcreaterole=false
rolcreatedb=false
rolinherit=false
```

Also prove it is not a member of any privileged role:

```sql
SELECT granted.rolname
FROM pg_auth_members membership
JOIN pg_roles member ON member.oid = membership.member
JOIN pg_roles granted ON granted.oid = membership.roleid
WHERE member.rolname = 'ik_osa_control_plane';
```

The result must be empty.

## 3. Grant the narrow control-plane matrix

```sql
GRANT USAGE ON SCHEMA osa TO ik_osa_control_plane;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO ik_osa_control_plane;

-- Global control-plane state.
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

The role does **not** receive access to courses, evidence, assessments, TNA
studies, learner records, or tenant business data. It can create the minimum
identity/organization records required to hand a customer its first tenant admin.

Verify audit immutability from the application role:

```sql
SELECT
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','SELECT') AS can_select,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','INSERT') AS can_insert,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','UPDATE') AS can_update,
  has_table_privilege('ik_osa_control_plane','osa.platform_audit_events','DELETE') AS can_delete;
```

Required: `true, true, false, false`.

## 4. Configure the application environment

Create a connection string for `ik_osa_control_plane` and store it as an
encrypted deployment secret:

```text
CONTROL_PLANE_DATABASE_URL=<restricted role connection string>
```

The production application deliberately refuses to fall back to `DATABASE_URL`
for control-plane work.

Configure platform-owner bootstrap secrets:

```text
PLATFORM_ADMIN_NAME=<operator display name>
PLATFORM_ADMIN_EMAIL=<operator email>
PLATFORM_ADMIN_PASSWORD=<strong bootstrap password>
PLATFORM_AUTH_SECRET=<at least 32 random bytes>
```

On the first successful `/platform-admin/login`, if no platform operator exists,
the supplied bootstrap credentials create exactly one operator. Once an operator
exists, the bootstrap path stops creating accounts.

Rotate the bootstrap password after first login and move normal operator account
management into the future Platform Security module.

## 5. Verify tenant provisioning

A successful **New tenant** operation is one database transaction:

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

Any failure rolls back the entire customer setup.

The migration rehearsal on a temporary Neon branch executed this transaction as
an explicitly restricted `NOSUPERUSER / NOBYPASSRLS / NOCREATEROLE /
NOCREATEDB / NOINHERIT` role. With the new tenant context set, the role saw one
user and one role for the new tenant while pre-existing tenant users remained
invisible under forced RLS.

## 6. Production gate

Do not enable `/platform-admin` for customer operations until all are true:

- migration 003 is applied;
- `ik_osa_control_plane` passes the role-attribute checks above;
- `CONTROL_PLANE_DATABASE_URL` uses that role, not the migration owner;
- platform bootstrap secrets are configured through the deployment secret store;
- platform login succeeds;
- one throwaway pilot tenant is created and its first tenant admin can sign in;
- cross-tenant reads remain empty under the new tenant context;
- platform audit UPDATE/DELETE are denied;
- the throwaway tenant is removed through an approved cleanup procedure.
