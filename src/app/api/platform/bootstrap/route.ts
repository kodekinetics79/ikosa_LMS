import { authorize, principalFromRequest } from "@/lib/server/auth";
import { visibleRows, readinessSummary, tenantRows } from "@/lib/server/domain-service";
import { json, problem, requestId } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    authorize(principal, "platform:read", { tenantId: principal.tenantId });
    const db = await readDatabase();
    const tenant = db.tenants.find((item) => item.id === principal.tenantId);
    const organizations = tenantRows(principal, db.orgUnits).filter((org) => principal.delegatedOrgPaths.some((scope) => org.path === scope || org.path.startsWith(`${scope}/`)));
    return json({
      tenant,
      user: principal.user,
      organizations,
      jobRoles: tenantRows(principal, db.jobRoles).filter((role) => organizations.some((org) => org.id === role.orgUnitId)),
      skills: tenantRows(principal, db.skills),
      requirements: visibleRows(db, principal, "platform:read", db.requirements),
      summary: await readinessSummary(principal),
      asOf: new Date().toISOString(),
    });
  } catch (error) { return problem(error, id); }
}
