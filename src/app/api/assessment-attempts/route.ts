import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { gradeAssessmentResponse } from "@/lib/server/assessment-store";
import { startAssessmentAttemptIdempotent } from "@/lib/server/assessment-attempt-start";
import { submitAssessmentAttemptSafely } from "@/lib/server/assessment-attempt-submit-store";
import { saveTimedAssessmentResponse } from "@/lib/server/assessment-attempt-write-store";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireLearner(roles: readonly string[]): void {
  if (!roles.includes("learner")) throw new AuthError(403, "Learner permission required");
}
function requireGrader(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "assessor")) throw new AuthError(403, "Assessment grading permission required");
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireLearner(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const workspace = await startAssessmentAttemptIdempotent(principal, requiredString(body, "assessmentId", 100), rid);
    return json(workspace, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);

    if (action === "save_response") {
      requireLearner(principal.roles);
      await saveTimedAssessmentResponse(
        principal,
        requiredString(body, "attemptId", 100),
        requiredString(body, "questionId", 100),
        body.response ?? {},
      );
      return json({ ok: true });
    }

    if (action === "submit") {
      requireLearner(principal.roles);
      const attempt = await submitAssessmentAttemptSafely(principal, requiredString(body, "attemptId", 100), rid);
      return json({ attempt });
    }

    if (action === "grade_response") {
      requireGrader(principal.roles);
      const score = Number(body.score);
      if (!Number.isFinite(score) || score < 0) throw new ValidationError("Validation failed", { score: "Score must be zero or greater" });
      const attempt = await gradeAssessmentResponse(
        principal,
        requiredString(body, "responseId", 100),
        score,
        typeof body.feedback === "string" ? body.feedback.trim().slice(0, 5000) : "",
        rid,
      );
      return json({ attempt });
    }

    throw new ValidationError("Validation failed", { action: "Unsupported attempt action" });
  } catch (error) { return problem(error, rid); }
}
