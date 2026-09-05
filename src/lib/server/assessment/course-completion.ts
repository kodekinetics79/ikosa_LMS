import "server-only";

/**
 * The bridge from a finalized assessment attempt to course completion.
 *
 * THE ONE RULE THIS FILE OBEYS
 *
 * It does not decide whether anyone is competent. That decision has exactly one
 * home — `recordModuleCompletion` in src/lib/server/learning.ts — and this
 * calls it through the repository wrapper that already runs it
 * (`OsaRepository.completeModule`). Nothing here re-implements the evidence
 * rule, the pass gate, the terminal-state guard or the gap recalculation, and
 * nothing here writes an `osa.evidence` row.
 *
 * That matters more than it might look. A compliance product with two answers
 * to "is this person competent" has no answer at all, and the second engine is
 * always the one somebody forgets to update.
 *
 * WHAT IT ACTUALLY DOES
 *
 *   1. Is this assessment attached to a course module? (migration 008)
 *   2. Is this learner enrolled on that course, and still active?
 *   3. If both: record the module completion with the achieved score, and let
 *      the existing authority decide everything that follows.
 *
 * Either question answering "no" is an ordinary outcome, not an error: an
 * assessment can legitimately stand alone, and a learner can legitimately
 * attempt one without an enrollment.
 *
 * WHAT STAYS TRUE BY CONSTRUCTION
 *
 *   * A FAILED assessment emits no competence evidence. The completion is
 *     recorded with the achieved score, and `recordModuleCompletion` withholds
 *     evidence and deliberately leaves the enrollment open for a retake when
 *     that score is below the COURSE's passing score — which is the course's
 *     decision to make, not the assessment's.
 *   * An ATTENDANCE-ONLY course emits no competence evidence, whatever the
 *     score. That branch is upstream of the pass gate in learning.ts.
 *   * Replaying a completion never mints a second evidence record: the
 *     completion is keyed on (enrollment, module) and a completed enrollment is
 *     terminal.
 */

import type { Principal } from "../auth";
import type { PoolClient } from "../db/driver";
import { repositoryOnClient, scopeFromPrincipal } from "../db/postgres";
import type { CompletionResult } from "../db/repository";
import { isSelfScopedOnly } from "../auth";
import { appendAssessmentAudit, num } from "./runtime";

export type CourseProgressOutcome = {
  moduleId: string;
  enrollmentId: string;
  courseId: string;
  /** The evidence id, when the completion warranted one. Null is the common case. */
  evidenceId: string | null;
  evidenceWithheldReason: CompletionResult["evidenceWithheldReason"];
  enrollmentStatus: string;
  gapCasesRecalculated: readonly string[];
};

/**
 * Builds the SQL scope for a completion that is being recorded ON BEHALF OF a
 * learner.
 *
 * The actor may be the learner (auto-scored submit) or an assessor (after
 * manual marking), and the rows being written belong to the learner either way.
 * Tenant isolation is what protects this and it is unchanged — RLS filters on
 * `app.tenant_id`, which the enclosing transaction has already set from the
 * validated session. The delegated org scope is deliberately NOT applied to the
 * write: whether this learner's completion may be recorded was already decided
 * by the marking-authority check that let the actor grade the attempt at all,
 * and re-deriving it here from the actor's own org would make an assessor
 * unable to finalize the very attempt they were entitled to mark.
 */
function completionScope(principal: Principal) {
  return scopeFromPrincipal({
    tenantId: principal.tenantId,
    user: { id: principal.user.id, orgUnitId: principal.user.orgUnitId },
    delegatedOrgPaths: principal.delegatedOrgPaths,
    selfOnly: isSelfScopedOnly(principal),
    viewerOrgPath: principal.delegatedOrgPaths[0] ?? "",
  });
}

/**
 * Records the course-module completion a finalized attempt satisfies, if any.
 *
 * MUST be called inside the transaction that finalized the attempt, so the
 * attempt result and the completion it caused commit together. A crash between
 * them would leave a graded pass that no course ever heard about.
 *
 * `percentage` is the attempt's 0-100 result; course scores are 0..1 fractions,
 * which is the units `course.passingScore` is in.
 */
export async function recordAssessmentCourseProgress(
  client: PoolClient,
  principal: Principal,
  input: {
    assessmentId: string;
    subjectUserId: string;
    percentage: number | null;
    requestId: string;
    attemptId: string;
  },
): Promise<CourseProgressOutcome | null> {
  // 1. Is this assessment the content of a course module?
  const { rows: moduleRows } = await client.query<{ id: string; course_id: string }>(
    `SELECT m.id::text, m.course_id::text
       FROM osa.course_modules m
      WHERE m.assessment_id = $1::uuid`,
    [input.assessmentId],
  );
  const module = moduleRows[0];
  if (!module) return null;

  // 2. Is the learner enrolled on it, and still active? `completed` and
  //    `withdrawn` are terminal; feeding a completion into either would be
  //    refused downstream anyway, and skipping it keeps the audit trail honest
  //    about what actually happened.
  const { rows: enrollmentRows } = await client.query<{ id: string }>(
    `SELECT en.id::text
       FROM osa.enrollments en
      WHERE en.course_id = $1::uuid
        AND en.subject_user_id = $2::uuid
        AND en.status IN ('enrolled','in_progress')
      ORDER BY en.created_at DESC
      LIMIT 1`,
    [module.course_id, input.subjectUserId],
  );
  const enrollment = enrollmentRows[0];
  if (!enrollment) return null;

  // 3. Hand over to the single authority. Everything after this line — whether
  //    the course completes, whether evidence is emitted, at what level, with
  //    what expiry, and which gaps move — is decided by learning.ts.
  const repository = repositoryOnClient(client, completionScope(principal));
  const score = input.percentage === null ? null : Math.max(0, Math.min(1, num(input.percentage) / 100));
  const result = await repository.completeModule({
    enrollmentId: enrollment.id,
    moduleId: module.id,
    score,
  });

  await appendAssessmentAudit(
    client, principal, input.requestId,
    "assessment.course.progress", "enrollment", enrollment.id,
    {
      attemptId: input.attemptId,
      assessmentId: input.assessmentId,
      moduleId: module.id,
      score,
      enrollmentStatus: result.enrollment.status,
      // Recorded on every call, including the null case: "evidence was emitted"
      // and "evidence was withheld, for this reason" are both facts the ledger
      // has to be able to answer later.
      evidenceEmitted: result.evidence !== null,
      evidenceWithheldReason: result.evidenceWithheldReason,
    },
  );

  return {
    moduleId: module.id,
    enrollmentId: enrollment.id,
    courseId: module.course_id,
    evidenceId: result.evidence?.id ?? null,
    evidenceWithheldReason: result.evidenceWithheldReason,
    enrollmentStatus: result.enrollment.status,
    gapCasesRecalculated: result.gapCasesRecalculated,
  };
}
