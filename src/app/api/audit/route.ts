import type { NextRequest } from "next/server";
import { verifyAuditChain } from "@/lib/server/audit";
import { authorize, principalFromRequest } from "@/lib/server/auth";
import { json, problem, requestId } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    authorize(principal, "audit:read", { tenantId: principal.tenantId });
    const db = await readDatabase();
    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 100), 1), 500);
    const items = db.auditEvents.filter((event) => event.tenantId === principal.tenantId).slice(-limit).reverse();
    return json({ items, integrity: await verifyAuditChain(principal.tenantId), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
