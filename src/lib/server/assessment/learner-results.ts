import "server-only";

/**
 * What a learner is allowed to see about their own attempts, and when.
 *
 * Two problems this closes.
 *
 * 1. A learner could not read back ANY attempt. There was no
 *    `GET /api/assessment-attempts`, so once the player's result screen was
 *    navigated away from, the score was unreachable: a submitted essay that a
 *    marker later graded produced a result the learner could never see.
 *
 * 2. `feedback_mode` was transported to the player and never read. An
 *    `immediate` assessment and an `after_close` one gave the learner the
 *    identical (empty) treatment, so the setting was decorative in both
 *    directions — nothing was revealed early, and nothing was revealed late
 *    either.
 *
 * THE DISCLOSURE RULE, IN ONE PLACE
 *
 * Answer keys, rationales and grading notes are never disclosed by anything in
 * this module. What the feedback mode governs is narrower and is the whole of
 * it: per-question marks and the marker's written feedback.
 *
 *   immediate     as soon as the item has a final score
 *   after_submit  once the learner has submitted the attempt
 *   after_close   only once the assessment's closing time has passed, so a
 *                 learner who finishes early cannot brief one who has not
 *                 started; with no closing time this behaves as after_submit,
 *                 because a mode that could never disclose is a mode that
 *                 silently withholds a mark for ever.
 *
 * The overall score is deliberately NOT gated by the mode. A learner is always
 * entitled to know whether they passed; the mode is about seeing the marking of
 * individual questions.
 */

import type { Principal } from "../auth";
import type { Assessment, AssessmentAttempt, QuestionType } from "../domain";
import { forbidden, notFound } from "../errors";
import { releaseDecision } from "./feedback-policy";
import {
  bool, canAttemptAssessments, iso, isoOrNull, num, numOrNull, readTx, scopePaths,
} from "./runtime";

export type LearnerResponseResult = {
  questionId: string;
  position: number;
  questionType: QuestionType;
  prompt: string;
  /** The learner's own answer. Always theirs to see. */
  response: unknown;
  maxPoints: number;
  required: boolean;
  /** null while withheld by the feedback policy, or while genuinely unmarked. */
  score: number | null;
  /** The marker's written comment, under the same policy as the score. */
  feedback: string | null;
  /** True when the mark exists but the policy is not yet releasing it. */
  markWithheld: boolean;
};

export type LearnerAttemptResult = {
  attempt: AssessmentAttempt;
  assessment: Pick<Assessment, "id" | "code" | "title" | "assessmentType" | "passPercentage" | "feedbackMode" | "closesAt">;
  responses: LearnerResponseResult[];
  /** Why per-question marks are or are not shown, so the UI can say so plainly. */
  feedbackReleased: boolean;
  feedbackReleaseReason: "released" | "awaiting_submission" | "awaiting_marking" | "awaiting_close";
  /** Items still with a human marker. */
  awaitingMarking: number;
};

function requireLearner(principal: Principal): void {
  if (!canAttemptAssessments(principal)) throw forbidden("Learner permission required");
}

function toAttempt(row: Record<string, unknown>): AssessmentAttempt {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), assessmentId: String(row.assessment_id),
    subjectUserId: String(row.subject_user_id), attemptNumber: num(row.attempt_number),
    status: String(row.status) as AssessmentAttempt["status"],
    startedAt: iso(row.started_at), submittedAt: isoOrNull(row.submitted_at), gradedAt: isoOrNull(row.graded_at),
    scorePoints: numOrNull(row.score_points), maxPoints: numOrNull(row.max_points),
    percentage: numOrNull(row.percentage), passed: row.passed === null || row.passed === undefined ? null : bool(row.passed),
    graderUserId: row.grader_user_id ? String(row.grader_user_id) : null, createdAt: iso(row.created_at),
  };
}

const ATTEMPT_SELECT = `
  SELECT x.*, a.code, a.title, a.assessment_type, a.pass_percentage::float8 AS pass_percentage,
         a.feedback_mode, a.closes_at, now() AS server_now
    FROM osa.assessment_attempts x
    JOIN osa.assessments a ON a.tenant_id = x.tenant_id AND a.id = x.assessment_id
    JOIN osa.org_units ou ON ou.tenant_id = a.tenant_id AND ou.id = a.org_unit_id
   WHERE x.subject_user_id = $1::uuid AND ou.path @> $2::ltree`;

/** One row per attempt for a learner's own history. No per-question detail. */
export type LearnerAttemptSummary = {
  attempt: AssessmentAttempt;
  assessmentCode: string;
  assessmentTitle: string;
  passPercentage: number;
  /** Items this learner answered that a human has not marked yet. */
  awaitingMarking: number;
};

