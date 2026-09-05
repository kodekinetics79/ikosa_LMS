import { assertCsrf, principalFromRequest } from "@/lib/server/auth";
import {
  AUTHORABLE_MODULE_KINDS, createCourseModule, removeCourseModule, reorderCourseModules,
  setCourseLifecycle, updateCourseModule,
} from "@/lib/server/course-authoring";
import { assessmentDetail } from "@/lib/server/assessment/authoring";
import { postgresConfigured } from "@/lib/server/persistence";
import { conflict } from "@/lib/server/errors";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Course structure authoring.
 *
 * A course could be created and then had no way to put anything in it — there
 * was no module API at all, so every module in the system came from the seed
 * fixture.
 */

/**
 * An assessment may only be linked if the caller can actually author it.
 *
 * `assessmentDetail` already enforces both the authoring role and the delegated
 * organizational scope, so reusing it here means the link check and the
 * authoring check cannot drift apart. It also proves the assessment exists,
 * which the database will insist on anyway (migration 008's foreign key) but
 * would report as a constraint violation rather than a readable refusal.
 */
async function assertLinkableAssessment(principal: Awaited<ReturnType<typeof principalFromRequest>>, assessmentId: string): Promise<void> {
  if (!postgresConfigured()) {
    // The assessment engine is PostgreSQL-only. Saying so is better than
    // silently writing a link that resolves to nothing.
    throw conflict("Assessments are unavailable on this instance, so a module cannot be linked to one.");
  }
  const detail = await assessmentDetail(principal, assessmentId);
  if (detail.assessment.status === "retired") {
    throw conflict("That assessment is retired and cannot be attached to a course.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const kind = optionalEnum(body, "kind", AUTHORABLE_MODULE_KINDS, "lesson");
    const durationMinutes = Number(body.durationMinutes ?? 15);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0) {
      throw new ValidationError("Validation failed", { durationMinutes: "Duration must be a whole number of minutes" });
    }
    const assessmentId = typeof body.assessmentId === "string" && body.assessmentId.trim() ? body.assessmentId.trim() : null;
    if (assessmentId) await assertLinkableAssessment(principal, assessmentId);

    const module = await createCourseModule(principal, {
      courseId: requiredString(body, "courseId", 100),
      title: requiredString(body, "title", 200),
      kind,
      durationMinutes,
      required: body.required === undefined ? true : body.required === true,
      assessmentId,
      requestId: rid,
    });
    return json(module, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);

    if (action === "update") {
      const patch: Parameters<typeof updateCourseModule>[1] = { moduleId: requiredString(body, "moduleId", 100), requestId: rid };
      if ("title" in body) patch.title = requiredString(body, "title", 200);
      if ("required" in body) {
        if (typeof body.required !== "boolean") throw new ValidationError("Validation failed", { required: "Must be true or false" });
        patch.required = body.required;
      }
      if ("durationMinutes" in body) {
        const value = Number(body.durationMinutes);
        if (!Number.isInteger(value) || value < 0) throw new ValidationError("Validation failed", { durationMinutes: "Duration must be a whole number of minutes" });
        patch.durationMinutes = value;
      }
      if ("assessmentId" in body) {
        // null clears the link; a string sets it after the same authoring check
        // the assessment workspace applies.
        const value = typeof body.assessmentId === "string" && body.assessmentId.trim() ? body.assessmentId.trim() : null;
        if (value) await assertLinkableAssessment(principal, value);
        patch.assessmentId = value;
      }
      return json(await updateCourseModule(principal, patch));
    }

    if (action === "reorder") {
      const moduleIds = Array.isArray(body.moduleIds) ? body.moduleIds.filter((value): value is string => typeof value === "string") : null;
      if (!moduleIds || moduleIds.length === 0) throw new ValidationError("Validation failed", { moduleIds: "Provide every module id in the new order" });
      return json({ items: await reorderCourseModules(principal, requiredString(body, "courseId", 100), moduleIds, rid) });
    }

    if (action === "remove") {
      await removeCourseModule(principal, requiredString(body, "moduleId", 100), rid);
      return json({ ok: true, action });
    }

    if (action === "publish" || action === "unpublish" || action === "retire") {
      const target = action === "publish" ? "published" : action === "unpublish" ? "draft" : "retired";
      return json(await setCourseLifecycle(principal, requiredString(body, "courseId", 100), target, rid));
    }

    throw new ValidationError("Validation failed", { action: "Unsupported course structure action" });
  } catch (error) { return problem(error, rid); }
}
