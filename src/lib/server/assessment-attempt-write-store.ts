import "server-only";

import type { Principal } from "./auth";
import { scopeForPrincipal } from "./tenant-runtime";
import { assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction, type Pool } from "./db/driver";
import { newId } from "./db/ids";

let poolPromise: Promise<Pool> | null = null;

async function pool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for assessment attempts");
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

/**
 * Saves one learner response only while the attempt is writable. The deadline
 * check and the upsert share one database transaction, so changing the browser
 * timer or racing the final second cannot extend an exam window.
 */
export async function saveTimedAssessmentResponse(
  principal: Principal,
  attemptId: string,
  questionId: string,
  response: unknown,
): Promise<void> {
  if (!principal.roles.includes("learner")) throw new Error("Learner permission required");
  const scope = scopeForPrincipal(principal);
  await withTenantTransaction(await pool(), scope, async (client) => {
    const writable = await client.query(
      `SELECT 1
         FROM osa.assessment_attempts x
         JOIN osa.assessments a
           ON a.tenant_id = x.tenant_id AND a.id = x.assessment_id
         JOIN osa.assessment_items i
           ON i.tenant_id = x.tenant_id AND i.assessment_id = x.assessment_id
        WHERE x.id = $1::uuid
          AND x.subject_user_id = $2::uuid
          AND x.status = 'in_progress'
          AND i.question_id = $3::uuid
          AND (a.duration_minutes IS NULL OR x.started_at + make_interval(mins => a.duration_minutes) > now())
          AND (a.closes_at IS NULL OR a.closes_at > now())`,
      [attemptId, scope.userId, questionId],
    );
    if (!writable.rowCount) throw new Error("This assessment is no longer accepting answer changes");

    await client.query(
      `INSERT INTO osa.assessment_responses
        (id, tenant_id, attempt_id, question_id, response, answered_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, now())
       ON CONFLICT (tenant_id, attempt_id, question_id)
       DO UPDATE SET
         response = excluded.response,
         answered_at = now(),
         auto_score = NULL,
         manual_score = NULL,
         final_score = NULL,
         feedback = '',
         graded_by = NULL,
         graded_at = NULL`,
      [newId(), scope.tenantId, attemptId, questionId, JSON.stringify(response)],
    );
  });
}
