import { principalFromRequest } from "@/lib/server/auth";
import { assessmentDetail } from "@/lib/server/assessment/authoring";
import { json, problem, requestId } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The authoring view of one assessment.
 *
 * Author-only, and enforced twice: `assessmentDetail` refuses a caller without
 * the authoring role, and its query additionally requires the owning
 * organization to be inside the caller's delegated scope. The payload carries
 * prompts and point values but never an answer key or a rationale — those reach
 * only the question library and the marking queue, which have their own gates.
 */
export async function GET(request: Request, context: { params: Promise<{ assessmentId: string }> }): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const { assessmentId } = await context.params;
    return json({ ...(await assessmentDetail(principal, assessmentId)), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
