import "server-only";

/**
 * Assessment authoring: everything an author does to an assessment AFTER it
 * exists, plus the readiness rules that decide whether it may be published.
 *
 * Before this module, `assessment_items` could only be appended to. Its
 * `position`, `points_override` and `required` columns were read by six queries
 * and written by none, so every item was permanently required, at the
 * question's own points, in the order it happened to be attached. An author
 * could not see what was on an assessment, could not remove a question they had
 * added by mistake, and could not correct any field of the assessment itself
 * once created — the create form was the only chance to get it right.
 */

import type { Assessment, QuestionBank, QuestionType } from "../domain";
import type { Principal } from "../auth";
import { conflict, forbidden, notFound, outOfRange } from "../errors";
import type { PoolClient } from "../db/driver";
import {
  appendAssessmentAudit, bool, canAuthorAssessments, iso, isoOrNull, num, numOrNull,
  readTx, scopePaths, writeTx,
} from "./runtime";

function requireAuthor(principal: Principal): void {
  if (!canAuthorAssessments(principal)) throw forbidden("Assessment authoring permission required");
}

/** One question as it sits on an assessment, with the item-level overrides. */
export type AssessmentItemDetail = {
  questionId: string;
  bankId: string;
  bankCode: string;
  position: number;
  questionType: QuestionType;
  prompt: string;
  /** The question's own points. */
  questionPoints: number;
  /** The override, when the author has set one. */
  pointsOverride: number | null;
  /** What this item is actually worth: the override if set, else the question's points. */
  effectivePoints: number;
  required: boolean;
  reviewStatus: "draft" | "approved" | "rejected";
  origin: "manual" | "ai" | "import";
  /** True for question types no human has to mark. */
  autoScored: boolean;
};

/**
 * Why an assessment may not be published yet.
 *
 * Returned as a list rather than thrown one at a time, so an author fixes
 * everything in one pass instead of discovering the next problem after each
 * attempt.
 */
export type PublishBlocker = {
  code:
    | "no_questions"
    | "unapproved_questions"
    | "no_points"
    | "exam_needs_duration"
    | "window_inverted"
    | "not_draft";
  message: string;
};

export type AssessmentDetail = {
  assessment: Assessment;
  items: AssessmentItemDetail[];
  totalPoints: number;
  requiredPoints: number;
  /** Items a human must mark. Publishing one of these with no grader in scope is a warning, not a blocker. */
  manuallyMarkedItems: number;
  attemptCount: number;
  pendingMarking: number;
  publishBlockers: PublishBlocker[];
};

/** The one list of question types the scoring kernel decides without a human. */
const AUTO_SCORED: ReadonlySet<string> = new Set([
  "single_choice", "multiple_choice", "true_false", "short_text", "numeric", "matching", "ordering",
]);

const ITEM_SELECT = `
  SELECT i.question_id, i.position, i.points_override::float8 AS points_override, i.required,
         q.bank_id, q.question_type, q.prompt, q.points::float8 AS question_points,
         q.review_status, q.origin, b.code AS bank_code
    FROM osa.assessment_items i
    JOIN osa.assessment_questions q ON q.tenant_id = i.tenant_id AND q.id = i.question_id
    JOIN osa.question_banks b ON b.tenant_id = q.tenant_id AND b.id = q.bank_id
   WHERE i.assessment_id = $1::uuid
   ORDER BY i.position`;

function toItem(row: Record<string, unknown>): AssessmentItemDetail {
  const questionPoints = num(row.question_points);
  const pointsOverride = numOrNull(row.points_override);
  const questionType = String(row.question_type) as QuestionType;
  return {
    questionId: String(row.question_id),
    bankId: String(row.bank_id),
    bankCode: String(row.bank_code),
    position: num(row.position),
    questionType,
    prompt: String(row.prompt),
    questionPoints,
    pointsOverride,
    effectivePoints: pointsOverride ?? questionPoints,
    required: bool(row.required),
    reviewStatus: String(row.review_status) as AssessmentItemDetail["reviewStatus"],
    origin: String(row.origin) as AssessmentItemDetail["origin"],
    autoScored: AUTO_SCORED.has(questionType),
  };
}

