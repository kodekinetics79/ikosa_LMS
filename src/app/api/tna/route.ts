import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { assertScoped, orgFor, visibleRows } from "@/lib/server/domain-service";
import type { TnaStudy } from "@/lib/server/domain";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    return json({ items: visibleRows(db, principal, "tna:read", db.tnaStudies), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, id); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const db = await readDatabase();
    const orgUnitId = requiredString(body, "orgUnitId", 100);
    const org = orgFor(db, principal.tenantId, orgUnitId);
    if (!org) throw new ValidationError("Validation failed", { orgUnitId: "Organizational unit not found in tenant" });
    authorize(principal, "tna:create", { tenantId: principal.tenantId, orgUnit: org });
    const targetRoleIds = Array.isArray(body.targetRoleIds) ? body.targetRoleIds.filter((value): value is string => typeof value === "string") : [];
    if (!targetRoleIds.length || targetRoleIds.some((roleId) => !db.jobRoles.some((role) => role.id === roleId && role.tenantId === principal.tenantId))) throw new ValidationError("Validation failed", { targetRoleIds: "At least one valid tenant role is required" });
    const study: TnaStudy = { id: newId(), tenantId: principal.tenantId, orgUnitId, title: requiredString(body, "title", 160), objective: requiredString(body, "objective", 1000), status: "draft", ownerUserId: principal.user.id, targetRoleIds, dueDate: requiredString(body, "dueDate", 10), createdAt: new Date().toISOString() };
    assertScoped(db, principal, "tna:create", study);
    await mutateDatabase((state) => state.tnaStudies.push(study));
    await appendAudit({ tenantId: principal.tenantId, actorUserId: principal.user.id, action: "tna.create", resourceType: "tna_study", resourceId: study.id, outcome: "success", requestId: rid, metadata: { status: study.status } });
    return json(study, { status: 201, headers: { location: `/api/tna/${study.id}` } });
  } catch (error) { return problem(error, rid); }
}
