import type { Pool } from "pg";

type RoleRow = {
  role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolinherit: boolean;
  owned_tables: number;
  memberships: string[];
};

const REQUIRED_PRIVILEGES: Array<[string, string]> = [
  ["osa.platform_operators", "SELECT,INSERT,UPDATE"],
  ["osa.platform_sessions", "SELECT,INSERT,UPDATE,DELETE"],
  ["osa.tenant_control", "SELECT,INSERT,UPDATE"],
  ["osa.platform_audit_events", "SELECT,INSERT"],
  ["osa.tenants", "SELECT,INSERT,UPDATE"],
  ["osa.org_units", "SELECT,INSERT,UPDATE"],
  ["osa.users", "SELECT,INSERT,UPDATE"],
  ["osa.user_roles", "SELECT,INSERT,UPDATE,DELETE"],
];

async function inspect(pool: Pool): Promise<RoleRow> {
  const { rows } = await pool.query<RoleRow>(`
    SELECT
      current_user AS role_name,
      r.rolsuper,
      r.rolbypassrls,
      r.rolcreaterole,
      r.rolcreatedb,
      r.rolinherit,
      (SELECT count(*)::int
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'osa'
          AND c.relowner = r.oid
          AND c.relkind IN ('r','p')) AS owned_tables,
      coalesce((
        SELECT array_agg(granted.rolname ORDER BY granted.rolname)
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
         WHERE membership.member = r.oid
      ), ARRAY[]::text[]) AS memberships
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  if (!rows[0]) throw new Error("Unable to inspect the control-plane database role");
  return rows[0];
}

async function assertPrivileges(pool: Pool): Promise<void> {
  for (const [table, privileges] of REQUIRED_PRIVILEGES) {
    for (const privilege of privileges.split(",")) {
      const { rows } = await pool.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, $1, $2) AS allowed",
        [table, privilege],
      );
      if (!rows[0]?.allowed) throw new Error(`Control-plane role is missing ${privilege} on ${table}`);
    }
  }

  for (const forbidden of ["UPDATE", "DELETE"]) {
    const { rows } = await pool.query<{ allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'osa.platform_audit_events', $1) AS allowed",
      [forbidden],
    );
    if (rows[0]?.allowed) throw new Error(`Control-plane role must not have ${forbidden} on osa.platform_audit_events`);
  }

  const { rows } = await pool.query<{ allowed: boolean }>(
    "SELECT has_function_privilege(current_user, 'osa.current_tenant_id()', 'EXECUTE') AS allowed",
  );
  if (!rows[0]?.allowed) throw new Error("Control-plane role cannot execute osa.current_tenant_id()");
}

/**
 * Proves that CONTROL_PLANE_DATABASE_URL is a deliberately restricted login,
 * not a migration owner or a Neon-created BYPASSRLS role. This check is shared
 * by startup instrumentation and the control-plane service before use.
 */
export async function assertControlPlaneConnectionSafe(connectionString: string): Promise<void> {
  const pg = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const role = await inspect(pool);
    const failures: string[] = [];
    if (role.rolsuper) failures.push("SUPERUSER");
    if (role.rolbypassrls) failures.push("BYPASSRLS");
    if (role.rolcreaterole) failures.push("CREATEROLE");
    if (role.rolcreatedb) failures.push("CREATEDB");
    if (role.rolinherit) failures.push("INHERIT");
    if (Number(role.owned_tables) > 0) failures.push(`owns ${role.owned_tables} osa table(s)`);
    if (role.memberships.length > 0) failures.push(`inherits role membership: ${role.memberships.join(", ")}`);
    if (failures.length > 0) {
      throw new Error(`Unsafe control-plane role ${role.role_name}: ${failures.join("; ")}`);
    }
    await assertPrivileges(pool);
  } finally {
    await pool.end();
  }
}