function toAssessment(row: Record<string, unknown>): Assessment {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), orgUnitId: String(row.org_unit_id),
    courseId: row.course_id ? String(row.course_id) : null, code: String(row.code), title: String(row.title),
    description: String(row.description ?? ""),
    assessmentType: String(row.assessment_type) as Assessment["assessmentType"],
    status: String(row.status) as Assessment["status"],
    durationMinutes: numOrNull(row.duration_minutes),
    passPercentage: num(row.pass_percentage), attemptLimit: num(row.attempt_limit),
    shuffleQuestions: bool(row.shuffle_questions), shuffleOptions: bool(row.shuffle_options),
    feedbackMode: String(row.feedback_mode) as Assessment["feedbackMode"],
    opensAt: isoOrNull(row.opens_at), closesAt: isoOrNull(row.closes_at),
    createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

/**
 * Loads the assessment, asserting the caller administers the organization that
 * owns it. Every mutation in this module goes through it, so the scope check
 * exists once rather than at each call site.
 */
async function loadOwnedAssessment(
  client: PoolClient, principal: Principal, assessmentId: string,
): Promise<Record<string, unknown>> {
  const { roots } = scopePaths(principal);
  const { rows } = await client.query(
    `SELECT a.* FROM osa.assessments a
       JOIN osa.org_units ou ON ou.tenant_id = a.tenant_id AND ou.id = a.org_unit_id
      WHERE a.id = $1::uuid AND ou.path <@ ANY($2::ltree[])`,
    [assessmentId, roots],
  );
  if (!rows[0]) throw notFound("Assessment not found in your scope");
  return rows[0];
}

function requireDraft(row: Record<string, unknown>): void {
  if (String(row.status) !== "draft") {
    // A published assessment may have live attempts against it. Changing its
    // questions, its points or its pass mark underneath those attempts would
    // silently rescore work already submitted.
    throw conflict("Only a draft assessment can be edited. Return it to draft first.");
  }
}

function publishBlockers(
  assessment: Assessment, items: AssessmentItemDetail[], totalPoints: number,
): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (assessment.status !== "draft") {
    blockers.push({ code: "not_draft", message: `This assessment is ${assessment.status}, not a draft.` });
  }
  if (items.length === 0) {
    blockers.push({ code: "no_questions", message: "Add at least one question before publishing." });
  }
  const unapproved = items.filter((item) => item.reviewStatus !== "approved");
  if (unapproved.length > 0) {
    blockers.push({
      code: "unapproved_questions",
      message: `${unapproved.length} question${unapproved.length === 1 ? "" : "s"} still need${unapproved.length === 1 ? "s" : ""} review approval.`,
    });
  }
  if (items.length > 0 && totalPoints <= 0) {
    // percentage() divides by the maximum. A zero-point assessment would score
    // every learner 0% and pass nobody, which is not a state to publish into.
    blockers.push({ code: "no_points", message: "The assessment is worth zero points, so no learner could ever pass it." });
  }
  if (assessment.assessmentType === "exam" && assessment.durationMinutes === null) {
    blockers.push({ code: "exam_needs_duration", message: "An exam needs a time limit. Set one, or make this a quiz." });
  }
  if (assessment.opensAt && assessment.closesAt && Date.parse(assessment.closesAt) <= Date.parse(assessment.opensAt)) {
    blockers.push({ code: "window_inverted", message: "The closing time must be after the opening time." });
  }
  return blockers;
}

/**
 * The authoring view of one assessment: its questions in order, what each is
 * worth, and exactly what stands between it and publication.
 */
export async function assessmentDetail(principal: Principal, assessmentId: string): Promise<AssessmentDetail> {
  requireAuthor(principal);
  return readTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    const assessment = toAssessment(row);
    const { rows: itemRows } = await client.query(ITEM_SELECT, [assessmentId]);
    const items = itemRows.map(toItem);
    const totalPoints = items.reduce((sum, item) => sum + item.effectivePoints, 0);
    const requiredPoints = items.filter((item) => item.required).reduce((sum, item) => sum + item.effectivePoints, 0);

    const { rows: counts } = await client.query(
      `SELECT count(*) FILTER (WHERE x.status <> 'void')::int AS attempts,
              count(*) FILTER (WHERE x.status = 'submitted')::int AS pending
         FROM osa.assessment_attempts x WHERE x.assessment_id = $1::uuid`,
      [assessmentId],
    );

    return {
      assessment,
      items,
      totalPoints: Math.round(totalPoints * 100) / 100,
      requiredPoints: Math.round(requiredPoints * 100) / 100,
      manuallyMarkedItems: items.filter((item) => !item.autoScored).length,
      attemptCount: num(counts[0]?.attempts ?? 0),
      pendingMarking: num(counts[0]?.pending ?? 0),
      publishBlockers: publishBlockers(assessment, items, totalPoints),
    };
  });
}

