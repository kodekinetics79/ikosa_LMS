import "server-only";

/**
 * Course structure authoring.
 *
 * `POST /api/courses` created a Course row and nothing else. There was no
 * module-authoring API at all, so every course module in the system came from
 * the seed fixture — a customer could create a course and then had no way to
 * put anything in it.
 *
 * Writes go through `mutateDatabase`, the same seam the rest of the learning
 * domain uses, which diffs the snapshot and writes the changed rows through to
 * PostgreSQL. Using raw SQL here would give the learning domain a second write
 * path and, with it, a second place for the completion rules to be enforced or
 * forgotten.
 */

import { appendAuditWithin } from "./audit";
import { authorize, type Principal } from "./auth";
import type { CourseModule, Database } from "./domain";
import { orgFor } from "./domain-service";
import { conflict, notFound, outOfRange } from "./errors";
import { id as newId } from "./security";
import { mutateDatabase } from "./store";

/**
 * The module kinds authoring offers.
 *
 * `scorm` is deliberately absent. The schema has always accepted the value and
 * nothing implements it — no player, no manifest parsing, no runtime, no CMI
 * data model — so offering it would put a control in front of a customer that
 * produces a module no learner can open. An extension point is fine; a menu
 * item that does nothing is not.
 */
export const AUTHORABLE_MODULE_KINDS = ["lesson", "document", "video", "assessment"] as const;
export type AuthorableModuleKind = (typeof AUTHORABLE_MODULE_KINDS)[number];

export type CreateModuleInput = {
  courseId: string;
  title: string;
  kind: AuthorableModuleKind;
  durationMinutes: number;
  required: boolean;
  /** Only meaningful for `kind: "assessment"`; the caller must have checked it exists. */
  assessmentId: string | null;
  requestId: string;
};

export type UpdateModuleInput = {
  moduleId: string;
  title?: string;
  durationMinutes?: number;
  required?: boolean;
  assessmentId?: string | null;
  requestId: string;
};

function courseOrThrow(database: Database, principal: Principal, courseId: string) {
  const course = database.courses.find((item) => item.id === courseId && item.tenantId === principal.tenantId);
  if (!course) throw notFound("Course not found in your tenant");
  const org = orgFor(database, principal.tenantId, course.orgUnitId);
  if (!org) throw notFound("Course organization not found");
  // The same authorization the create route uses, so the structure of a course
  // cannot be edited by someone who could not have created it.
  authorize(principal, "course:create", { tenantId: principal.tenantId, orgUnit: org });
  return course;
}

/**
 * A published course is frozen.
 *
 * Learners may be part-way through it, and their progress is measured against
 * "every required module completed". Adding a required module under an
 * in-flight enrollment silently un-completes it; removing one silently
 * completes it. Neither is a change an author should be able to make by
 * accident.
 */
function requireDraftCourse(status: string): void {
  if (status !== "draft") {
    throw conflict("Only a draft course can be restructured. Learners may be part-way through a published one.");
  }
}

function modulesOf(database: Database, courseId: string): CourseModule[] {
  return database.courseModules
    .filter((item) => item.courseId === courseId)
    .sort((left, right) => left.position - right.position);
}

export async function createCourseModule(principal: Principal, input: CreateModuleInput): Promise<CourseModule> {
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 100000) {
    throw outOfRange("Duration must be a whole number of minutes, 0 or more");
  }
  if (input.assessmentId && input.kind !== "assessment") {
    // The database enforces this too (migration 008). Saying so here gives the
    // author the reason instead of a constraint violation.
    throw conflict("Only an assessment module can be linked to an assessment");
  }
  return mutateDatabase((database) => {
    const course = courseOrThrow(database, principal, input.courseId);
    requireDraftCourse(course.status);

    const siblings = modulesOf(database, course.id);
    if (input.assessmentId && database.courseModules.some((item) => item.assessmentId === input.assessmentId && item.tenantId === principal.tenantId)) {
      // One assessment backs at most one module, or a single passing attempt
      // would satisfy two modules of the same course and count twice.
      throw conflict("That assessment is already the content of another module");
    }

    const module: CourseModule = {
      id: newId(),
      tenantId: principal.tenantId,
      courseId: course.id,
      position: siblings.length + 1,
      title: input.title,
      kind: input.kind,
      durationMinutes: input.durationMinutes,
      required: input.required,
      assessmentId: input.assessmentId,
    };
    database.courseModules.push(module);
    appendAuditWithin(database, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.module.create",
      resourceType: "course_module", resourceId: module.id, outcome: "success", requestId: input.requestId,
      metadata: { courseId: course.id, kind: module.kind, assessmentId: module.assessmentId },
    });
    return module;
  });
}

export async function updateCourseModule(principal: Principal, input: UpdateModuleInput): Promise<CourseModule> {
  return mutateDatabase((database) => {
    const module = database.courseModules.find((item) => item.id === input.moduleId && item.tenantId === principal.tenantId);
    if (!module) throw notFound("Module not found in your tenant");
    const course = courseOrThrow(database, principal, module.courseId);
    requireDraftCourse(course.status);

    if (input.assessmentId !== undefined) {
      if (input.assessmentId && module.kind !== "assessment") throw conflict("Only an assessment module can be linked to an assessment");
      if (input.assessmentId && database.courseModules.some((item) => item.assessmentId === input.assessmentId && item.id !== module.id && item.tenantId === principal.tenantId)) {
        throw conflict("That assessment is already the content of another module");
      }
      module.assessmentId = input.assessmentId;
    }
    if (input.title !== undefined) module.title = input.title;
    if (input.required !== undefined) module.required = input.required;
    if (input.durationMinutes !== undefined) {
      if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 100000) {
        throw outOfRange("Duration must be a whole number of minutes, 0 or more");
      }
      module.durationMinutes = input.durationMinutes;
    }

    appendAuditWithin(database, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.module.update",
      resourceType: "course_module", resourceId: module.id, outcome: "success", requestId: input.requestId,
      metadata: { courseId: course.id, assessmentId: module.assessmentId, required: module.required },
    });
    return { ...module };
  });
}

