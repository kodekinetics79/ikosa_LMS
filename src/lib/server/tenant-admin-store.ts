import "server-only";

import { hashPassword } from "./security";
import type { AuditEvent, PlatformRole } from "./domain";
import type { Principal } from "./auth";
import { scopeForPrincipal } from "./tenant-runtime";
import {
  assertRuntimeRoleIsSafe,
  inspectRuntimeRole,
  loadPgModule,
  withTenantTransaction,
  type Pool,
  type PoolClient,
} from "./db/driver";
import { newId } from "./db/ids";
import { signAuditEvent } from "./db/audit-chain";
import * as map from "./db/mapping";

export type TenantAdminOrgUnit = {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  path: string;
  memberCount: number;
};

export type TenantAdminUser = {
  id: string;
  email: string;
  displayName: string;
  orgUnitId: string;
  orgUnitName: string;
  roles: PlatformRole[];
  delegatedOrgPaths: string[];
  active: boolean;
  createdAt: string;
};

export type CreateTenantUserInput = {
  email: string;
  displayName: string;
  orgUnitId: string;
  password: string;
  roles: PlatformRole[];
  requestId: string;
};

export type CreateTenantOrgInput = {
  parentId: string;
  code: string;
  name: string;
  requestId: string;
};

let poolPromise: Promise<Pool> | null = null;

async function runtimePool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tenant administration");
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await loadPgModule();
      if (!pg) throw new Error("PostgreSQL driver is unavailable");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
      assertRuntimeRoleIsSafe(await inspectRuntimeRole(pool));
      return pool;
    })();
  }
  return poolPromise;
}

function requireTenantAdmin(principal: Principal): void {
  if (!principal.roles.includes("tenant_admin")) throw new Error("Tenant administrator permission required");
}

async function read<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  requireTenantAdmin(principal);
  const pool = await runtimePool();
  return withTenantTransaction(pool, scopeForPrincipal(principal), run, { readOnly: true });
}

async function write<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  requireTenantAdmin(principal);
  const pool = await runtimePool();
  return withTenantTransaction(pool, scopeForPrincipal(principal), run);
}

function asRoles(value: unknown): PlatformRole[] {
  return Array.isArray(value) ? value.map(String) as PlatformRole[] : [];
}

function asPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function appendTenantAudit(
  client: PoolClient,
  principal: Principal,
  requestId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: AuditEvent["metadata"],
): Promise<void> {
  const scope = scopeForPrincipal(principal);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`osa.audit:${scope.tenantId}`]);
  const { rows } = await client.query(
    `SELECT a.id, a.tenant_id, a.actor_user_id, a.action, a.resource_type, a.resource_id, a.outcome,
            a.occurred_at, a.request_id, a.metadata, a.previous_hash, a.event_hash
       FROM osa.audit_events a
      ORDER BY a.sequence DESC
      LIMIT 1`,
  );
  const head = rows[0] ? map.toAuditEvent(rows[0]) : null;
  const event = signAuditEvent(head, {
    tenantId: scope.tenantId,
    actorUserId: scope.userId,
    action,
    resourceType,
    resourceId,
    outcome: "success",
    requestId,
    metadata,
  });
  await client.query(
    `INSERT INTO osa.audit_events
      (id, tenant_id, actor_user_id, action, resource_type, resource_id,
       outcome, request_id, metadata, occurred_at, previous_hash, event_hash)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
             $7, $8, $9::jsonb, $10::timestamptz, $11, $12)`,
    [
      event.id, event.tenantId, event.actorUserId, event.action, event.resourceType,
      event.resourceId, event.outcome, event.requestId, JSON.stringify(event.metadata),
      event.occurredAt, map.hashToBytes(event.previousHash), map.hashToBytes(event.hash),
    ],
  );
}

export async function listTenantOrgUnits(principal: Principal): Promise<TenantAdminOrgUnit[]> {
  return read(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const { rows } = await client.query(
      `SELECT ou.id::text, ou.parent_id::text, ou.code, ou.name, ou.path::text,
              count(u.id)::int AS member_count
         FROM osa.org_units ou
         LEFT JOIN osa.users u ON u.tenant_id = ou.tenant_id AND u.org_unit_id = ou.id AND u.active
        WHERE ou.path <@ ANY($1::ltree[])
        GROUP BY ou.id, ou.parent_id, ou.code, ou.name, ou.path
        ORDER BY nlevel(ou.path), ou.path`,
      [scope.orgScopes],
    );
    return rows.map((row) => ({
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      code: String(row.code),
      name: String(row.name),
      path: String(row.path),
      memberCount: Number(row.member_count ?? 0),
    }));
  });
}

export async function listTenantUsers(principal: Principal): Promise<TenantAdminUser[]> {
  return read(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const { rows } = await client.query(
      `SELECT u.id::text, u.email::text, u.display_name, u.org_unit_id::text,
              ou.name AS org_unit_name, u.active, u.created_at,
              coalesce((SELECT array_agg(r.role_code ORDER BY r.role_code)
                          FROM osa.user_roles r
                         WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id), '{}') AS roles,
              coalesce((SELECT array_agg(p::text) FROM unnest(u.delegated_org_paths) p), '{}') AS delegated_org_paths
         FROM osa.users u
         JOIN osa.org_units ou ON ou.tenant_id = u.tenant_id AND ou.id = u.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY u.active DESC, u.display_name, u.email`,
      [scope.orgScopes],
    );
    return rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      orgUnitId: String(row.org_unit_id),
      orgUnitName: String(row.org_unit_name),
      roles: asRoles(row.roles),
      delegatedOrgPaths: asPaths(row.delegated_org_paths),
      active: Boolean(row.active),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  });
}

