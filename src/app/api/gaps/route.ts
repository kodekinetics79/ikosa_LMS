import { principalFromRequest } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { json, problem, requestId } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    const rows = visibleRows(db, principal, "gap:read", db.gapCases);
    const items = rows.map((gap) => ({
      ...gap,
      requirement: db.requirements.find((item) => item.id === gap.requirementId && item.tenantId === principal.tenantId),
      subject: db.users.find((item) => item.id === gap.subjectUserId && item.tenantId === principal.tenantId) ? { id: gap.subjectUserId, displayName: db.users.find((item) => item.id === gap.subjectUserId)!.displayName } : undefined,
      interventions: db.interventions.filter((item) => item.gapCaseId === gap.id && item.tenantId === principal.tenantId),
    }));
    return json({ items, counts: { total: items.length, critical: items.filter((item) => item.priority === "critical").length, actioned: items.filter((item) => item.status === "actioned").length }, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
