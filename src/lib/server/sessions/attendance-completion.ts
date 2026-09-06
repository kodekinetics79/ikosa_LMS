import "server-only";

/**
 * The bridge from a recorded attendance to course completion.
 *
 * THE ONE RULE THIS FILE OBEYS — the same one `assessment/course-completion.ts`
 * obeys, for the same reason.
 *
 * It does not decide whether anyone is competent, and it does not write an
 * `osa.evidence` row. `recordModuleCompletion` in learning.ts is the single
 * authority for both, and this reaches it through the transactional wrapper
 * that already runs it. A compliance product with two answers to "is this
 * person competent" has no answer, and the second engine is always the one
 * somebody forgets to update.
 *
 * WHY ATTENDANCE CANNOT MANUFACTURE COMPETENCE
 *
 * The completion is recorded with a score of `null`, always. That is not a
 * placeholder — it is the fact. Attendance evidences that somebody was present;
 * it says nothing about whether they can do the work, and the domain already
 * encodes that in two independent places:
 *
 *   * an `attendance_only` course completes and emits NO evidence
 *     (learning.ts: "recording that someone attended is not a claim that they
 *     can do the work");
 *   * an `assessed` course computes its final score from assessment-kind module
 *     completions only, so a null-scored attendance contributes nothing and the
 *     pass gate still withholds evidence until a real assessment is passed.
 *
 * So attendance can COMPLETE a course. It can never, by any path through this
 * file, cause competence evidence to be emitted.
 *
 * ONLY 'attended' COUNTS
 *
 * `partial`, `absent` and `excused` record no completion. Partial attendance is
 * not attendance, and an excusal is a reason not to hold someone to a
 * requirement rather than a claim they met it.
 *
 * KNOWN LIMIT, STATED RATHER THAN HIDDEN: a completion cannot be retracted. The
 * runtime role holds no DELETE on `osa.module_completions` (migration 002, by
 * design — retirement is a status change, not a delete), so correcting an
 * attendance from `attended` to `absent` leaves the module completion standing.
 * Un-completing an enrollment needs a deliberate reversal path with its own
 * audit action; it is not something to bolt onto a typo correction.
 */

import type { Principal } from "../auth";
import { isSelfScopedOnly } from "../auth";
import type { PoolClient } from "../db/driver";
import { repositoryOnClient, scopeFromPrincipal } from "../db/postgres";
import type { CompletionResult } from "../db/repository";
import { appendAssessmentAudit } from "../assessment/runtime";

export type AttendanceProgressOutcome = {
  subjectUserId: string;
  moduleId: string;
  enrollmentId: string;
  courseId: string;
  enrollmentStatus: string;
  /** Null in every case reachable from here; carried so the ledger can say so. */
  evidenceId: string | null;
  evidenceWithheldReason: CompletionResult["evidenceWithheldReason"];
};

/**
 * The completion is recorded ON BEHALF OF the learner by whoever took the
 * register. Tenant isolation is what protects this and is unchanged — RLS
 * filters on `app.tenant_id`, already set by the enclosing transaction from the
 * validated session. Whether this recorder may act for this learner was decided
 * before we got here, by the scope check in `recordAttendance`; re-deriving it
 * from the recorder's own organization would make an instructor unable to
 * complete the very register they were entitled to take.
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
 * Records the course-module completion an attendance satisfies, for everyone in
 * this batch marked `attended`.
 *
 * MUST run inside the transaction that wrote the attendance, so the register and
 * the completions it causes commit together. A crash between them would leave a
 * signed attendance that no course ever heard about.
 *
 * Returns one outcome per learner it actually completed something for. A session
 * that delivers no module, or a learner with no active enrollment, is an
 * ordinary outcome and not an error: a briefing can legitimately stand alone,
 * and somebody can legitimately attend a session for a course they are not on.
 */
export async function recordAttendanceCourseProgress(
  client: PoolClient,
  principal: Principal,
  input: {
    sessionId: string;
    /** The course module this session delivers, or null for a standalone session. */
    moduleId: string | null;
    courseId: string | null;
    /** Only those marked `attended`. The caller filters; this asserts nothing else did. */
    attendedUserIds: readonly string[];
    requestId: string;
  },
): Promise<AttendanceProgressOutcome[]> {
  if (!input.moduleId || !input.courseId || input.attendedUserIds.length === 0) return [];

  // Which of these learners has an enrollment still open on that course?
  // `completed` and `withdrawn` are terminal; feeding a completion into either
  // is refused downstream anyway, and skipping it keeps the audit honest about
  // what actually happened.
  const { rows: enrollments } = await client.query<{ id: string; subject_user_id: string }>(
    `SELECT DISTINCT ON (en.subject_user_id) en.id::text, en.subject_user_id::text
       FROM osa.enrollments en
      WHERE en.course_id = $1::uuid
        AND en.subject_user_id = ANY($2::uuid[])
        AND en.status IN ('enrolled','in_progress')
      ORDER BY en.subject_user_id, en.created_at DESC`,
    [input.courseId, [...input.attendedUserIds]],
  );
  if (enrollments.length === 0) return [];

  const repository = repositoryOnClient(client, completionScope(principal));
  const outcomes: AttendanceProgressOutcome[] = [];

  for (const enrollment of enrollments) {
    // score: null, always. See the header — this is the fact, not a placeholder.
    const result = await repository.completeModule({
      enrollmentId: enrollment.id,
      moduleId: input.moduleId,
      score: null,
    });
    outcomes.push({
      subjectUserId: enrollment.subject_user_id,
      moduleId: input.moduleId,
      enrollmentId: enrollment.id,
      courseId: input.courseId,
      enrollmentStatus: result.enrollment.status,
      evidenceId: result.evidence?.id ?? null,
      evidenceWithheldReason: result.evidenceWithheldReason,
    });
  }

  await appendAssessmentAudit(
    client, principal, input.requestId,
    "session.attendance.progress", "live_session", input.sessionId,
    {
      moduleId: input.moduleId,
      courseId: input.courseId,
      completed: outcomes.length,
      // Recorded even though it is null on every path here. "No evidence was
      // emitted, for this reason" is a fact the ledger has to be able to answer
      // later, and an entry that only appears when evidence WAS emitted cannot
      // answer it.
      evidenceEmitted: outcomes.filter((outcome) => outcome.evidenceId !== null).length,
      completedEnrollments: outcomes.filter((outcome) => outcome.enrollmentStatus === "completed").length,
    },
  );

  return outcomes;
}
