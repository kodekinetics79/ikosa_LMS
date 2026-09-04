import "server-only";

import type { OrgUnit, Tenant } from "./domain";
import { isSelfScopedOnly, type Principal } from "./auth";
import { scopeFromPrincipal } from "./db/postgres";
import type { ActorScope } from "./db/repository";
import { postgresConfigured, requirePersistence } from "./persistence";
import { readDatabase } from "./store";

/**
 * Build the SQL row-visibility scope exclusively from the validated session.
 * Nothing here accepts request input, tenant query parameters or headers.
 */
export function scopeForPrincipal(principal: Principal): ActorScope {
  return scopeFromPrincipal({
    tenantId: principal.tenantId,
    user: { id: principal.user.id, orgUnitId: principal.user.orgUnitId },
    delegatedOrgPaths: principal.delegatedOrgPaths,
    selfOnly: isSelfScopedOnly(principal),
    // This matches auth.ts's existing PostgreSQL actor scope. The repository
    // uses this only for catalogue inheritance; the authoritative record scope
    // remains delegatedOrgPaths + selfOnly under RLS.
    viewerOrgPath: principal.delegatedOrgPaths[0] ?? "",
  });
}

/**
 * The authenticated shell is the first thing every customer sees. It therefore
 * must obey the same system-of-record switch as authentication itself.
 *
 * Before this seam, PostgreSQL could authenticate a newly provisioned customer
 * and the layout immediately read the legacy JSON file for its tenant name and
 * org count. That made a successful login land in an "Unknown workspace" even
 * though the database was correct. Production now stays on PostgreSQL for the
 * whole request; JSON remains local/demo only.
 */
export async function tenantShellContext(principal: Principal): Promise<{ tenant: Tenant | null; organizations: OrgUnit[] }> {
  if (postgresConfigured()) {
    const persistence = await requirePersistence();
    return persistence.read(scopeForPrincipal(principal), async (repo) => {
      const [tenant, organizations] = await Promise.all([
        repo.tenant(),
        repo.listOrgUnitsInScope(),
      ]);
      return { tenant, organizations };
    });
  }

  const database = await readDatabase();
  return {
    tenant: database.tenants.find((candidate) => candidate.id === principal.tenantId) ?? null,
    organizations: database.orgUnits.filter((unit) => unit.tenantId === principal.tenantId),
  };
}
