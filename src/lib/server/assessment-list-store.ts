import "server-only";

import type { Principal } from "./auth";
import type { Assessment, BloomLevel, QuestionType } from "./domain";
import type { AssessmentSummary } from "./assessment-store";
import { scopeForPrincipal } from "./tenant-runtime";
import { assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction, type Pool } from "./db/driver";
import { pathToLtree, pathsToLtree } from "./db/ids";

export type AuthorQuestionSummary = {
  id: string;
  bankId: string;
  bankName: string;
  questionType: QuestionType;
  prompt: string;
  options: unknown;
  answerKey: unknown;
  rationale: string;
  points: number;
  difficulty: number;
  bloomLevel: BloomLevel;
  origin: "manual" | "ai" | "import";
  reviewStatus: "draft" | "approved" | "rejected";
};

export type MarkingQueueItem = {
  responseId: string;
  attemptId: string;
  assessmentId: string;
  assessmentCode: string;
  assessmentTitle: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  questionId: string;
  questionType: QuestionType;
  prompt: string;
  response: unknown;
  answerKey: unknown;
  rationale: string;
  maxPoints: number;
  submittedAt: string;
};

let poolPromise: Promise<Pool> | null = null;

async function pool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for assessments");
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

function toAssessment(row: Record<string, unknown>): Assessment {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), orgUnitId: String(row.org_unit_id),
    courseId: row.course_id ? String(row.course_id) : null, code: String(row.code), title: String(row.title),
    description: String(row.description ?? ""), assessmentType: String(row.assessment_type) as Assessment["assessmentType"],
    status: String(row.status) as Assessment["status"], durationMinutes: row.duration_minutes === null ? null : num(row.duration_minutes),
    passPercentage: num(row.pass_percentage), attemptLimit: num(row.attempt_limit), shuffleQuestions: bool(row.shuffle_questions),
    shuffleOptions: bool(row.shuffle_options), feedbackMode: String(row.feedback_mode) as Assessment["feedbackMode"],
    opensAt: isoOrNull(row.opens_at), closesAt: isoOrNull(row.closes_at), createdBy: String(row.created_by),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function authorLike(principal: Principal): boolean {
  return principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst" || role === "assessor");
}

export async function listAssessmentWorkspace(principal: Principal): Promise<AssessmentSummary[]> {
  const scope = scopeForPrincipal(principal);
  const authorView = authorLike(principal);
  const db = await pool();

  return withTenantTransaction(db, scope, async (client) => {
    if (authorView) {
      const roots = pathsToLtree(scope.orgScopes);
      const { rows } = await client.query(
        `SELECT a.*,
                (SELECT count(*)::int FROM osa.assessment_items i WHERE i.assessment_id=a.id) AS item_count,
                (SELECT count(*)::int FROM osa.assessment_attempts x WHERE x.assessment_id=a.id) AS attempt_count,
                (SELECT count(*)::int FROM osa.assessment_attempts x WHERE x.assessment_id=a.id AND x.status='submitted') AS pending_marking
           FROM osa.assessments a
           JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
          WHERE ou.path <@ ANY($1::ltree[])
          ORDER BY a.updated_at DESC`,
        [roots],
      );
      return rows.map((row) => ({ ...toAssessment(row), itemCount: num(row.item_count), attemptCount: num(row.attempt_count), pendingMarking: num(row.pending_marking) }));
    }

    const viewer = pathToLtree(scope.viewerOrgPath);
    const { rows } = await client.query(
      `SELECT a.*,
              (SELECT count(*)::int FROM osa.assessment_items i WHERE i.assessment_id=a.id) AS item_count,
              (SELECT count(*)::int FROM osa.assessment_attempts x WHERE x.assessment_id=a.id AND x.subject_user_id=$2::uuid AND x.status<>'void') AS attempt_count,
              0::int AS pending_marking
         FROM osa.assessments a
         JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
        WHERE a.status='published'
          AND ou.path @> $1::ltree
          AND (a.opens_at IS NULL OR a.opens_at<=now())
          AND (a.closes_at IS NULL OR a.closes_at>now())
        ORDER BY a.updated_at DESC`,
      [viewer, scope.userId],
    );
    return rows.map((row) => ({ ...toAssessment(row), itemCount: num(row.item_count), attemptCount: num(row.attempt_count), pendingMarking: 0 }));
  }, { readOnly: true });
}

