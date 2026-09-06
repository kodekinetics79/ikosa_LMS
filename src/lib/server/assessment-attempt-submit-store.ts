import "server-only";

import type { Principal } from "./auth";
import type { AssessmentAttempt, AssessmentQuestion, BloomLevel, QuestionType } from "./domain";
import { percentage, scoreObjectiveQuestion } from "./assessment-scoring";
import { scopeForPrincipal } from "./tenant-runtime";
import { signAuditEvent } from "./db/audit-chain";
import { assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction, type Pool, type PoolClient } from "./db/driver";
import * as map from "./db/mapping";
import { conflict, forbidden, notFound } from "./errors";
import { recordAssessmentCourseProgress } from "./assessment/course-completion";

let poolPromise: Promise<Pool> | null = null;

async function pool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for assessment submission");
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await loadPgModule();
      if (!pg) throw new Error("PostgreSQL driver is unavailable");
      const value = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
      assertRuntimeRoleIsSafe(await inspectRuntimeRole(value));
      return value;
    })();
  }
  return poolPromise;
}

const num = (value: unknown) => typeof value === "number" ? value : Number(value);
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const isoOrNull = (value: unknown) => value === null || value === undefined ? null : iso(value);
const bool = (value: unknown) => value === true || value === "true" || value === "t";

function toAttempt(row: Record<string, unknown>): AssessmentAttempt {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), assessmentId: String(row.assessment_id),
    subjectUserId: String(row.subject_user_id), attemptNumber: num(row.attempt_number),
    status: String(row.status) as AssessmentAttempt["status"], startedAt: iso(row.started_at),
    submittedAt: isoOrNull(row.submitted_at), gradedAt: isoOrNull(row.graded_at),
    scorePoints: row.score_points === null ? null : num(row.score_points),
    maxPoints: row.max_points === null ? null : num(row.max_points),
    percentage: row.percentage === null ? null : num(row.percentage),
    passed: row.passed === null ? null : bool(row.passed),
    graderUserId: row.grader_user_id ? String(row.grader_user_id) : null,
    createdAt: iso(row.created_at),
  };
}

function toScoringQuestion(row: Record<string, unknown>): AssessmentQuestion {
  return {
    id: String(row.question_id), tenantId: String(row.tenant_id), bankId: String(row.bank_id),
    questionType: String(row.question_type) as QuestionType, prompt: String(row.prompt), options: row.options,
    answerKey: row.answer_key, rationale: String(row.rationale ?? ""), points: num(row.question_points),
    difficulty: num(row.difficulty), bloomLevel: String(row.bloom_level) as BloomLevel,
    skillId: row.skill_id ? String(row.skill_id) : null, rubricId: row.rubric_id ? String(row.rubric_id) : null,
    origin: String(row.origin) as AssessmentQuestion["origin"], reviewStatus: String(row.review_status) as AssessmentQuestion["reviewStatus"],
    version: num(row.version), createdBy: String(row.created_by), createdAt: iso(row.question_created_at), updatedAt: iso(row.question_updated_at),
  };
}

async function appendAudit(client: PoolClient, principal: Principal, requestId: string, attemptId: string, assessmentId: string, earned: number, max: number, manualRequired: boolean, afterDeadline: boolean): Promise<void> {
  const scope = scopeForPrincipal(principal);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`osa.audit:${scope.tenantId}`]);
  const { rows } = await client.query(`SELECT a.id,a.tenant_id,a.actor_user_id,a.action,a.resource_type,a.resource_id,a.outcome,a.occurred_at,a.request_id,a.metadata,a.previous_hash,a.event_hash FROM osa.audit_events a ORDER BY a.sequence DESC LIMIT 1`);
  const event = signAuditEvent(rows[0] ? map.toAuditEvent(rows[0]) : null, {
    tenantId: scope.tenantId,
    actorUserId: scope.userId,
    action: "assessment.attempt.submit",
    resourceType: "assessment_attempt",
    resourceId: attemptId,
    outcome: "success",
    requestId,
    // `afterDeadline` records that the required-question gate was waived, so a
    // submission with blanks is explainable from the ledger alone.
    metadata: { assessmentId, manualRequired, objectiveScore: earned, maxPoints: max, afterDeadline },
  });
  await client.query(
    `INSERT INTO osa.audit_events (id,tenant_id,actor_user_id,action,resource_type,resource_id,outcome,request_id,metadata,occurred_at,previous_hash,event_hash)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::jsonb,$10::timestamptz,$11,$12)`,
    [event.id,event.tenantId,event.actorUserId,event.action,event.resourceType,event.resourceId,event.outcome,event.requestId,JSON.stringify(event.metadata),event.occurredAt,map.hashToBytes(event.previousHash),map.hashToBytes(event.hash)],
  );
}

/**
 * Finalizes one learner attempt. Objective scoring and attempt state update are
 * one transaction. Subjective questions stay unscored and keep the attempt in
 * `submitted` until an authorized human marker decides them.
 */