/**
 * Removes a question from a draft assessment and closes the gap in `position`.
 *
 * `assessment_items` has UNIQUE (tenant_id, assessment_id, position), so
 * leaving a hole would be tolerable but renumbering keeps `position` meaning
 * "nth question" — which is what both the player's navigation and the marking
 * queue's ordering assume.
 */
export async function detachQuestion(
  principal: Principal, assessmentId: string, questionId: string, requestId: string,
): Promise<void> {
  requireAuthor(principal);
  await writeTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    requireDraft(row);
    const removed = await client.query(
      "DELETE FROM osa.assessment_items WHERE assessment_id = $1::uuid AND question_id = $2::uuid RETURNING position",
      [assessmentId, questionId],
    );
    if (!removed.rowCount) throw notFound("That question is not on this assessment");
    await client.query(
      "UPDATE osa.assessment_items SET position = position - 1 WHERE assessment_id = $1::uuid AND position > $2",
      [assessmentId, num(removed.rows[0].position)],
    );
    await appendAssessmentAudit(client, principal, requestId, "assessment.item.detach", "assessment", assessmentId, { questionId });
  });
}

/**
 * Puts the questions of a draft assessment into the given order.
 *
 * The caller must send EVERY question currently on the assessment exactly once.
 * A partial list is rejected rather than applied, because a reorder that
 * silently drops or duplicates an item is worse than one that refuses.
 */
export async function reorderQuestions(
  principal: Principal, assessmentId: string, questionIds: readonly string[], requestId: string,
): Promise<void> {
  requireAuthor(principal);
  await writeTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    requireDraft(row);
    const { rows: existing } = await client.query<{ question_id: string }>(
      "SELECT question_id::text FROM osa.assessment_items WHERE assessment_id = $1::uuid",
      [assessmentId],
    );
    const current = new Set(existing.map((item) => item.question_id));
    const requested = new Set(questionIds);
    if (requested.size !== questionIds.length) throw conflict("The new order lists the same question more than once");
    if (requested.size !== current.size || [...requested].some((questionId) => !current.has(questionId))) {
      throw conflict("The new order must list every question on this assessment exactly once");
    }

    // Two passes. UNIQUE (tenant_id, assessment_id, position) means writing the
    // final positions directly collides the moment two items swap, so move them
    // out of the way first. Negative positions violate the CHECK (position > 0),
    // so the parking range is above the highest live position instead.
    const parkFrom = current.size + 1;
    for (const [index, questionId] of questionIds.entries()) {
      await client.query(
        "UPDATE osa.assessment_items SET position = $3 WHERE assessment_id = $1::uuid AND question_id = $2::uuid",
        [assessmentId, questionId, parkFrom + index],
      );
    }
    for (const [index, questionId] of questionIds.entries()) {
      await client.query(
        "UPDATE osa.assessment_items SET position = $3 WHERE assessment_id = $1::uuid AND question_id = $2::uuid",
        [assessmentId, questionId, index + 1],
      );
    }
    await appendAssessmentAudit(client, principal, requestId, "assessment.item.reorder", "assessment", assessmentId, { questions: questionIds.length });
  });
}

export type ItemSettings = {
  /** null clears the override, so the item is worth the question's own points again. */
  pointsOverride?: number | null;
  required?: boolean;
};

/**
 * Sets what one item is worth on this assessment, and whether it must be
 * answered. Both columns existed and were read everywhere; nothing wrote them.
 */
export async function setItemSettings(
  principal: Principal, assessmentId: string, questionId: string, settings: ItemSettings, requestId: string,
): Promise<void> {
  requireAuthor(principal);
  if (settings.pointsOverride !== undefined && settings.pointsOverride !== null) {
    // The column is numeric(8,2) CHECK (> 0). Rejecting here gives the author
    // the reason instead of a constraint-violation 500.
    if (!Number.isFinite(settings.pointsOverride) || settings.pointsOverride <= 0 || settings.pointsOverride > 999999) {
      throw outOfRange("Point override must be greater than 0 and no more than 999999");
    }
  }
  await writeTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    requireDraft(row);
    const updated = await client.query(
      `UPDATE osa.assessment_items
          SET points_override = CASE WHEN $3::boolean THEN $4::numeric ELSE points_override END,
              required        = CASE WHEN $5::boolean THEN $6::boolean ELSE required END
        WHERE assessment_id = $1::uuid AND question_id = $2::uuid`,
      [
        assessmentId, questionId,
        settings.pointsOverride !== undefined,
        settings.pointsOverride === undefined ? null : settings.pointsOverride,
        settings.required !== undefined,
        settings.required ?? null,
      ],
    );
    if (!updated.rowCount) throw notFound("That question is not on this assessment");
    await appendAssessmentAudit(client, principal, requestId, "assessment.item.update", "assessment", assessmentId, {
      questionId,
      pointsOverride: settings.pointsOverride ?? null,
      required: settings.required ?? null,
    });
  });
}