export async function listAuthorQuestions(principal: Principal): Promise<AuthorQuestionSummary[]> {
  if (!principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst")) return [];
  const scope = scopeForPrincipal(principal);
  const roots = pathsToLtree(scope.orgScopes);
  return withTenantTransaction(await pool(), scope, async (client) => {
    const { rows } = await client.query(
      `SELECT q.id,q.bank_id,b.name AS bank_name,q.question_type,q.prompt,q.options,q.answer_key,q.rationale,
              q.points::float8 AS points,q.difficulty,q.bloom_level,q.origin,q.review_status
         FROM osa.assessment_questions q
         JOIN osa.question_banks b ON b.tenant_id=q.tenant_id AND b.id=q.bank_id
         JOIN osa.org_units ou ON ou.tenant_id=b.tenant_id AND ou.id=b.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY q.updated_at DESC`,
      [roots],
    );
    return rows.map((row) => ({
      id: String(row.id), bankId: String(row.bank_id), bankName: String(row.bank_name),
      questionType: String(row.question_type) as QuestionType, prompt: String(row.prompt), options: row.options,
      answerKey: row.answer_key, rationale: String(row.rationale ?? ""), points: num(row.points), difficulty: num(row.difficulty),
      bloomLevel: String(row.bloom_level) as BloomLevel, origin: String(row.origin) as AuthorQuestionSummary["origin"],
      reviewStatus: String(row.review_status) as AuthorQuestionSummary["reviewStatus"],
    }));
  }, { readOnly: true });
}

export async function listMarkingQueue(principal: Principal): Promise<MarkingQueueItem[]> {
  if (!principal.roles.some((role) => role === "tenant_admin" || role === "assessor")) return [];
  const scope = scopeForPrincipal(principal);
  const roots = pathsToLtree(scope.orgScopes);
  return withTenantTransaction(await pool(), scope, async (client) => {
    const { rows } = await client.query(
      `SELECT r.id AS response_id,r.attempt_id,x.assessment_id,a.code AS assessment_code,a.title AS assessment_title,
              x.subject_user_id,u.display_name AS learner_name,u.email::text AS learner_email,
              r.question_id,q.question_type,q.prompt,r.response,q.answer_key,q.rationale,
              coalesce(i.points_override,q.points)::float8 AS max_points,x.submitted_at
         FROM osa.assessment_responses r
         JOIN osa.assessment_attempts x ON x.tenant_id=r.tenant_id AND x.id=r.attempt_id
         JOIN osa.assessments a ON a.tenant_id=x.tenant_id AND a.id=x.assessment_id
         JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
         JOIN osa.users u ON u.tenant_id=x.tenant_id AND u.id=x.subject_user_id
         JOIN osa.assessment_questions q ON q.tenant_id=r.tenant_id AND q.id=r.question_id
         JOIN osa.assessment_items i ON i.tenant_id=x.tenant_id AND i.assessment_id=x.assessment_id AND i.question_id=r.question_id
        WHERE x.status='submitted'
          AND r.final_score IS NULL
          AND ou.path <@ ANY($1::ltree[])
        ORDER BY x.submitted_at,a.title,u.display_name,i.position`,
      [roots],
    );
    return rows.map((row) => ({
      responseId: String(row.response_id), attemptId: String(row.attempt_id), assessmentId: String(row.assessment_id),
      assessmentCode: String(row.assessment_code), assessmentTitle: String(row.assessment_title), learnerId: String(row.subject_user_id),
      learnerName: String(row.learner_name), learnerEmail: String(row.learner_email), questionId: String(row.question_id),
      questionType: String(row.question_type) as QuestionType, prompt: String(row.prompt), response: row.response,
      answerKey: row.answer_key, rationale: String(row.rationale ?? ""), maxPoints: num(row.max_points), submittedAt: iso(row.submitted_at),
    }));
  }, { readOnly: true });
}
