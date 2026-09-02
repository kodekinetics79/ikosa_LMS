import { isSelfScopedOnly, principalFromRequest, type Principal } from "@/lib/server/auth";
import { scopeFromPrincipal } from "@/lib/server/db";
import { json, problem, requestId } from "@/lib/server/http";
import { requirePersistence } from "@/lib/server/persistence";
import type { Tenant } from "@/lib/server/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tenant behind the signed-in principal.
 *
 * Under PostgreSQL this is one indexed lookup inside the session's own tenant
 * context, not a read of every tenant row: `store.ts` is not consulted at all
 * while `DATABASE_URL` is set, which is the whole point of the seam.
 *
 * `viewerOrgPath` drives catalogue inheritance only and is not read by
 * `repo.tenant()`; the delegated root stands in for it because `Principal`
 * does not carry the viewer's own org-unit path. When the rest of the route
 * layer moves onto the repository (README-migration.md §5) this belongs in one
 * shared `Principal -> ActorScope` helper rather than here.
 */
async function tenantFor(principal: Principal): Promise<Tenant | null> {
  if (process.env.DATABASE_URL) {
    const store = await requirePersistence();
    const scope = scopeFromPrincipal({
      tenantId: principal.tenantId,
      user: { id: principal.user.id, orgUnitId: principal.user.orgUnitId },
      delegatedOrgPaths: principal.delegatedOrgPaths,
      selfOnly: isSelfScopedOnly(principal),
      viewerOrgPath: principal.delegatedOrgPaths[0] ?? "",
    });
    return store.read(scope, (repo) => repo.tenant());
  }
  const { readDatabase } = await import("@/lib/server/store");
  return (await readDatabase()).tenants.find((item) => item.id === principal.tenantId) ?? null;
}

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const tenant = await tenantFor(principal);
    // The CSRF token is still returned, and is still safe to return, because it
    // is no longer read back out of storage: under PostgreSQL it is an HMAC of
    // the session token under AUTH_SECRET, re-derived per request and verified
    // against `sessions.csrf_hash` before it reaches this line. See the CSRF
    // note in src/lib/server/auth.ts. Five pages pass this value into client
    // components, so it has to keep arriving here.
    return json({ user: principal.user, tenant, csrfToken: principal.session.csrfToken, expiresAt: principal.session.expiresAt });
  } catch (error) { return problem(error, id); }
}
