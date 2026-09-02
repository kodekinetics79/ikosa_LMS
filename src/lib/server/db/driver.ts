/**
 * Connection, transaction boundary and runtime-role safety checks.
 *
 * `pg` is deliberately NOT a declared dependency of this package. Nothing in
 * the shipped application imports this module yet — the JSON store remains the
 * default — so adding `pg` to package.json would make every consumer of the R0
 * downloadable build install a driver they do not use. The driver is loaded
 * dynamically and its absence is a clean, reported `null` rather than a crash.
 *
 * To use it:  npm install pg          (or set IK_PG_MODULE, see below)
 */

import { pathToFileURL } from "node:url";

/* ---------------------------------------------------------------------------
 * Structural types for the parts of `pg` this adapter touches.
 *
 * Declared here rather than imported from `@types/pg` for the same reason as
 * above: `tsc --noEmit` must stay clean on a checkout that has never installed
 * the driver.
 * ------------------------------------------------------------------------- */

export type QueryResultRow = Record<string, unknown>;

export type QueryResult<R extends QueryResultRow = QueryResultRow> = {
  rows: R[];
  rowCount: number | null;
};

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface PoolClient extends Queryable {
  release(destroy?: boolean): void;
}

export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export type PgModule = {
  Pool: new (config: Record<string, unknown>) => Pool;
};

/**
 * Resolution order:
 *   1. `pg` from the ordinary module graph.
 *   2. `IK_PG_MODULE` — a specifier, absolute path or file URL pointing at a
 *      `pg` installation elsewhere (e.g. `/opt/pg/node_modules/pg/lib/index.js`).
 *      Exists so the integration test can prove the adapter against a real
 *      server without adding a dependency to this repository.
 *
 * ESM has no directory resolution, so an absolute path is converted to a file
 * URL and must name the module's entry file, not its directory.
 */
function candidateSpecifiers(): string[] {
  const override = process.env.IK_PG_MODULE?.trim();
  if (!override) return ["pg"];
  return ["pg", override.startsWith("/") ? pathToFileURL(override).href : override];
}

let cached: PgModule | null | undefined;

export async function loadPgModule(): Promise<PgModule | null> {
  if (cached !== undefined) return cached;
  for (const specifier of candidateSpecifiers()) {
    try {
      // A non-literal specifier, so the bundler does not try to resolve a
      // dependency that is not installed.
      const loaded: unknown = await import(specifier);
      const candidate = loaded as { Pool?: unknown; default?: { Pool?: unknown } };
      if (typeof candidate.Pool === "function") {
        cached = candidate as PgModule;
        return cached;
      }
      if (typeof candidate.default?.Pool === "function") {
        cached = candidate.default as PgModule;
        return cached;
      }
    } catch {
      // Try the next candidate. An absent driver is a supported state.
    }
  }
  cached = null;
  return cached;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {}

/**
 * Establishes the tenant context for one transaction.
 *
 * `SET LOCAL` does not accept bind parameters, so the only way to write it
 * literally is string concatenation — an injection site sitting directly on the
 * value that decides which tenant's data a request can see. `set_config(name,
 * value, is_local => true)` is the parameterisable form and does exactly the
 * same thing. Nothing in this file ever interpolates a tenant or user id.
 *
 * The uuid check is not defence against injection (there is none to defend
 * against here); it turns a malformed context into a clear error instead of
 * `osa.current_tenant_id()` raising `invalid input syntax for type uuid` from
 * inside an RLS policy on every subsequent statement.
 */
export async function setTenantContext(client: Queryable, tenantId: string, userId: string): Promise<void> {
  if (!UUID_PATTERN.test(tenantId)) throw new TenantContextError("Tenant context must be a uuid derived from the validated session");
  if (!UUID_PATTERN.test(userId)) throw new TenantContextError("Actor context must be a uuid derived from the validated session");
  await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
}

export type TransactionOptions = {
  readOnly?: boolean;
  /**
   * SERIALIZABLE for the audit append path, where two concurrent writers
   * reading the same chain head would fork the ledger. Everything else runs at
   * the default READ COMMITTED.
   */
  isolation?: "read committed" | "repeatable read" | "serializable";
};

export async function withTenantTransaction<T>(
  pool: Pool,
  context: { tenantId: string; userId: string },
  run: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    const isolation = options.isolation ? ` ISOLATION LEVEL ${options.isolation.toUpperCase()}` : "";
    const access = options.readOnly ? " READ ONLY" : "";
    await client.query(`BEGIN${isolation}${access}`);
    // Inside the transaction: SET LOCAL is reverted at COMMIT or ROLLBACK, so
    // a pooled connection handed to the next request carries no tenant context.
    // A connection-level SET would leak one tenant's context into another's
    // request, which is precisely the failure RLS is meant to catch.
    await setTenantContext(client, context.tenantId, context.userId);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw error;
  } finally {
    client.release();
  }
}

export type RuntimeRoleReport = {
  role: string;
  bypassRls: boolean;
  superuser: boolean;
  ownedTables: number;
};

const RUNTIME_ROLE_SQL = `
  SELECT
    current_user::text AS role,
    coalesce((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) AS bypass_rls,
    coalesce((SELECT r.rolsuper     FROM pg_roles r WHERE r.rolname = current_user), false) AS superuser,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'osa' AND c.relkind IN ('r','p')
        AND pg_get_userbyid(c.relowner) = current_user) AS owned_tables
`;

export async function inspectRuntimeRole(client: Queryable): Promise<RuntimeRoleReport> {
  const { rows } = await client.query(RUNTIME_ROLE_SQL);
  const row = rows[0] ?? {};
  return {
    role: String(row.role ?? "unknown"),
    bypassRls: row.bypass_rls === true,
    superuser: row.superuser === true,
    ownedTables: Number(row.owned_tables ?? 0),
  };
}

/**
 * ADR-001 release blockers, checked at startup rather than trusted.
 *
 * "Runtime database role has table ownership or BYPASSRLS" is listed as a
 * blocker, so it is worth more than a line in a runbook: a misprovisioned role
 * silently disables every tenant policy in the schema, and the application
 * behaves perfectly right up until it serves the wrong tenant's data. Failing
 * to start is the correct response.
 */
export function assertRuntimeRoleIsSafe(report: RuntimeRoleReport): RuntimeRoleReport {
  const faults: string[] = [];
  if (report.bypassRls) faults.push("has BYPASSRLS, which disables every tenant_isolation policy");
  if (report.superuser) faults.push("is a superuser, which bypasses row-level security");
  if (report.ownedTables > 0) faults.push(`owns ${report.ownedTables} table(s) in schema osa; an owner can disable RLS on what it owns`);
  if (faults.length > 0) {
    throw new Error(`Runtime database role "${report.role}" violates ADR-001: it ${faults.join("; and it ")}.`);
  }
  return report;
}
