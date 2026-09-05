import type { Queryable } from "./driver";
import * as map from "./mapping";
import type { Database } from "../domain";

/**
 * Loads one tenant's rows as a `Database` object.
 *
 * The application was written against a single in-memory `Database` that every
 * page and route reads and filters. Rewriting all thirty-one of those call
 * sites at once, on the day of a datastore cutover, would mean changing the
 * storage layer and every consumer of it in the same step — with no way to tell
 * a persistence bug from a filtering bug when something came out wrong.
 *
 * So the snapshot keeps that shape while the storage underneath it changes.
 * Reads become one round trip per table for the CURRENT TENANT ONLY, which the
 * transaction's RLS context enforces rather than the application: even if a
 * predicate here were wrong, another tenant's rows are not reachable.
 *
 * The honest cost: this loads a tenant's working set per request. That is fine
 * at pilot scale and is not how this should read a hundred thousand evidence
 * rows. `OsaRepository` already exposes indexed, scoped queries
 * (`listGapCasesWithContext`, `readinessSummary`, …) and hot paths should move
 * onto them screen by screen. This exists so that migration can happen after
 * the cutover instead of blocking it.
 */
export async function loadTenantSnapshot(db: Queryable): Promise<Database> {
  const q = async (sql: string) => (await db.query(sql)).rows;

  // `roles` is normalised into osa.user_roles, and the domain type wants an
  // array; delegated_org_paths is ltree[] which toUser converts back.
  const users = await q(`
    SELECT u.*,
           -- ltree[] has no node-postgres parser, so it arrives as the raw
           -- string "{a.b}" and parses to an empty array - which would leave
           -- every user with no delegated scope and every screen empty. Cast to
           -- text[] so the driver returns a real array.
           u.delegated_org_paths::text[] AS delegated_org_paths,
           COALESCE(array_agg(r.role_code) FILTER (WHERE r.role_code IS NOT NULL), '{}') AS roles
      FROM osa.users u
      LEFT JOIN osa.user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
     GROUP BY u.id
     ORDER BY u.created_at`);

  const studies = await q(`
    SELECT s.*, COALESCE(array_agg(t.job_role_id) FILTER (WHERE t.job_role_id IS NOT NULL), '{}') AS target_role_ids
      FROM osa.tna_studies s
      LEFT JOIN osa.tna_target_roles t ON t.tna_study_id = s.id AND t.tenant_id = s.tenant_id
     GROUP BY s.id
     ORDER BY s.created_at`);

  const signals = await q(`
    SELECT g.*,
           COALESCE(array_agg(DISTINCT jr.job_role_id) FILTER (WHERE jr.job_role_id IS NOT NULL), '{}') AS affected_job_role_ids,
           COALESCE(array_agg(DISTINCT sk.skill_id)    FILTER (WHERE sk.skill_id    IS NOT NULL), '{}') AS affected_skill_ids
      FROM osa.signals g
      LEFT JOIN osa.signal_job_roles jr ON jr.signal_id = g.id AND jr.tenant_id = g.tenant_id
      LEFT JOIN osa.signal_skills    sk ON sk.signal_id = g.id AND sk.tenant_id = g.tenant_id
     GROUP BY g.id
     ORDER BY g.detected_at DESC`);

  const [
    tenants, orgUnits, skills, jobRoles, requirements, evidence, gapCases,
    interventions, courses, courseModules, enrollments, moduleCompletions,
    notifications, auditEvents,
  ] = await Promise.all([
    q("SELECT * FROM osa.tenants ORDER BY slug"),
    q("SELECT * FROM osa.org_units ORDER BY path"),
    q("SELECT * FROM osa.skills ORDER BY code"),
    q("SELECT * FROM osa.job_roles ORDER BY code"),
    q("SELECT * FROM osa.requirements ORDER BY valid_from"),
    q("SELECT * FROM osa.evidence ORDER BY observed_at DESC"),
    q("SELECT * FROM osa.gap_cases ORDER BY gap DESC"),
    q("SELECT * FROM osa.interventions ORDER BY due_date"),
    q("SELECT * FROM osa.courses ORDER BY code"),
    q("SELECT * FROM osa.course_modules ORDER BY position"),
    q("SELECT * FROM osa.enrollments ORDER BY created_at"),
    q("SELECT * FROM osa.module_completions ORDER BY completed_at"),
    q("SELECT * FROM osa.notifications ORDER BY created_at DESC"),
    // Ascending: the hash chain only verifies in the order it was written.
    q("SELECT * FROM osa.audit_events ORDER BY sequence"),
  ]);

  return {
    schemaVersion: 2,
    tenants: tenants.map(map.toTenant),
    orgUnits: orgUnits.map(map.toOrgUnit),
    users: users.map(map.toUser),
    // Sessions are stored as digests and are owned entirely by auth.ts through
    // the repository. Nothing that reads a snapshot may consult them.
    sessions: [],
    jobRoles: jobRoles.map(map.toJobRole),
    skills: skills.map(map.toSkill),
    requirements: requirements.map(map.toRequirement),
    tnaStudies: studies.map(map.toStudy),
    evidence: evidence.map(map.toEvidence),
    gapCases: gapCases.map(map.toGapCase),
    interventions: interventions.map(map.toIntervention),
    courses: courses.map(map.toCourse),
    courseModules: courseModules.map(map.toCourseModule),
    enrollments: enrollments.map(map.toEnrollment),
    moduleCompletions: moduleCompletions.map(map.toModuleCompletion),
    signals: signals.map(map.toSignal),
    notifications: notifications.map(map.toNotification),
    auditEvents: auditEvents.map(map.toAuditEvent),
  };
}