export async function reorderCourseModules(
  principal: Principal, courseId: string, moduleIds: readonly string[], requestId: string,
): Promise<CourseModule[]> {
  return mutateDatabase((database) => {
    const course = courseOrThrow(database, principal, courseId);
    requireDraftCourse(course.status);
    const current = modulesOf(database, courseId);
    const requested = new Set(moduleIds);
    if (requested.size !== moduleIds.length) throw conflict("The new order lists the same module more than once");
    if (requested.size !== current.length || current.some((module) => !requested.has(module.id))) {
      // A partial list would silently drop modules from the course. Refusing is
      // the only safe answer.
      throw conflict("The new order must list every module in this course exactly once");
    }
    for (const [index, moduleId] of moduleIds.entries()) {
      const module = database.courseModules.find((item) => item.id === moduleId);
      if (module) module.position = index + 1;
    }
    appendAuditWithin(database, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.module.reorder",
      resourceType: "course", resourceId: courseId, outcome: "success", requestId,
      metadata: { modules: moduleIds.length },
    });
    return modulesOf(database, courseId).map((module) => ({ ...module }));
  });
}

export async function removeCourseModule(principal: Principal, moduleId: string, requestId: string): Promise<void> {
  await mutateDatabase((database) => {
    const module = database.courseModules.find((item) => item.id === moduleId && item.tenantId === principal.tenantId);
    if (!module) throw notFound("Module not found in your tenant");
    const course = courseOrThrow(database, principal, module.courseId);
    requireDraftCourse(course.status);
    if (database.moduleCompletions.some((item) => item.moduleId === moduleId)) {
      // Somebody has done it. Removing the module would erase the record that
      // they did, and completion history is evidence.
      throw conflict("A learner has already completed this module, so it cannot be removed");
    }
    database.courseModules = database.courseModules.filter((item) => item.id !== moduleId);
    for (const [index, sibling] of modulesOf(database, module.courseId).entries()) sibling.position = index + 1;
    appendAuditWithin(database, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.module.remove",
      resourceType: "course_module", resourceId: moduleId, outcome: "success", requestId,
      metadata: { courseId: module.courseId },
    });
  });
}

export type CoursePublishBlocker = { code: "no_modules" | "no_required_module" | "assessed_without_assessment" | "unlinked_assessment_module"; message: string };

/**
 * Why a course may not be published yet.
 *
 * The third and fourth rules are the ones that matter for evidence. An
 * `assessed` course that contains no assessment module can never emit
 * competence evidence — `recordModuleCompletion` computes its final score from
 * assessment-module scores and withholds evidence when there are none — so
 * publishing one produces a course that looks like a qualification and can
 * never award anything. And an assessment module with no assessment linked is
 * the old free-text-score behaviour, which is not a thing to publish.
 */
export function coursePublishBlockers(database: Database, courseId: string): CoursePublishBlocker[] {
  const course = database.courses.find((item) => item.id === courseId);
  if (!course) return [];
  const modules = modulesOf(database, courseId);
  const blockers: CoursePublishBlocker[] = [];
  if (modules.length === 0) blockers.push({ code: "no_modules", message: "Add at least one module before publishing." });
  else if (!modules.some((module) => module.required)) {
    blockers.push({ code: "no_required_module", message: "At least one module must be required, or the course completes without anyone doing anything." });
  }
  const assessmentModules = modules.filter((module) => module.kind === "assessment");
  if (course.evidenceRule === "assessed" && assessmentModules.length === 0) {
    blockers.push({
      code: "assessed_without_assessment",
      message: "This course awards evidence on assessment, but has no assessment module — so it could never award anything.",
    });
  }
  const unlinked = assessmentModules.filter((module) => !module.assessmentId);
  if (unlinked.length > 0) {
    blockers.push({
      code: "unlinked_assessment_module",
      message: `${unlinked.length} assessment module${unlinked.length === 1 ? " has" : "s have"} no assessment attached.`,
    });
  }
  return blockers;
}

export async function setCourseLifecycle(
  principal: Principal, courseId: string, target: "draft" | "published" | "retired", requestId: string,
): Promise<{ status: string; blockers: CoursePublishBlocker[] }> {
  return mutateDatabase((database) => {
    const course = courseOrThrow(database, principal, courseId);
    if (course.status === target) throw conflict(`This course is already ${target}`);
    if (target === "published") {
      const blockers = coursePublishBlockers(database, courseId);
      if (blockers.length > 0) throw conflict(blockers.map((blocker) => blocker.message).join(" "));
    }
    if (target === "draft" && database.enrollments.some((item) => item.courseId === courseId && item.status !== "withdrawn")) {
      throw conflict("Learners are enrolled on this course, so it cannot be returned to draft. Retire it and publish a new version instead.");
    }
    const from = course.status;
    course.status = target;
    appendAuditWithin(database, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: `course.${target}`,
      resourceType: "course", resourceId: courseId, outcome: "success", requestId,
      metadata: { from },
    });
    return { status: target, blockers: [] };
  });
}
