import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { orgFor, visibleRows } from "@/lib/server/domain-service";
import type { Intervention } from "@/lib/server/domain";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    return json({ items: visibleRows(db, principal, "intervention:read", db.interventions), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const db = await readDatabase();
    const gapCaseId = requiredString(body, "gapCaseId", 100);
    const gap = db.gapCases.find((item) => item.id === gapCaseId && item.tenantId === principal.tenantId);
    if (!gap) throw new ValidationError("Validation failed", { gapCaseId: "Gap case not found" });
    const org = orgFor(db, principal.tenantId, gap.orgUnitId);
    if (!org) throw new Error("Organizational unit not found");
    authorize(principal, "intervention:create", { tenantId: principal.tenantId, orgUnit: org, subjectUserId: gap.subjectUserId });
    const intervention: Intervention = {
      id: newId(), tenantId: principal.tenantId, orgUnitId: gap.orgUnitId, gapCaseId,
      type: optionalEnum(body, "type", ["learning", "coaching", "job_aid", "process", "tooling", "staffing"] as const, "learning"),
      title: requiredString(body, "title", 180), ownerUserId: principal.user.id,
      dueDate: requiredString(body, "dueDate", 10), status: "planned",
    };
    await mutateDatabase((state) => { state.interventions.push(intervention); const row = state.gapCases.find((item) => item.id === gapCaseId && item.tenantId === principal.tenantId); if (row && row.status === "open") row.status = "actioned"; });
    await appendAudit({ tenantId: principal.tenantId, actorUserId: principal.user.id, action: "intervention.create", resourceType: "intervention", resourceId: intervention.id, outcome: "success", requestId: rid, metadata: { type: intervention.type, gapCaseId } });
    return json(intervention, { status: 201 });
  } catch (error) { return problem(error, rid); }
}
