import "server-only";

import {
  assertRuntimeRoleIsSafe,
  inspectRuntimeRole,
  loadPgModule,
  withTenantTransaction,
  type Pool,
} from "./db/driver";
import type { ActorScope } from "./db/repository";

export type RuntimeTenantControl = {
  managed: boolean;
  state: "trial" | "active" | "suspended" | null;
  trialEndsAt: string | null;
  enabledModules: string[];
};

const NIL_ACTOR = "00000000-0000-0000-0000-000000000000";
let poolPromise: Promise<Pool> | null = null;

async function runtimePool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tenant lifecycle checks");
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await loadPgModule();
      if (!pg) throw new Error("PostgreSQL driver is unavailable");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      assertRuntimeRoleIsSafe(await inspectRuntimeRole(pool));
      return pool;
    })();
  }
  return poolPromise;
}

/**
 * Reads only the authenticated/prospective tenant's commercial state through
 * migration 004's narrow SECURITY DEFINER function. The normal runtime role is
 * never granted SELECT on the global osa.tenant_control portfolio.
 */
export async function runtimeTenantControl(tenantId: string): Promise<RuntimeTenantControl> {
  if (!process.env.DATABASE_URL) {
    return { managed: false, state: null, trialEndsAt: null, enabledModules: [] };
  }

  const scope: ActorScope = {
    tenantId,
    userId: NIL_ACTOR,
    orgScopes: [],
    viewerOrgPath: "",
    selfOnly: false,
  };
  const pool = await runtimePool();
  return withTenantTransaction(pool, scope, async (client) => {
    const { rows } = await client.query<{ state: "trial" | "active" | "suspended"; trial_ends_at: Date | null; enabled_modules: string[] }>(
      "SELECT state, trial_ends_at, enabled_modules FROM osa.runtime_tenant_control()",
    );
    const row = rows[0];
    if (!row) return { managed: false, state: null, trialEndsAt: null, enabledModules: [] };
    return {
      managed: true,
      state: row.state,
      trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
      enabledModules: row.enabled_modules ?? [],
    };
  }, { readOnly: true });
}

export function tenantControlAllowsAccess(control: RuntimeTenantControl, now = new Date()): boolean {
  if (!control.managed) return true;
  if (control.state === "suspended") return false;
  if (control.state === "trial" && control.trialEndsAt && Date.parse(control.trialEndsAt) <= now.getTime()) return false;
  return control.state === "trial" || control.state === "active";
}
