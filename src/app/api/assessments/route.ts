import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { addQuestionToAssessment, createAssessment, publishAssessment } from "@/lib/server/assessment-store";
import { listAssessmentWorkspace } from "@/lib/server/assessment-list-store";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAuthor(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "tna_analyst")) throw new AuthError(403, "Assessment authoring permission required");
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError("Validation failed", { [field]: "Must be a valid date/time" });
  return new Date(value).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    return json({ items: await listAssessmentWorkspace(principal), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const durationMinutes = body.durationMinutes === null || body.durationMinutes === undefined || body.durationMinutes === "" ? null : Number(body.durationMinutes);
    const passPercentage = Number(body.passPercentage ?? 70);
    const attemptLimit = Number(body.attemptLimit ?? 1);
    if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440)) throw new ValidationError("Validation failed", { durationMinutes: "Duration must be 1-1440 minutes" });
    if (!Number.isFinite(passPercentage) || passPercentage < 0 || passPercentage > 100) throw new ValidationError("Validation failed", { passPercentage: "Pass percentage must be 0-100" });
    if (!Number.isInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 100) throw new ValidationError("Validation failed", { attemptLimit: "Attempt limit must be 1-100" });
    const opensAt = optionalDate(body.opensAt, "opensAt");
    const closesAt = optionalDate(body.closesAt, "closesAt");
    if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) throw new ValidationError("Validation failed", { closesAt: "Close time must be after open time" });
    const assessment = await createAssessment(principal, {
      orgUnitId: requiredString(body, "orgUnitId", 100),
      courseId: typeof body.courseId === "string" && body.courseId.trim() ? body.courseId.trim() : null,
      code: requiredString(body, "code", 40).toUpperCase(),
      title: requiredString(body, "title", 240),
      description: typeof body.description === "string" ? body.description.trim().slice(0, 4000) : "",
      assessmentType: optionalEnum(body, "assessmentType", ["quiz","exam","practice"] as const, "quiz"),
      durationMinutes,
      passPercentage,
      attemptLimit,
      shuffleQuestions: body.shuffleQuestions === true,
      shuffleOptions: body.shuffleOptions === true,
      feedbackMode: optionalEnum(body, "feedbackMode", ["immediate","after_submit","after_close"] as const, "after_submit"),
      opensAt,
      closesAt,
      requestId: rid,
    });
    return json(assessment, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    const assessmentId = requiredString(body, "assessmentId", 100);
    if (action === "attach_question") {
      await addQuestionToAssessment(principal, assessmentId, requiredString(body, "questionId", 100), rid);
      return json({ ok: true, assessmentId, action });
    }
    if (action === "publish") {
      await publishAssessment(principal, assessmentId, rid);
      return json({ ok: true, assessmentId, action });
    }
    throw new ValidationError("Validation failed", { action: "Unsupported assessment action" });
  } catch (error) { return problem(error, rid); }
}