export type AssessmentSettings = {
  title?: string;
  description?: string;
  assessmentType?: Assessment["assessmentType"];
  durationMinutes?: number | null;
  passPercentage?: number;
  attemptLimit?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  feedbackMode?: Assessment["feedbackMode"];
  opensAt?: string | null;
  closesAt?: string | null;
};

/**
 * Corrects an assessment's own fields while it is a draft.
 *
 * Nothing could edit an assessment after creation: a typo in the title, a wrong
 * pass mark or a missing time limit meant creating a second assessment and
 * abandoning the first. The `code` is deliberately NOT editable — it is the
 * stable business identifier a course or a report refers to.
 */
export async function updateAssessmentSettings(
  principal: Principal, assessmentId: string, settings: AssessmentSettings, requestId: string,
): Promise<Assessment> {
  requireAuthor(principal);
  return writeTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    requireDraft(row);

    const merged = {
      title: settings.title ?? String(row.title),
      description: settings.description ?? String(row.description ?? ""),
      assessment_type: settings.assessmentType ?? String(row.assessment_type),
      duration_minutes: settings.durationMinutes !== undefined ? settings.durationMinutes : numOrNull(row.duration_minutes),
      pass_percentage: settings.passPercentage ?? num(row.pass_percentage),
      attempt_limit: settings.attemptLimit ?? num(row.attempt_limit),
      shuffle_questions: settings.shuffleQuestions ?? bool(row.shuffle_questions),
      shuffle_options: settings.shuffleOptions ?? bool(row.shuffle_options),
      feedback_mode: settings.feedbackMode ?? String(row.feedback_mode),
      opens_at: settings.opensAt !== undefined ? settings.opensAt : isoOrNull(row.opens_at),
      closes_at: settings.closesAt !== undefined ? settings.closesAt : isoOrNull(row.closes_at),
    };

    if (merged.opens_at && merged.closes_at && Date.parse(merged.closes_at) <= Date.parse(merged.opens_at)) {
      throw outOfRange("The closing time must be after the opening time");
    }

    const { rows: updated } = await client.query(
      `UPDATE osa.assessments
          SET title=$2, description=$3, assessment_type=$4, duration_minutes=$5::integer,
              pass_percentage=$6::numeric, attempt_limit=$7::integer,
              shuffle_questions=$8::boolean, shuffle_options=$9::boolean, feedback_mode=$10,
              opens_at=$11::timestamptz, closes_at=$12::timestamptz, updated_at=now()
        WHERE id=$1::uuid
        RETURNING *`,
      [
        assessmentId, merged.title, merged.description, merged.assessment_type, merged.duration_minutes,
        merged.pass_percentage, merged.attempt_limit, merged.shuffle_questions, merged.shuffle_options,
        merged.feedback_mode, merged.opens_at, merged.closes_at,
      ],
    );
    await appendAssessmentAudit(client, principal, requestId, "assessment.update", "assessment", assessmentId, {
      title: merged.title, passPercentage: merged.pass_percentage, attemptLimit: merged.attempt_limit,
    });
    return toAssessment(updated[0]);
  });
}

/**
 * Returns a published assessment to draft, or retires it.
 *
 * Unpublishing is refused while any attempt is live: a learner mid-exam would
 * have the assessment disappear from under them. Retiring is allowed with
 * attempts in history — that is what retirement is for — but not while one is
 * in progress, for the same reason.
 */
