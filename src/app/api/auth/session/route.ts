import { principalFromRequest } from "@/lib/server/auth";
import { json, problem, requestId } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const tenant = (await readDatabase()).tenants.find((item) => item.id === principal.tenantId);
    return json({ user: principal.user, tenant, csrfToken: principal.session.csrfToken, expiresAt: principal.session.expiresAt });
  } catch (error) { return problem(error, id); }
}
