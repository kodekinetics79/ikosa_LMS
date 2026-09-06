import { AuthError, principalFromRequest } from "@/lib/server/auth";
import { listMarkingQueue } from "@/lib/server/assessment-list-store";
import { attemptScript } from "@/lib/server/assessment/marking";
import { json, problem, requestId } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireGrader(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "assessor")) {
    throw new AuthError(403, "Assessment grading permission required");
  }
}

/**
 * The marking queue, or one attempt's whole script.
 *
 * `?attemptId=` exists because the queue alone gives a marker isolated
 * responses: no objective portion, no running total, no sight of whether this
 * item is the last one blocking the attempt's final result. Without a param the
 * queue behaviour is byte-for-byte what it was, so the existing workspace tab
 * is untouched.
 *
 * `attemptScript` re-checks the grading role and the marking-authority scope
 * itself; the 403 here is the cheap first gate, not the only one.
 */
export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireGrader(principal.roles);
    const attemptId = new URL(request.url).searchParams.get("attemptId");
    if (attemptId) return json(await attemptScript(principal, attemptId));
    return json({ items: await listMarkingQueue(principal), asOf: new Date().toISOString() });
  } catch (error) {
    return problem(error, rid);
  }
}
