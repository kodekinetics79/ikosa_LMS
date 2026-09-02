import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, isSelfScopedOnly, principalFromRequest } from "@/lib/server/auth";
import { orgFor, visibleRows } from "@/lib/server/domain-service";
import type { Enrollment } from "@/lib/server/domain";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { courseProgress, modulesForCourse } from "@/lib/server/learning";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    const items = visibleRows(db, principal, "enrollment:read", db.enrollments).map((enrollment) => {
      const course = db.courses.find((candidate) => candidate.id === enrollment.courseId);
      return {
        ...enrollment,
        course: course ? { id: course.id, code: course.code, title: course.title, evidenceRule: course.evidenceRule, targetLevel: course.targetLevel, skillId: course.skillId } : null,
        progress: courseProgress(db, enrollment),
        modules: modulesForCourse(db, enrollment.courseId),
        completedModuleIds: db.moduleCompletions.filter((candidate) => candidate.enrollmentId === enrollment.id).map((candidate) => candidate.moduleId),
      };
    });
    return json({ items, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const db = await readDatabase();

    const courseId = requiredString(body, "courseId", 100);
    const course = db.courses.find((candidate) => candidate.id === courseId && candidate.tenantId === principal.tenantId);
    if (!course) throw new ValidationError("Validation failed", { courseId: "Course not found in tenant" });
    if (course.status !== "published") throw new ValidationError("Validation failed", { courseId: "Only published courses accept enrollment" });

    const subjectUserId = typeof body.subjectUserId === "string" && body.subjectUserId.trim() ? body.subjectUserId.trim() : principal.user.id;
    const subject = db.users.find((user) => user.id === subjectUserId && user.tenantId === principal.tenantId && user.active);
    if (!subject) throw new ValidationError("Validation failed", { subjectUserId: "Subject not found in tenant" });

    // Enrol the learner where they sit in the organization, not where the
    // caller sits, so downstream org scoping stays truthful.
    const org = orgFor(db, principal.tenantId, subject.orgUnitId);
    if (!org) throw new ValidationError("Validation failed", { subjectUserId: "Subject has no resolvable organizational unit" });
    authorize(principal, "enrollment:create", { tenantId: principal.tenantId, orgUnit: org, subjectUserId });

    if (isSelfScopedOnly(principal) && subjectUserId !== principal.user.id) {
      throw new ValidationError("Validation failed", { subjectUserId: "Learners may only enroll themselves" });
    }

    // One active enrollment per learner per course. Completed enrollments do not
    // block a new one, so requalification after evidence expiry stays possible.
    const active = db.enrollments.find((candidate) =>
      candidate.tenantId === principal.tenantId &&
      candidate.courseId === courseId &&
      candidate.subjectUserId === subjectUserId &&
      (candidate.status === "enrolled" || candidate.status === "in_progress"));
    if (active) throw new ValidationError("Validation failed", { courseId: "An active enrollment already exists for this learner and course" });

    const interventionId = typeof body.interventionId === "string" ? body.interventionId : null;
    if (interventionId && !db.interventions.some((candidate) => candidate.id === interventionId && candidate.tenantId === principal.tenantId)) {
      throw new ValidationError("Validation failed", { interventionId: "Intervention not found in tenant" });
    }
    const gapCaseId = typeof body.gapCaseId === "string" ? body.gapCaseId : null;
    if (gapCaseId && !db.gapCases.some((candidate) => candidate.id === gapCaseId && candidate.tenantId === principal.tenantId)) {
      throw new ValidationError("Validation failed", { gapCaseId: "Gap case not found in tenant" });
    }

    const enrollment: Enrollment = {
      id: newId("enr"),
      tenantId: principal.tenantId,
      orgUnitId: subject.orgUnitId,
      courseId,
      subjectUserId,
      source: optionalEnum(body, "source", ["self", "assigned", "intervention"] as const, subjectUserId === principal.user.id ? "self" : "assigned"),
      interventionId,
      gapCaseId,
      status: "enrolled",
      assignedByUserId: subjectUserId === principal.user.id ? null : principal.user.id,
      dueDate: typeof body.dueDate === "string" ? body.dueDate : null,
      startedAt: null,
      completedAt: null,
      score: null,
      evidenceId: null,
      createdAt: new Date().toISOString(),
    };

    await mutateDatabase((state) => state.enrollments.push(enrollment));
    await appendAudit({
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "enrollment.create",
      resourceType: "enrollment", resourceId: enrollment.id, outcome: "success", requestId: rid,
      metadata: { courseId, subjectUserId, source: enrollment.source, interventionId },
    });
    return json(enrollment, { status: 201 });
  } catch (error) { return problem(error, rid); }
}
