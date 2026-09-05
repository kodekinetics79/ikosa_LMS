import type { Course, CourseModule, Database, Enrollment, Evidence, ModuleCompletion } from "./domain";
import { id as newId } from "./security";

export type CompletionOutcome = {
  enrollment: Enrollment;
  /** Evidence emitted by this completion, when the course is entitled to emit any. */
  evidence: Evidence | null;
  /**
   * Why no evidence was produced. Stated explicitly so the interface can say so
   * rather than leaving a learner to assume a gap was closed.
   */
  evidenceWithheldReason: "not_complete" | "attendance_only" | "assessment_not_passed" | "already_complete" | null;
  completedModuleIds: string[];
  outstandingModuleIds: string[];
};

export function modulesForCourse(database: Database, courseId: string): CourseModule[] {
  return database.courseModules.filter((module) => module.courseId === courseId).sort((a, b) => a.position - b.position);
}

function addMonths(from: Date, months: number): string {
  const result = new Date(from);
  result.setMonth(result.getMonth() + months);
  return result.toISOString();
}

/**
 * Records a module completion and, when the enrollment thereby finishes,
 * decides whether it may produce competence evidence.
 *
 * The evidence decision lives here, attached to the completion itself, rather
 * than in a route handler or a convenience wrapper. Any caller that completes a
 * module necessarily passes through this rule; none can reach completion while
 * skipping the evidence decision.
 */
export function recordModuleCompletion(
  database: Database,
  enrollment: Enrollment,
  moduleId: string,
  score: number | null,
  now = new Date(),
): CompletionOutcome {
  const course = database.courses.find((candidate) => candidate.id === enrollment.courseId && candidate.tenantId === enrollment.tenantId);
  if (!course) throw new Error("Course not found for enrollment");

  // Terminal states are enforced here, on the operation itself. Guarding this
  // only in the route handler would let any other caller re-complete a finished
  // enrollment and mint a second Evidence record for one course completion.
  if (enrollment.status === "completed" || enrollment.status === "withdrawn") {
    const done = database.moduleCompletions.filter((candidate) => candidate.enrollmentId === enrollment.id);
    return {
      enrollment,
      evidence: null,
      evidenceWithheldReason: "already_complete",
      completedModuleIds: done.map((candidate) => candidate.moduleId),
      outstandingModuleIds: [],
    };
  }

  const modules = modulesForCourse(database, course.id);
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) throw new Error("Module does not belong to the enrolled course");

  // Idempotent: replaying the same module completion must not duplicate rows,
  // and must not append a second Evidence record for one course completion.
  const existing = database.moduleCompletions.find(
    (candidate) => candidate.enrollmentId === enrollment.id && candidate.moduleId === moduleId,
  );
  if (existing) {
    existing.completedAt = now.toISOString();
    existing.score = score;
  } else {
    const completion: ModuleCompletion = {
      id: newId(),
      tenantId: enrollment.tenantId,
      enrollmentId: enrollment.id,
      moduleId,
      completedAt: now.toISOString(),
      score,
    };
    database.moduleCompletions.push(completion);
  }

  if (enrollment.status === "enrolled") {
    enrollment.status = "in_progress";
    enrollment.startedAt = enrollment.startedAt ?? now.toISOString();
  }

  const completions = database.moduleCompletions.filter((candidate) => candidate.enrollmentId === enrollment.id);
  const completedIds = new Set(completions.map((candidate) => candidate.moduleId));
  const requiredModules = modules.filter((candidate) => candidate.required);
  const outstanding = requiredModules.filter((candidate) => !completedIds.has(candidate.id));

  const base = {
    enrollment,
    completedModuleIds: [...completedIds],
    outstandingModuleIds: outstanding.map((candidate) => candidate.id),
  };

  if (outstanding.length > 0) {
    return { ...base, evidence: null, evidenceWithheldReason: "not_complete" };
  }

  // An attendance-only course records that someone attended. It is not a claim
  // that they can do the work, so it must not manufacture competence evidence.
  if (course.evidenceRule === "attendance_only") {
    enrollment.status = "completed";
    enrollment.completedAt = now.toISOString();
    enrollment.score = null;
    return { ...base, evidence: null, evidenceWithheldReason: "attendance_only" };
  }

  const assessmentScores = completions
    .filter((candidate) => modules.find((item) => item.id === candidate.moduleId)?.kind === "assessment")
    .map((candidate) => candidate.score)
    .filter((value): value is number => typeof value === "number");

  const finalScore = assessmentScores.length > 0 ? Math.min(...assessmentScores) : null;
  enrollment.score = finalScore;

  // An assessed course that was never actually assessed, or was failed, yields
  // no evidence. Refusing is the correct outcome: a silently generous pass mark
  // would put an unqualified person on a safety-critical roster.
  if (finalScore === null || finalScore < course.passingScore) {
    // Deliberately NOT marked complete. Completing a failed attempt would close
    // the only route back: the learner could no longer record progress, so the
    // retake that the whole intervention depends on becomes impossible.
    return { ...base, evidence: null, evidenceWithheldReason: "assessment_not_passed" };
  }

  enrollment.status = "completed";
  enrollment.completedAt = now.toISOString();

  const evidence: Evidence = {
    id: newId(),
    tenantId: enrollment.tenantId,
    orgUnitId: enrollment.orgUnitId,
    subjectUserId: enrollment.subjectUserId,
    skillId: course.skillId,
    type: "assessment",
    proficiencyLevel: course.targetLevel,
    // Confidence follows the achieved score rather than being assumed perfect.
    strength: Number(finalScore.toFixed(2)),
    observedAt: now.toISOString(),
    expiresAt: course.validityMonths ? addMonths(now, course.validityMonths) : null,
    // Machine-attested from an assessment, not vouched for by a person. Leaving
    // this null keeps assessor separation of duties honest.
    assessorUserId: null,
    sourceReference: `COURSE:${course.code} v${course.version} / ENROLLMENT:${enrollment.id}`,
    status: "verified",
  };

  database.evidence.push(evidence);
  enrollment.evidenceId = evidence.id;

  return { ...base, evidence, evidenceWithheldReason: null };
}

