import "server-only";

/**
 * The whole of one learner's script, assembled for the person marking it.
 *
 * THE GAP THIS CLOSES
 *
 * `listMarkingQueue` returns loose responses: one row per unmarked answer, each
 * carrying its own prompt and its own learner name. A marker working that queue
 * awards points to a paragraph with no sight of the objective section the same
 * learner already answered, no running total, and no way to know whether this
 * item is the last one standing between the attempt and a final result. Marks
 * awarded without that context are marks awarded blind, and this product treats
 * a mark as competence evidence.
 *
 * Every `assessment_items` row is returned, not every response, via a LEFT JOIN
 * onto `assessment_responses`. An item the learner skipped has no response row
 * at all, so a response-driven read silently omits it and the marker never sees
 * that the question went unanswered.
 *
 * DISCLOSURE
 *
 * `rationale` IS selected: it is the author's marking guidance and this is a
 * grader-only surface. `answer_key` is NOT selected, and deliberately never
 * enters the select list, so it cannot leak later by a field being added to a
 * type. A marker who needs the key needs the authoring view.
 */

import type { Principal } from "../auth";
import { forbidden, notFound } from "../errors";
import { bool, canGradeAssessments, isoOrNull, num, numOrNull, readTx, scopePaths } from "./runtime";

export type AttemptScriptItem = {
  /** null when the learner never answered: there is no response row to mark. */
  responseId: string | null;
  questionId: string;
  position: number;
  questionType: string;
  prompt: string;
  /** Author's marking guidance. Grader-only; never returned to a learner. */
  rationale: string;
  response: unknown;
  maxPoints: number;
  required: boolean;
  autoScored: boolean;
  finalScore: number | null;
  feedback: string;
};

export type AttemptScript = {
  attempt: {
    id: string;
    assessmentId: string;
    subjectUserId: string;
    attemptNumber: number;
    status: string;
    submittedAt: string | null;
    scorePoints: number | null;
    maxPoints: number | null;
    percentage: number | null;
    passed: boolean | null;
  };
  assessment: { id: string; code: string; title: string; passPercentage: number };
  learner: { id: string; displayName: string; email: string };
  items: AttemptScriptItem[];
  /** Required items with no final score: what still blocks the final result. */
  awaitingMarking: number;
  /** Points banked so far, objective and manual together. */
  provisionalPoints: number;
  /** Every item's points, whether answered or not — the denominator. */
  totalPoints: number;
};

/**
 * One attempt in full, for a marker with authority over it.
 *
 * The WHERE clause is the same marking-authority rule the queue and
 * `gradeAssessmentResponse` use: the LEARNER must sit in the marker's delegated
 * scope, and the assessment must be one the marker can legitimately see. A
 * third copy of that predicate that drifts from the other two produces a script
 * a marker can read but not grade, or worse, one they can grade but not read.
 *
 * A miss is 404, never 500 and never 403: confirming that an attempt id exists
 * would disclose another organization's data to a marker who cannot mark it.
 */