export async function submitAssessmentAttemptSafely(
  principal: Principal,
  attemptId: string,
  requestId: string,
): Promise<AssessmentAttempt> {
  if (!principal.roles.includes("learner")) throw forbidden("Learner permission required");
  const scope = scopeForPrincipal(principal);

  return withTenantTransaction(await pool(), scope, async (client) => {
    const attemptRows = await client.query(
      // The deadline is computed by the DATABASE, from the stored start time and
      // the stored duration, against the database clock. The player's countdown
      // is a convenience; it is not evidence of anything. `least(...)` ignores
      // nulls, so an untimed assessment inside an open window has no deadline,
      // and an assessment with both a duration and a closing time is bounded by
      // whichever arrives first.
      `SELECT x.*, a.pass_percentage::float8 AS pass_percentage,
              least(
                CASE WHEN a.duration_minutes IS NULL THEN NULL
                     ELSE x.started_at + make_interval(mins => a.duration_minutes) END,
                a.closes_at
              ) AS deadline_at,
              now() AS server_now
         FROM osa.assessment_attempts x
         JOIN osa.assessments a ON a.tenant_id=x.tenant_id AND a.id=x.assessment_id
        WHERE x.id=$1::uuid AND x.subject_user_id=$2::uuid AND x.status='in_progress'
        FOR UPDATE OF x`,
      [attemptId, scope.userId],
    );
    const attemptRow = attemptRows.rows[0];
    if (!attemptRow) throw notFound("Active attempt not found");
    const attempt = toAttempt(attemptRow);

    const { rows: items } = await client.query(
      `SELECT i.question_id, i.required,
              coalesce(i.points_override,q.points)::float8 AS item_points,
              q.tenant_id,q.bank_id,q.question_type,q.prompt,q.options,q.answer_key,q.rationale,
              q.points::float8 AS question_points,q.difficulty,q.bloom_level,q.skill_id,q.rubric_id,
              q.origin,q.review_status,q.version,q.created_by,
              q.created_at AS question_created_at,q.updated_at AS question_updated_at
         FROM osa.assessment_items i
         JOIN osa.assessment_questions q ON q.tenant_id=i.tenant_id AND q.id=i.question_id
        WHERE i.assessment_id=$1::uuid
        ORDER BY i.position`,
      [attempt.assessmentId],
    );
    if (!items.length) throw conflict("Assessment has no questions");

    const responseRows = await client.query<{ id: string; question_id: string; response: unknown }>(
      "SELECT id::text,question_id::text,response FROM osa.assessment_responses WHERE attempt_id=$1::uuid",
      [attemptId],
    );
    const byQuestion = new Map(responseRows.rows.map((row) => [row.question_id, row]));
    // Has the window closed, according to the database?
    const deadlineAt = attemptRow.deadline_at ? new Date(attemptRow.deadline_at as string | Date) : null;
    const serverNow = new Date(attemptRow.server_now as string | Date);
    const expired = deadlineAt !== null && deadlineAt.getTime() <= serverNow.getTime();

    const missing = items.filter((item) => bool(item.required) && !byQuestion.has(String(item.question_id)));
    if (missing.length && !expired) {
      throw conflict(`${missing.length} required question${missing.length === 1 ? " is" : "s are"} unanswered`);
    }
    // Past the deadline the gate must NOT apply. `saveTimedAssessmentResponse`
    // already refuses every write once the window has closed, so an expired
    // attempt with a blank required question cannot be completed by any means:
    // refusing the submission too left the attempt `in_progress` forever, and
    // migration 006's partial unique index then made it impossible to start
    // another attempt at that assessment. Blocking a learner out of their own
    // exam is a worse outcome than grading a blank as a blank.

    let earned = 0;
    let max = 0;
    let manualRequired = false;

    for (const item of items) {
      const itemPoints = num(item.item_points);
      max += itemPoints;
      const response = byQuestion.get(String(item.question_id));
      if (!response) continue;

      const scored = scoreObjectiveQuestion(toScoringQuestion(item), response.response, itemPoints);
      if (scored.manualRequired) {
        manualRequired = true;
        continue;
      }
      const score = scored.score ?? 0;
      earned += score;
      await client.query(
        "UPDATE osa.assessment_responses SET auto_score=$2,final_score=$2,graded_at=now() WHERE id=$1::uuid",
        [response.id, score],
      );
    }

    const pct = percentage(earned, max);
    const fullyGraded = !manualRequired;
    const { rows: updated } = await client.query(
      // Every parameter is cast explicitly. Inside a CASE with a NULL branch
      // PostgreSQL cannot infer a parameter's type from the target column, so
      // an uncast $6 arrived as `unknown` and resolved to text — every submit of
      // an all-objective assessment failed with
      // `column "percentage" is of type numeric but expression is of type text`.
      // The path that worked was the one where the CASE was never taken.
      `UPDATE osa.assessment_attempts
          SET status=$2,
              submitted_at=now(),
              graded_at=CASE WHEN $3::boolean THEN now() ELSE NULL END,
              score_points=$4::numeric,
              max_points=$5::numeric,
              percentage=CASE WHEN $3::boolean THEN $6::numeric ELSE NULL END,
              passed=CASE WHEN $3::boolean THEN $6::numeric >= $7::numeric ELSE NULL END
        WHERE id=$1::uuid
        RETURNING *`,
      [attemptId, fullyGraded ? "graded" : "submitted", fullyGraded, earned, max, pct, num(attemptRow.pass_percentage)],
    );

    await appendAudit(client, principal, requestId, attemptId, attempt.assessmentId, earned, max, manualRequired, expired);

    // An attempt that still needs a human marker has no final result yet, so
    // there is nothing for a course to act on; the marking path calls this
    // instead when it finalizes. In the same transaction either way, so a
    // graded pass and the completion it causes commit together.
    if (fullyGraded) {
      await recordAssessmentCourseProgress(client, principal, {
        assessmentId: attempt.assessmentId,
        subjectUserId: scope.userId,
        percentage: pct,
        requestId,
        attemptId,
      });
    }

    return toAttempt(updated[0]);
  });
}