export async function setAssessmentLifecycle(
  principal: Principal, assessmentId: string, target: "draft" | "retired", requestId: string,
): Promise<Assessment> {
  requireAuthor(principal);
  return writeTx(principal, async (client) => {
    const row = await loadOwnedAssessment(client, principal, assessmentId);
    const current = String(row.status);
    if (current === target) throw conflict(`This assessment is already ${target}`);
    if (target === "draft" && current !== "published") throw conflict("Only a published assessment can be returned to draft");

    const { rows: live } = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM osa.assessment_attempts WHERE assessment_id = $1::uuid AND status = 'in_progress'",
      [assessmentId],
    );
    if (num(live[0].count) > 0) {
      throw conflict(`${live[0].count} learner attempt${num(live[0].count) === 1 ? " is" : "s are"} still in progress. Wait for them to finish or expire.`);
    }
    if (target === "draft") {
      const { rows: submitted } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM osa.assessment_attempts WHERE assessment_id = $1::uuid AND status <> 'void'",
        [assessmentId],
      );
      if (num(submitted[0].count) > 0) {
        // Editing the questions or the pass mark under a submitted attempt
        // would rescore work already done. Retire it and publish a new version.
        throw conflict("Learners have already attempted this assessment, so it cannot be edited. Retire it and publish a new version instead.");
      }
    }

    const { rows: updated } = await client.query(
      "UPDATE osa.assessments SET status=$2, updated_at=now() WHERE id=$1::uuid RETURNING *",
      [assessmentId, target],
    );
    await appendAssessmentAudit(client, principal, requestId, `assessment.${target === "draft" ? "unpublish" : "retire"}`, "assessment", assessmentId, { from: current });
    return toAssessment(updated[0]);
  });
}

/* ---------------------------------------------------------------------------
 * Question and bank lifecycle.
 * ------------------------------------------------------------------------- */

/**
 * Approves or rejects a question.
 *
 * This is the review gate the publish rule already depends on and nothing could
 * operate: the authoring UI hardcoded `reviewStatus: "approved"`, so the
 * "every question must be approved" check could never fire, and the
 * `origin: "ai" → forced draft` rule left an AI-generated question with no way
 * to ever be approved. Human approval before publication is the whole point of
 * that rule.
 */
export async function reviewQuestion(
  principal: Principal, questionId: string, reviewStatus: "approved" | "rejected", requestId: string,
): Promise<void> {
  requireAuthor(principal);
  await writeTx(principal, async (client) => {
    const { roots } = scopePaths(principal);
    const { rows } = await client.query(
      `SELECT q.id, q.review_status, q.origin
         FROM osa.assessment_questions q
         JOIN osa.question_banks b ON b.tenant_id = q.tenant_id AND b.id = q.bank_id
         JOIN osa.org_units ou ON ou.tenant_id = b.tenant_id AND ou.id = b.org_unit_id
        WHERE q.id = $1::uuid AND ou.path <@ ANY($2::ltree[])
        FOR UPDATE OF q`,
      [questionId, roots],
    );
    if (!rows[0]) throw notFound("Question not found in your scope");
    if (String(rows[0].review_status) === reviewStatus) throw conflict(`This question is already ${reviewStatus}`);

    await client.query(
      "UPDATE osa.assessment_questions SET review_status=$2, updated_at=now() WHERE id=$1::uuid",
      [questionId, reviewStatus],
    );
    await appendAssessmentAudit(client, principal, requestId, `assessment.question.${reviewStatus}`, "assessment_question", questionId, {
      from: String(rows[0].review_status),
      // Recorded because an AI-generated question that a human approved is a
      // materially different artifact from one a human wrote, and the ledger is
      // where that distinction has to survive.
      origin: String(rows[0].origin),
    });
  });
}

/**
 * Retires or reactivates a question bank.
 *
 * `createAssessmentQuestion` already refuses to add to a retired bank, so the
 * guard existed but nothing could ever set the status it guarded against.
 */
export async function setBankStatus(
  principal: Principal, bankId: string, status: "active" | "retired", requestId: string,
): Promise<QuestionBank> {
  requireAuthor(principal);
  return writeTx(principal, async (client) => {
    const { roots } = scopePaths(principal);
    const { rows } = await client.query(
      `SELECT b.* FROM osa.question_banks b
         JOIN osa.org_units ou ON ou.tenant_id = b.tenant_id AND ou.id = b.org_unit_id
        WHERE b.id = $1::uuid AND ou.path <@ ANY($2::ltree[]) FOR UPDATE OF b`,
      [bankId, roots],
    );
    if (!rows[0]) throw notFound("Question bank not found in your scope");
    if (String(rows[0].status) === status) throw conflict(`This bank is already ${status}`);

    const { rows: updated } = await client.query(
      "UPDATE osa.question_banks SET status=$2, updated_at=now() WHERE id=$1::uuid RETURNING *",
      [bankId, status],
    );
    const row = updated[0];
    await appendAssessmentAudit(client, principal, requestId, `assessment.bank.${status}`, "question_bank", bankId, { from: String(rows[0].status) });
    return {
      id: String(row.id), tenantId: String(row.tenant_id), orgUnitId: String(row.org_unit_id),
      code: String(row.code), name: String(row.name), description: String(row.description ?? ""),
      status: String(row.status) as QuestionBank["status"], createdBy: String(row.created_by),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  });
}
