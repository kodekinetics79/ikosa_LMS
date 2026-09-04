import "server-only";

import { Pool } from "pg";
import type { PlatformPrincipal, TenantState } from "./platform-admin";
import { assertControlPlaneConnectionSafe } from "./control-plane-readiness";

let lifecyclePoolPromise: Promise<Pool> | null = null;

function connectionString(): string {
  const dedicated = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error("CONTROL_PLANE_DATABASE_URL is not configured");
}

async function db(): Promise<Pool> {
  if (!lifecyclePoolPromise) {
    lifecyclePoolPromise = (async () => {
      const url = connectionString();
      await assertControlPlaneConnectionSafe(url);
      return new Pool({ connectionString: url, max: 2 });
    })();
  }
  return lifecyclePoolPromise;
}

export async function setManagedTenantState(
  principal: PlatformPrincipal,
  tenantId: string,
  nextState: TenantState,
): Promise<{ tenantId: string; previousState: TenantState; state: TenantState; revokedSessions: number }> {
  if (!(["trial", "active", "suspended"] as const).includes(nextState)) throw new Error("Invalid tenant state");

  const pool = await db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ state: TenantState }>(
      "SELECT state FROM osa.tenant_control WHERE tenant_id = $1::uuid FOR UPDATE",
      [tenantId],
    );
    const row = current.rows[0];
    if (!row) throw new Error("Managed tenant not found");

    // Revoke before AND after a suspension/reactivation boundary is crossed.
    // The SECURITY DEFINER function has one job only: delete sessions for this
    // tenant. It does not read learner/business data or bypass lifecycle state.
    const revoked = await client.query<{ revoked: string }>(
      "SELECT osa.revoke_tenant_sessions($1::uuid)::text AS revoked",
      [tenantId],
    );

    await client.query(
      `UPDATE osa.tenant_control
          SET state = $2, updated_at = now()
        WHERE tenant_id = $1::uuid`,
      [tenantId, nextState],
    );
    await client.query(
      `INSERT INTO osa.platform_audit_events
        (operator_id, action, resource_type, resource_id, outcome, metadata)
       VALUES ($1::uuid, 'platform.tenant.state.change', 'tenant', $2::uuid, 'success',
               jsonb_build_object('from', $3, 'to', $4, 'revokedSessions', $5::int))`,
      [principal.operator.id, tenantId, row.state, nextState, Number(revoked.rows[0]?.revoked ?? "0")],
    );
    await client.query("COMMIT");
    return {
      tenantId,
      previousState: row.state,
      state: nextState,
      revokedSessions: Number(revoked.rows[0]?.revoked ?? "0"),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction closed */ }
    throw error;
  } finally {
    client.release();
  }
}