export async function attemptScript(principal: Principal, attemptId: string): Promise<AttemptScript> {
  if (!canGradeAssessments(principal)) throw forbidden("Assessment grading permission required");

  return readTx(principal, async (client) => {
    const { roots, viewer } = scopePaths(principal);
    const { rows } = await client.query(
      // status IN ('submitted','graded') rather than ='submitted' as the queue
      // uses. 'in_progress' is excluded because reading a live script mid-exam
      // is surveillance, not marking. 'graded' MUST be included: the attempt
      // finalizes the instant the last required item is marked, and the marking
      // screen refetches the script after every save — pinning this to
      // 'submitted' would make the final mark of every attempt appear to fail.
      `SELECT x.id,x.assessment_id,x.subject_user_id,x.attempt_number,x.status,x.submitted_at,
              x.score_points::float8 AS score_points,x.max_points::float8 AS max_points,
              x.percentage::float8 AS percentage,x.passed,
              a.code,a.title,a.pass_percentage::float8 AS pass_percentage,
              u.display_name,u.email::text AS email
         FROM osa.assessment_attempts x
         JOIN osa.assessments a ON a.tenant_id=x.tenant_id AND a.id=x.assessment_id
         JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
         JOIN osa.users u ON u.tenant_id=x.tenant_id AND u.id=x.subject_user_id
         JOIN osa.org_units lou ON lou.tenant_id=u.tenant_id AND lou.id=u.org_unit_id
        WHERE x.id=$1::uuid
          AND x.status IN ('submitted','graded')
          AND lou.path <@ ANY($2::ltree[])
          AND (ou.path <@ ANY($2::ltree[]) OR ou.path @> $3::ltree)`,
      [attemptId, roots, viewer],
    );
    const head = rows[0];
    if (!head) throw notFound("Attempt is not available for marking");

    const { rows: itemRows } = await client.query(
      // LEFT JOIN on responses, driven by assessment_items: an item the learner
      // skipped has no response row, and a response-driven read would hide it.
      // q.answer_key is not selected here and must not be added.
      `SELECT i.position,i.required,coalesce(i.points_override,q.points)::float8 AS max_points,
              q.id AS question_id,q.question_type,q.prompt,q.rationale,
              r.id AS response_id,r.response,
              r.auto_score::float8 AS auto_score,r.final_score::float8 AS final_score,r.feedback
         FROM osa.assessment_items i
         JOIN osa.assessment_questions q ON q.tenant_id=i.tenant_id AND q.id=i.question_id
         LEFT JOIN osa.assessment_responses r
           ON r.tenant_id=i.tenant_id AND r.attempt_id=$2::uuid AND r.question_id=i.question_id
        WHERE i.assessment_id=$1::uuid
        ORDER BY i.position`,
      [String(head.assessment_id), attemptId],
    );

    const items: AttemptScriptItem[] = itemRows.map((row) => ({
      responseId: row.response_id ? String(row.response_id) : null,
      questionId: String(row.question_id),
      position: num(row.position),
      questionType: String(row.question_type),
      prompt: String(row.prompt),
      rationale: String(row.rationale ?? ""),
      response: row.response ?? null,
      maxPoints: num(row.max_points),
      required: bool(row.required),
      // Read from the data, not guessed from the question type: an item is
      // auto-scored when the submit pass actually wrote an auto_score. A type
      // that is nominally objective but was never machine-scored still needs a
      // human, and the marker must be told which case they are looking at.
      autoScored: row.auto_score !== null && row.auto_score !== undefined,
      finalScore: numOrNull(row.final_score),
      feedback: String(row.feedback ?? ""),
    }));

    return {
      attempt: {
        id: String(head.id),
        assessmentId: String(head.assessment_id),
        subjectUserId: String(head.subject_user_id),
        attemptNumber: num(head.attempt_number),
        status: String(head.status),
        submittedAt: isoOrNull(head.submitted_at),
        scorePoints: numOrNull(head.score_points),
        maxPoints: numOrNull(head.max_points),
        percentage: numOrNull(head.percentage),
        passed: head.passed === null || head.passed === undefined ? null : bool(head.passed),
      },
      assessment: {
        id: String(head.assessment_id),
        code: String(head.code),
        title: String(head.title),
        passPercentage: num(head.pass_percentage),
      },
      learner: {
        id: String(head.subject_user_id),
        displayName: String(head.display_name),
        email: String(head.email),
      },
      items,
      // The same "what is still outstanding" test gradeAssessmentResponse uses
      // to decide whether to finalize, so the count the marker reads is the
      // count the server will act on rather than a second opinion.
      awaitingMarking: items.filter((item) => item.required && item.finalScore === null).length,
      provisionalPoints: items.reduce((total, item) => total + (item.finalScore ?? 0), 0),
      totalPoints: items.reduce((total, item) => total + item.maxPoints, 0),
    };
  });
}
