import "server-only";

import type { Principal } from "./auth";
import type { Assessment } from "./domain";
import type { AssessmentSummary } from "./assessment-store";
import { scopeForPrincipal } from "./tenant-runtime";
import { assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction, type Pool } from "./db/driver";
import { pathToLtree, pathsToLtree } from "./db/ids";

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

export async function listAssessmentWorkspace(principal: Principal): Promise<AssessmentSummary[]> {
  const scope = scopeForPrincipal(principal);
  const authorView = principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst" || role === "assessor");
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
