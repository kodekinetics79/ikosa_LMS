import { AuthError, principalFromRequest } from "@/lib/server/auth";
import { listMarkingQueue } from "@/lib/server/assessment-list-store";
import { json, problem, requestId } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireGrader(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "assessor")) {
    throw new AuthError(403, "Assessment grading permission required");
  }
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireGrader(principal.roles);
    return json({ items: await listMarkingQueue(principal), asOf: new Date().toISOString() });
  } catch (error) {
    return problem(error, rid);
  }
}