/**
 * Recomputes the evidenced level on any open gap case for this subject and
 * skill. Gap closure is derived from Evidence rather than asserted by the
 * learning module, so the ledger keeps one answer to "is this person ready".
 */
export function refreshGapsForEvidence(database: Database, evidence: Evidence, now = new Date()): string[] {
  const touched: string[] = [];
  for (const gap of database.gapCases) {
    if (gap.tenantId !== evidence.tenantId || gap.subjectUserId !== evidence.subjectUserId) continue;
    const requirement = database.requirements.find((candidate) => candidate.id === gap.requirementId);
    if (!requirement || requirement.skillId !== evidence.skillId) continue;

    const best = database.evidence
      .filter((candidate) =>
        candidate.tenantId === gap.tenantId &&
        candidate.subjectUserId === gap.subjectUserId &&
        candidate.skillId === requirement.skillId &&
        candidate.status === "verified" &&
        (!candidate.expiresAt || new Date(candidate.expiresAt).getTime() > now.getTime()))
      .reduce((max, candidate) => Math.max(max, candidate.proficiencyLevel), 0);

    gap.evidencedLevel = best;
    gap.gap = Math.max(0, gap.requiredLevel - best);
    // "verified" is reserved for a human confirming the gap is closed; reaching
    // the required level moves it to actioned so it still appears for review.
    if (gap.gap === 0 && gap.status !== "verified") gap.status = "actioned";
    touched.push(gap.id);
  }
  return touched;
}

export function courseProgress(database: Database, enrollment: Enrollment): { completed: number; total: number; percent: number } {
  const required = modulesForCourse(database, enrollment.courseId).filter((module) => module.required);
  const completedIds = new Set(
    database.moduleCompletions.filter((candidate) => candidate.enrollmentId === enrollment.id).map((candidate) => candidate.moduleId),
  );
  const completed = required.filter((module) => completedIds.has(module.id)).length;
  return { completed, total: required.length, percent: required.length ? Math.round((completed / required.length) * 100) : 0 };
}