export async function createTenantOrgUnit(principal: Principal, input: CreateTenantOrgInput): Promise<TenantAdminOrgUnit> {
  return write(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const parent = await client.query<{ id: string; path: string }>(
      `SELECT id::text, path::text
         FROM osa.org_units
        WHERE id = $1::uuid AND path <@ ANY($2::ltree[])`,
      [input.parentId, scope.orgScopes],
    );
    if (!parent.rows[0]) throw new Error("Parent organization is outside your delegated scope");

    const id = newId();
    const path = `${parent.rows[0].path}.org_${id.replaceAll("-", "_")}`;
    const created = await client.query<{ id: string; parent_id: string; code: string; name: string; path: string }>(
      `INSERT INTO osa.org_units (id, tenant_id, parent_id, code, name, path)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, text2ltree($6))
       RETURNING id::text, parent_id::text, code, name, path::text`,
      [id, scope.tenantId, input.parentId, input.code, input.name, path],
    );
    await appendTenantAudit(client, principal, input.requestId, "tenant.organization.create", "org_unit", id, {
      code: input.code,
      parentId: input.parentId,
    });
    const row = created.rows[0];
    return { id: row.id, parentId: row.parent_id, code: row.code, name: row.name, path: row.path, memberCount: 0 };
  });
}

export async function createTenantUser(principal: Principal, input: CreateTenantUserInput): Promise<TenantAdminUser> {
  return write(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const organization = await client.query<{ id: string; name: string; path: string }>(
      `SELECT id::text, name, path::text
         FROM osa.org_units
        WHERE id = $1::uuid AND path <@ ANY($2::ltree[])`,
      [input.orgUnitId, scope.orgScopes],
    );
    const org = organization.rows[0];
    if (!org) throw new Error("Organization is outside your delegated scope");

    const id = newId();
    const created = await client.query<{ id: string; email: string; display_name: string; active: boolean; created_at: Date }>(
      `INSERT INTO osa.users
        (id, tenant_id, org_unit_id, email, display_name, password_hash, active, delegated_org_paths)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::citext, $5, $6, true, ARRAY[$7::ltree])
       RETURNING id::text, email::text, display_name, active, created_at`,
      [id, scope.tenantId, input.orgUnitId, input.email, input.displayName, hashPassword(input.password), org.path],
    );

    for (const role of input.roles) {
      await client.query(
        `INSERT INTO osa.user_roles (tenant_id, user_id, role_code)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [scope.tenantId, id, role],
      );
    }

    await appendTenantAudit(client, principal, input.requestId, "tenant.user.create", "user", id, {
      email: input.email,
      orgUnitId: input.orgUnitId,
      roles: input.roles.join(","),
    });

    const row = created.rows[0];
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      orgUnitId: org.id,
      orgUnitName: org.name,
      roles: input.roles,
      delegatedOrgPaths: [org.path],
      active: row.active,
      createdAt: row.created_at.toISOString(),
    };
  });
}

export async function setTenantUserActive(principal: Principal, userId: string, active: boolean, requestId: string): Promise<void> {
  requireTenantAdmin(principal);
  if (userId === principal.user.id && !active) throw new Error("You cannot deactivate your own tenant administrator account");
  await write(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const result = await client.query(
      `UPDATE osa.users u
          SET active = $2
         FROM osa.org_units ou
        WHERE u.id = $1::uuid
          AND ou.tenant_id = u.tenant_id
          AND ou.id = u.org_unit_id
          AND ou.path <@ ANY($3::ltree[])`,
      [userId, active, scope.orgScopes],
    );
    if (!result.rowCount) throw new Error("User not found in your delegated scope");
    if (!active) await client.query("DELETE FROM osa.sessions WHERE user_id = $1::uuid", [userId]);
    await appendTenantAudit(
      client,
      principal,
      requestId,
      active ? "tenant.user.activate" : "tenant.user.deactivate",
      "user",
      userId,
      { active },
    );
  });
}

export async function resetTenantUserPassword(
  principal: Principal,
  userId: string,
  password: string,
  requestId: string,
): Promise<{ userId: string; revokedSessions: number }> {
  requireTenantAdmin(principal);
  await write(principal, async (client) => {
    const scope = scopeForPrincipal(principal);
    const result = await client.query(
      `UPDATE osa.users u
          SET password_hash = $2
         FROM osa.org_units ou
        WHERE u.id = $1::uuid
          AND ou.tenant_id = u.tenant_id
          AND ou.id = u.org_unit_id
          AND ou.path <@ ANY($3::ltree[])
        RETURNING u.id`,
      [userId, hashPassword(password), scope.orgScopes],
    );
    if (!result.rowCount) throw new Error("User not found in your delegated scope");
    const revoked = await client.query(
      "DELETE FROM osa.sessions WHERE user_id = $1::uuid RETURNING id_hash",
      [userId],
    );
    await appendTenantAudit(
      client,
      principal,
      requestId,
      "tenant.user.password.reset",
      "user",
      userId,
      { revokedSessions: revoked.rowCount ?? 0 },
    );
    return { userId, revokedSessions: revoked.rowCount ?? 0 };
  });

  // The transaction above is the authority. Return only non-secret metadata;
  // the temporary password is intentionally held only by the caller/UI.
  return { userId, revokedSessions: 0 };
}

export async function tenantAdminHealth(principal: Principal): Promise<{ users: number; organizations: number; tenantAdmins: number }> {
  const [users, organizations] = await Promise.all([listTenantUsers(principal), listTenantOrgUnits(principal)]);
  return {
    users: users.filter((user) => user.active).length,
    organizations: organizations.length,
    tenantAdmins: users.filter((user) => user.active && user.roles.includes("tenant_admin")).length,
  };
}