/** Every attempt this learner has made, newest first. Theirs only, by SQL predicate. */
export async function listMyAttempts(principal: Principal): Promise<LearnerAttemptSummary[]> {
  requireLearner(principal);
  return readTx(principal, async (client) => {
    const { viewer } = scopePaths(principal);
    const { rows } = await client.query(
      `${ATTEMPT_SELECT} AND x.status <> 'void'
         ORDER BY x.started_at DESC LIMIT 200`,
      [principal.user.id, viewer],
    );
    if (rows.length === 0) return [];
    const { rows: pending } = await client.query<{ attempt_id: string; count: number }>(
      `SELECT r.attempt_id::text, count(*)::int AS count
         FROM osa.assessment_responses r
        WHERE r.attempt_id = ANY($1::uuid[]) AND r.final_score IS NULL
        GROUP BY r.attempt_id`,
      [rows.map((row) => String(row.id))],
    );
    const pendingByAttempt = new Map(pending.map((row) => [row.attempt_id, num(row.count)]));
    return rows.map((row) => ({
      attempt: toAttempt(row),
      assessmentCode: String(row.code),
      assessmentTitle: String(row.title),
      passPercentage: num(row.pass_percentage),
      awaitingMarking: pendingByAttempt.get(String(row.id)) ?? 0,
    }));
  });
}

/**
 * One attempt, with its per-question marking subject to the feedback policy.
 *
 * `subject_user_id = $1` comes from the validated session, never from the
 * request, so a learner asking for someone else's attempt id gets a 404 rather
 * than someone else's script.
 */
export async function myAttemptResult(principal: Principal, attemptId: string): Promise<LearnerAttemptResult> {
  requireLearner(principal);
  return readTx(principal, async (client) => {
    const { viewer } = scopePaths(principal);
    const { rows } = await client.query(
      `${ATTEMPT_SELECT} AND x.id = $3::uuid`,
      [principal.user.id, viewer, attemptId],
    );
    if (!rows[0]) throw notFound("Attempt not found");
    const { rows: items } = await client.query(
      `SELECT i.position, i.required, coalesce(i.points_override, q.points)::float8 AS max_points,
              q.id AS question_id, q.question_type, q.prompt,
              r.response, r.final_score::float8 AS final_score, r.feedback
         FROM osa.assessment_items i
         JOIN osa.assessment_questions q ON q.tenant_id = i.tenant_id AND q.id = i.question_id
         LEFT JOIN osa.assessment_responses r
           ON r.tenant_id = i.tenant_id AND r.attempt_id = $2::uuid AND r.question_id = i.question_id
        WHERE i.assessment_id = $1::uuid
        ORDER BY i.position`,
      [String(rows[0].assessment_id), attemptId],
    );
    // NOTE: q.answer_key and q.rationale are deliberately not selected. The
    // boundary is the select list, so a field cannot leak by being added to a
    // type later.
    return hydrate(rows[0], items);
  });
}

function hydrate(row: Record<string, unknown>, items: Array<Record<string, unknown>>): LearnerAttemptResult {
  const attempt = toAttempt(row);
  const feedbackMode = String(row.feedback_mode) as Assessment["feedbackMode"];
  const closesAt = isoOrNull(row.closes_at);
  const serverNow = new Date(iso(row.server_now));
  const decision = releaseDecision(feedbackMode, attempt.status, closesAt, serverNow);

  const responses: LearnerResponseResult[] = items.map((item) => {
    const score = numOrNull(item.final_score);
    const marked = score !== null;
    return {
      questionId: String(item.question_id),
      position: num(item.position),
      questionType: String(item.question_type) as QuestionType,
      prompt: String(item.prompt),
      response: item.response ?? null,
      maxPoints: num(item.max_points),
      required: bool(item.required),
      score: decision.released && marked ? score : null,
      feedback: decision.released && marked ? String(item.feedback ?? "") : null,
      markWithheld: marked && !decision.released,
    };
  });

  const awaitingMarking = items.filter((item) => item.response !== null && item.response !== undefined && numOrNull(item.final_score) === null).length;
  const reason: LearnerAttemptResult["feedbackReleaseReason"] =
    decision.released && awaitingMarking > 0 && attempt.status === "submitted" ? "awaiting_marking" : decision.reason;

  return {
    attempt,
    assessment: {
      id: attempt.assessmentId, code: String(row.code), title: String(row.title),
      assessmentType: String(row.assessment_type) as Assessment["assessmentType"],
      passPercentage: num(row.pass_percentage), feedbackMode, closesAt,
    },
    responses,
    feedbackReleased: decision.released,
    feedbackReleaseReason: reason,
    awaitingMarking,
  };
}
