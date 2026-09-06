import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { addQuestionToAssessment, createAssessment, publishAssessment } from "@/lib/server/assessment-store";
import {
  detachQuestion, reorderQuestions, setAssessmentLifecycle, setItemSettings,
  updateAssessmentSettings, type AssessmentSettings,
} from "@/lib/server/assessment/authoring";
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
    if (action === "detach_question") {
      await detachQuestion(principal, assessmentId, requiredString(body, "questionId", 100), rid);
      return json({ ok: true, assessmentId, action });
    }
    if (action === "reorder_questions") {
      const questionIds = Array.isArray(body.questionIds) ? body.questionIds.filter((value): value is string => typeof value === "string") : null;
      if (!questionIds || questionIds.length === 0) throw new ValidationError("Validation failed", { questionIds: "Provide every question id in the new order" });
      await reorderQuestions(principal, assessmentId, questionIds, rid);
      return json({ ok: true, assessmentId, action });
    }
    if (action === "set_item") {
      // `undefined` and `null` mean different things here: absent leaves the
      // column alone, null clears the override back to the question's own
      // points. Distinguishing them is why this is not a spread of the body.
      const settings: { pointsOverride?: number | null; required?: boolean } = {};
      if ("pointsOverride" in body) {
        const raw = body.pointsOverride;
        if (raw === null || raw === "") settings.pointsOverride = null;
        else {
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new ValidationError("Validation failed", { pointsOverride: "Must be a number, or null to clear it" });
          settings.pointsOverride = value;
        }
      }
      if ("required" in body) {
        if (typeof body.required !== "boolean") throw new ValidationError("Validation failed", { required: "Must be true or false" });
        settings.required = body.required;
      }
      if (Object.keys(settings).length === 0) throw new ValidationError("Validation failed", { body: "Provide pointsOverride, required, or both" });
      await setItemSettings(principal, assessmentId, requiredString(body, "questionId", 100), settings, rid);
      return json({ ok: true, assessmentId, action });
    }
    if (action === "update") {
      const settings: AssessmentSettings = {};
      if ("title" in body) settings.title = requiredString(body, "title", 240);
      if ("description" in body) settings.description = typeof body.description === "string" ? body.description.trim().slice(0, 4000) : "";
      if ("assessmentType" in body) settings.assessmentType = optionalEnum(body, "assessmentType", ["quiz","exam","practice"] as const, "quiz");
      if ("durationMinutes" in body) {
        const raw = body.durationMinutes;
        if (raw === null || raw === "") settings.durationMinutes = null;
        else {
          const value = Number(raw);
          if (!Number.isInteger(value) || value <= 0 || value > 1440) throw new ValidationError("Validation failed", { durationMinutes: "Duration must be 1-1440 minutes" });
          settings.durationMinutes = value;
        }
      }
      if ("passPercentage" in body) {
        const value = Number(body.passPercentage);
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new ValidationError("Validation failed", { passPercentage: "Pass percentage must be 0-100" });
        settings.passPercentage = value;
      }
      if ("attemptLimit" in body) {
        const value = Number(body.attemptLimit);
        if (!Number.isInteger(value) || value < 1 || value > 100) throw new ValidationError("Validation failed", { attemptLimit: "Attempt limit must be 1-100" });
        settings.attemptLimit = value;
      }
      if ("shuffleQuestions" in body) settings.shuffleQuestions = body.shuffleQuestions === true;
      if ("shuffleOptions" in body) settings.shuffleOptions = body.shuffleOptions === true;
      if ("feedbackMode" in body) settings.feedbackMode = optionalEnum(body, "feedbackMode", ["immediate","after_submit","after_close"] as const, "after_submit");
      if ("opensAt" in body) settings.opensAt = optionalDate(body.opensAt, "opensAt");
      if ("closesAt" in body) settings.closesAt = optionalDate(body.closesAt, "closesAt");
      if (Object.keys(settings).length === 0) throw new ValidationError("Validation failed", { body: "Provide at least one field to change" });
      return json(await updateAssessmentSettings(principal, assessmentId, settings, rid));
    }
    if (action === "unpublish" || action === "retire") {
      return json(await setAssessmentLifecycle(principal, assessmentId, action === "unpublish" ? "draft" : "retired", rid));
    }
    throw new ValidationError("Validation failed", { action: "Unsupported assessment action" });
  } catch (error) { return problem(error, rid); }
}
