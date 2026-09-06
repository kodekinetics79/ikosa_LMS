import "server-only";

import { Pool } from "pg";
import type { PlatformModule, PlatformTenant, TenantKind, TenantState } from "./platform-admin";

let portfolioPool: Pool | null = null;

function connectionString(): string {
  const dedicated = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error("CONTROL_PLANE_DATABASE_URL is not configured");
}

function db(): Pool {
  if (!portfolioPool) portfolioPool = new Pool({ connectionString: connectionString(), max: 2 });
  return portfolioPool;
}

/**
 * Global SaaS portfolio read.
 *
 * Do not reach into osa.users here: those rows are protected by forced RLS and
 * must remain tenant-scoped even for the platform UI. The first-admin address is
 * already recorded in the append-only platform audit event created by the same
 * provisioning transaction, so the portfolio can display its handoff identity
 * without weakening tenant isolation.
 */
export async function listManagedTenants(): Promise<PlatformTenant[]> {
  const result = await db().query<{
    id: string;
    slug: string;
    name: string;
    home_region: string;
    locale: string;
    created_at: Date;
    tenant_kind: TenantKind;
    state: TenantState;
    plan_code: string;
    seat_limit: number;
    storage_gb: number;
    ai_monthly_credits: number;
    enabled_modules: PlatformModule[];
    trial_ends_at: Date | null;
    first_admin_email: string | null;
  }>(
    `SELECT t.id::text, t.slug, t.name, t.home_region, t.locale, t.created_at,
            c.tenant_kind, c.state, c.plan_code, c.seat_limit, c.storage_gb,
            c.ai_monthly_credits, c.enabled_modules, c.trial_ends_at,
            a.metadata->>'firstAdmin' AS first_admin_email
       FROM osa.tenants t
       JOIN osa.tenant_control c ON c.tenant_id = t.id
       LEFT JOIN LATERAL (
         SELECT e.metadata
           FROM osa.platform_audit_events e
          WHERE e.resource_type = 'tenant'
            AND e.resource_id = t.id
            AND e.action = 'platform.tenant.create'
            AND e.outcome = 'success'
          ORDER BY e.occurred_at ASC
          LIMIT 1
       ) a ON true
      ORDER BY t.created_at DESC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    homeRegion: row.home_region,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
    tenantKind: row.tenant_kind,
    state: row.state,
    planCode: row.plan_code,
    seatLimit: row.seat_limit,
    storageGb: row.storage_gb,
    aiMonthlyCredits: row.ai_monthly_credits,
    enabledModules: row.enabled_modules,
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    firstAdminEmail: row.first_admin_email,
  }));
}
