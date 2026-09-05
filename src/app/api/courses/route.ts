import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { availableCourses, orgFor } from "@/lib/server/domain-service";
import type { Course } from "@/lib/server/domain";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { modulesForCourse } from "@/lib/server/learning";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    authorize(principal, "course:read", { tenantId: principal.tenantId });
    const courses = availableCourses(db, principal, db.courses);
    const items = courses.map((course) => {
      const modules = modulesForCourse(db, course.id);
      return {
        ...course,
        moduleCount: modules.length,
        durationMinutes: modules.reduce((total, module) => total + module.durationMinutes, 0),
        modules,
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

    const orgUnitId = requiredString(body, "orgUnitId", 100);
    const skillId = requiredString(body, "skillId", 100);
    const org = orgFor(db, principal.tenantId, orgUnitId);
    const skill = db.skills.find((item) => item.id === skillId && item.tenantId === principal.tenantId);
    if (!org || !skill) throw new ValidationError("Validation failed", { reference: "Organization or skill not found in tenant" });
    authorize(principal, "course:create", { tenantId: principal.tenantId, orgUnit: org });

    const targetLevel = Number(body.targetLevel);
    if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel > 5) {
      throw new ValidationError("Validation failed", { targetLevel: "Target level must be an integer 0-5" });
    }
    const evidenceRule = optionalEnum(body, "evidenceRule", ["assessed", "attendance_only"] as const, "assessed");
    const passingScore = body.passingScore === undefined ? 0.8 : Number(body.passingScore);
    if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 1) {
      throw new ValidationError("Validation failed", { passingScore: "Passing score must be between 0 and 1" });
    }
    if (evidenceRule === "attendance_only" && passingScore !== 0) {
      // The schema enforces this (`courses_check1`), so without the check here
      // the request reached the write and came back as an opaque 500. The rule
      // is real: an attendance-only course records that somebody turned up, and
      // a pass mark on a thing nobody is marked on is a number with no meaning.
      throw new ValidationError("Validation failed", {
        passingScore: "An attendance-only course has no passing score. Set it to 0, or make this course assessed.",
      });
    }
    const validityMonths = body.validityMonths === null || body.validityMonths === undefined ? null : Number(body.validityMonths);
    if (validityMonths !== null && (!Number.isInteger(validityMonths) || validityMonths <= 0)) {
      throw new ValidationError("Validation failed", { validityMonths: "Validity must be a positive whole number of months" });
    }

    const course: Course = {
      id: newId(),
      tenantId: principal.tenantId,
      orgUnitId,
      code: requiredString(body, "code", 40),
      title: requiredString(body, "title", 200),
      description: requiredString(body, "description", 1000),
      skillId,
      targetLevel,
      evidenceRule,
      passingScore,
      validityMonths,
      version: 1,
      status: optionalEnum(body, "status", ["draft", "published", "retired"] as const, "draft"),
      createdAt: new Date().toISOString(),
    };

    await mutateDatabase((state) => state.courses.push(course));
    await appendAudit({
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.create",
      resourceType: "course", resourceId: course.id, outcome: "success", requestId: rid,
      metadata: { code: course.code, skillId, targetLevel, evidenceRule },
    });
    return json(course, { status: 201 });
  } catch (error) { return problem(error, rid); }
}
