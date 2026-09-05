/**
 * PostgreSQL implementation of `OsaRepository` / `OsaPersistence`.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. Every statement runs inside `withTenantTransaction`, which has already
 *     executed `set_config('app.tenant_id' | 'app.user_id', …, true)` from the
 *     validated session. There is no code path that reaches a table without a
 *     tenant context.
 *  2. Tenant, delegated-org and self scope are SQL predicates, never a filter
 *     applied to a fetched array. `orgScopes` is matched with the ltree
 *     containment operator so the GiST index from 001 does the work.
 *  3. Domain rules are not reimplemented in SQL. `recordModuleCompletion`,
 *     `refreshGapsForEvidence` and the audit chain signature stay in
 *     `learning.ts` and `audit.ts`; this adapter loads the working set those
 *     functions need, runs them, and writes back the delta inside one
 *     transaction. Two implementations of "may this completion emit evidence"
 *     is exactly how a compliance product starts telling two different stories.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AuditEvent, Course, CourseModule, Database, Enrollment, Evidence, Intervention,
  JobRole, Notification, OrgUnit, Requirement, Signal, Skill, Tenant, TnaStudy, User,
} from "../domain";
import { recordModuleCompletion, refreshGapsForEvidence } from "../learning";
import { signAuditEvent } from "./audit-chain";
import {
  assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction,
  type Pool, type PoolClient, type Queryable, type RuntimeRoleReport,
} from "./driver";
import { newId, pathToLtree, pathsToLtree, toStorageId, toStorageIdOrNull } from "./ids";
import * as map from "./mapping";
import type {
  ActorScope, AuditInput, CompletionResult, CourseDraft, CourseWithModules,
  EnrollmentDraft, EnrollmentWithProgress, EvidenceDraft, GapCaseWithContext,
  InterventionDraft, NotificationDraft, OsaPersistence, OsaRepository,
  PrincipalRecord, ReadinessSummary, SessionRef, StudyDraft, Uuid,
} from "./repository";

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Column lists. Every `numeric` is cast to float8 and every `date` to text; see
 * mapping.ts for the two bugs those casts prevent.
 */
const EVIDENCE_COLUMNS = `e.id, e.tenant_id, e.org_unit_id, e.subject_user_id, e.skill_id, e.evidence_type,
  e.proficiency_level, e.strength::float8 AS strength, e.observed_at, e.expires_at, e.assessor_user_id,
  e.source_reference, e.status`;
const COURSE_COLUMNS = `c.id, c.tenant_id, c.org_unit_id, c.code, c.title, c.description, c.skill_id,
  c.target_level, c.evidence_rule, c.passing_score::float8 AS passing_score, c.validity_months,
  c.version, c.status, c.created_at`;
const enrollmentColumns = (prefix = "en."): string =>
  `${prefix}id, ${prefix}tenant_id, ${prefix}org_unit_id, ${prefix}course_id, ${prefix}subject_user_id,
   ${prefix}source, ${prefix}intervention_id, ${prefix}gap_case_id, ${prefix}status,
   ${prefix}assigned_by_user_id, ${prefix}due_date::text AS due_date, ${prefix}started_at,
   ${prefix}completed_at, ${prefix}score::float8 AS score, ${prefix}evidence_id, ${prefix}created_at`;
const ENROLLMENT_COLUMNS = enrollmentColumns();
const MODULE_COLUMNS = `m.id, m.tenant_id, m.course_id, m.position, m.title, m.kind, m.duration_minutes, m.required`;

/**
 * The synthetic `Database` shell handed to the pure domain functions.
 *
 * Only the collections the called function reads are populated; everything else
 * is an empty array. This is the seam that lets `learning.ts` stay a pure
 * function over a working set while the repository decides how small that
 * working set is — the whole point of the migration.
 */
function workingSet(parts: Partial<Database>): Database {
  const empty: Omit<Database, "schemaVersion"> = {
    tenants: [], orgUnits: [], users: [], sessions: [], jobRoles: [], skills: [], requirements: [],
    tnaStudies: [], evidence: [], gapCases: [], interventions: [], courses: [], courseModules: [],
    enrollments: [], moduleCompletions: [], signals: [], notifications: [], auditEvents: [],
  };
  // `schemaVersion` is deliberately absent: it describes a datastore file, and
  // this is a working set. No domain function reads it, so pinning a literal
  // here would only create a false coupling to the JSON store's version number.
  return { ...empty, ...parts } as Database;
}

class PostgresRepository implements OsaRepository {
  constructor(private readonly db: Queryable, private readonly scope: ActorScope) {}

  private get orgScopes(): string[] {
    return pathsToLtree(this.scope.orgScopes);
  }

  /** `<@` is "at or below", the indexable form of `path.startsWith(scope + "/")`. */
  private scopeArgs(): [string[], boolean, string] {
    return [this.orgScopes, this.scope.selfOnly, this.scope.userId];
  }

  /* ---- identity ------------------------------------------------------- */

  async findUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.tenant_id, u.org_unit_id, u.email::text AS email, u.display_name, u.password_hash,
              u.active, u.created_at,
              coalesce((SELECT array_agg(r.role_code ORDER BY r.role_code) FROM osa.user_roles r
                         WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id), '{}') AS roles,
              (SELECT array_agg(p::text) FROM unnest(u.delegated_org_paths) p) AS delegated_org_paths
         FROM osa.users u
        WHERE u.email = $1::citext AND u.active`,
      [email.trim()],
    );
    return rows[0] ? map.toUser(rows[0]) : null;
  }

  async loadPrincipal(userId: Uuid): Promise<PrincipalRecord | null> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.tenant_id, u.org_unit_id, u.email::text AS email, u.display_name, u.password_hash,
              u.active, u.created_at,
              coalesce((SELECT array_agg(r.role_code ORDER BY r.role_code) FROM osa.user_roles r
                         WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id), '{}') AS roles,
              (SELECT array_agg(p::text) FROM unnest(u.delegated_org_paths) p) AS delegated_org_paths
         FROM osa.users u
        WHERE u.id = $1::uuid AND u.active`,
      [userId],
    );
    if (!rows[0]) return null;
    const user = map.toUser(rows[0]);
    return { user, roles: user.roles, delegatedOrgPaths: user.delegatedOrgPaths };
  }

  async createSession(input: { sessionToken: string; csrfToken: string; expiresAt: string }): Promise<void> {
    // Only digests are stored. A datastore compromise therefore yields no
    // usable session cookie and no usable CSRF token.
    await this.db.query(
      `INSERT INTO osa.sessions (id_hash, tenant_id, user_id, csrf_hash, expires_at)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::timestamptz)`,
      [sha256(input.sessionToken), this.scope.tenantId, this.scope.userId, sha256(input.csrfToken), input.expiresAt],
    );
  }

  async deleteSession(sessionToken: string): Promise<void> {
    await this.db.query("DELETE FROM osa.sessions WHERE id_hash = $1", [sha256(sessionToken)]);
  }

  async deleteSessionsForUser(userId: Uuid): Promise<void> {
    await this.db.query("DELETE FROM osa.sessions WHERE user_id = $1::uuid", [userId]);
  }

  /* ---- reads ---------------------------------------------------------- */

  async tenant(): Promise<Tenant | null> {
    const { rows } = await this.db.query(
      "SELECT id, slug, name, home_region, locale, created_at FROM osa.tenants WHERE id = $1::uuid",
      [this.scope.tenantId],
    );
    return rows[0] ? map.toTenant(rows[0]) : null;
  }

  async listOrgUnitsInScope(): Promise<OrgUnit[]> {
    const { rows } = await this.db.query(
      `SELECT ou.id, ou.tenant_id, ou.parent_id, ou.code, ou.name, ou.path::text AS path
         FROM osa.org_units ou
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY ou.path`,
      [this.orgScopes],
    );
    return rows.map(map.toOrgUnit);
  }

  async loadSnapshot(): Promise<import("../domain").Database> {
    const { loadTenantSnapshot } = await import("./snapshot");
    return loadTenantSnapshot(this.db);
  }

  async listSkills(): Promise<Skill[]> {
    const { rows } = await this.db.query(
      "SELECT id, tenant_id, code, name, description FROM osa.skills WHERE status <> 'retired' ORDER BY code",
    );
    return rows.map(map.toSkill);
  }

  async listJobRolesInScope(): Promise<JobRole[]> {
    const { rows } = await this.db.query(
      `SELECT jr.id, jr.tenant_id, jr.org_unit_id, jr.code, jr.title, jr.purpose, jr.version, jr.status, jr.valid_from
         FROM osa.job_roles jr
         JOIN osa.org_units ou ON ou.tenant_id = jr.tenant_id AND ou.id = jr.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[]) AND jr.valid_to IS NULL
        ORDER BY jr.code, jr.version DESC`,
      [this.orgScopes],
    );
    return rows.map(map.toJobRole);
  }

  async listRequirementsInScope(): Promise<Requirement[]> {
    const { rows } = await this.db.query(
      `SELECT rq.id, rq.tenant_id, rq.org_unit_id, rq.job_role_id, rq.skill_id, rq.source_type,
              rq.source_reference, rq.required_level, rq.criticality, rq.valid_from, rq.valid_to, rq.version
         FROM osa.requirements rq
         JOIN osa.org_units ou ON ou.tenant_id = rq.tenant_id AND ou.id = rq.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[]) AND rq.valid_to IS NULL
        ORDER BY rq.required_level DESC`,
      [this.orgScopes],
    );
    return rows.map(map.toRequirement);
  }

  async listStudiesInScope(): Promise<TnaStudy[]> {
    const { rows } = await this.db.query(
      `SELECT s.id, s.tenant_id, s.org_unit_id, s.title, s.objective, s.status, s.owner_user_id,
              s.due_date::text AS due_date, s.created_at,
              coalesce((SELECT array_agg(tr.job_role_id::text) FROM osa.tna_target_roles tr
                         WHERE tr.tenant_id = s.tenant_id AND tr.tna_study_id = s.id), '{}') AS target_role_ids
         FROM osa.tna_studies s
         JOIN osa.org_units ou ON ou.tenant_id = s.tenant_id AND ou.id = s.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY s.due_date`,
      [this.orgScopes],
    );
    return rows.map(map.toStudy);
  }

  async listEvidenceInScope(filter: { status?: Evidence["status"]; subjectUserId?: Uuid; skillId?: Uuid } = {}): Promise<Evidence[]> {
    const [orgScopes, selfOnly, userId] = this.scopeArgs();
    const { rows } = await this.db.query(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM osa.evidence e
         JOIN osa.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
          AND (NOT $2::boolean OR e.subject_user_id = $3::uuid)
          AND ($4::text IS NULL OR e.status = $4)
          AND ($5::uuid IS NULL OR e.subject_user_id = $5)
          AND ($6::uuid IS NULL OR e.skill_id = $6)
        ORDER BY e.observed_at DESC`,
      [orgScopes, selfOnly, userId, filter.status ?? null, filter.subjectUserId ?? null, filter.skillId ?? null],
    );
    return rows.map(map.toEvidence);
  }

  /**
   * `GET /api/gaps` resolved the requirement, the subject and the interventions
   * for every gap with three array scans each. Here it is one join plus one
   * batched lookup — a constant number of round trips, whatever the row count.
   */
  async listGapCasesWithContext(): Promise<GapCaseWithContext[]> {
    const [orgScopes, selfOnly, userId] = this.scopeArgs();
    const { rows } = await this.db.query(
      `SELECT g.id, g.tenant_id, g.org_unit_id, g.tna_study_id, g.subject_user_id, g.requirement_id,
              g.required_level, g.evidenced_level, g.gap, g.priority, g.cause_hypothesis, g.status,
              rq.id AS r_id, rq.tenant_id AS r_tenant_id, rq.org_unit_id AS r_org_unit_id,
              rq.job_role_id AS r_job_role_id, rq.skill_id AS r_skill_id, rq.source_type AS r_source_type,
              rq.source_reference AS r_source_reference, rq.required_level AS r_required_level,
              rq.criticality AS r_criticality, rq.valid_from AS r_valid_from, rq.valid_to AS r_valid_to,
              rq.version AS r_version,
              su.display_name AS subject_display_name
         FROM osa.gap_cases g
         JOIN osa.org_units ou ON ou.tenant_id = g.tenant_id AND ou.id = g.org_unit_id
         LEFT JOIN osa.requirements rq ON rq.tenant_id = g.tenant_id AND rq.id = g.requirement_id
         LEFT JOIN osa.users su ON su.tenant_id = g.tenant_id AND su.id = g.subject_user_id
        WHERE ou.path <@ ANY($1::ltree[])
          AND (NOT $2::boolean OR g.subject_user_id = $3::uuid)
        ORDER BY g.priority DESC, g.gap DESC`,
      [orgScopes, selfOnly, userId],
    );
    if (rows.length === 0) return [];

    const gapIds = rows.map((row) => String(row.id));
    const { rows: interventionRows } = await this.db.query(
      `SELECT i.id, i.tenant_id, i.org_unit_id, i.gap_case_id, i.intervention_type, i.title,
              i.owner_user_id, i.due_date::text AS due_date, i.status
         FROM osa.interventions i
        WHERE i.gap_case_id = ANY($1::uuid[])
        ORDER BY i.due_date`,
      [gapIds],
    );
    const byGap = new Map<string, Intervention[]>();
    for (const row of interventionRows) {
      const item = map.toIntervention(row);
      const bucket = byGap.get(item.gapCaseId);
      if (bucket) bucket.push(item); else byGap.set(item.gapCaseId, [item]);
    }

    return rows.map((row) => ({
      ...map.toGapCase(row),
      requirement: row.r_id
        ? map.toRequirement({
            id: row.r_id, tenant_id: row.r_tenant_id, org_unit_id: row.r_org_unit_id,
            job_role_id: row.r_job_role_id, skill_id: row.r_skill_id, source_type: row.r_source_type,
            source_reference: row.r_source_reference, required_level: row.r_required_level,
            criticality: row.r_criticality, valid_from: row.r_valid_from, valid_to: row.r_valid_to,
            version: row.r_version,
          })
        : null,
      subject: row.subject_display_name
        ? { id: String(row.subject_user_id), displayName: String(row.subject_display_name) }
        : null,
      interventions: byGap.get(String(row.id)) ?? [],
    }));
  }

  async listInterventionsInScope(): Promise<Intervention[]> {
    const { rows } = await this.db.query(
      `SELECT i.id, i.tenant_id, i.org_unit_id, i.gap_case_id, i.intervention_type, i.title,
              i.owner_user_id, i.due_date::text AS due_date, i.status
         FROM osa.interventions i
         JOIN osa.org_units ou ON ou.tenant_id = i.tenant_id AND ou.id = i.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY i.due_date`,
      [this.orgScopes],
    );
    return rows.map(map.toIntervention);
  }

  /**
   * Catalogue visibility, in the opposite direction to record visibility.
   *
   * `co.path <@ ANY(scopes)` is content the viewer administers; `co.path @>
   * viewerPath` is content inherited from a unit at or above their own. Reusing
   * record scoping here leaves every front-line learner with an empty
   * catalogue — the exact population the product exists to qualify.
   */
  async listAvailableCourses(): Promise<CourseWithModules[]> {
    const { rows } = await this.db.query(
      `SELECT ${COURSE_COLUMNS}
         FROM osa.courses c
         JOIN osa.org_units ou ON ou.tenant_id = c.tenant_id AND ou.id = c.org_unit_id
        WHERE (ou.path <@ ANY($1::ltree[]) OR ou.path @> $2::ltree)
          AND c.valid_to IS NULL
        ORDER BY c.code`,
      [this.orgScopes, pathToLtree(this.scope.viewerOrgPath)],
    );
    if (rows.length === 0) return [];
    const courses = rows.map(map.toCourse);
    const modulesByCourse = await this.modulesFor(courses.map((course) => course.id));
    return courses.map((course) => {
      const modules = modulesByCourse.get(course.id) ?? [];
      return {
        ...course, modules, moduleCount: modules.length,
        durationMinutes: modules.reduce((total, item) => total + item.durationMinutes, 0),
      };
    });
  }

  private async modulesFor(courseIds: readonly string[]): Promise<Map<string, CourseModule[]>> {
    const grouped = new Map<string, CourseModule[]>();
    if (courseIds.length === 0) return grouped;
    const { rows } = await this.db.query(
      `SELECT ${MODULE_COLUMNS} FROM osa.course_modules m
        WHERE m.course_id = ANY($1::uuid[]) ORDER BY m.course_id, m.position`,
      [courseIds],
    );
    for (const row of rows) {
      const item = map.toCourseModule(row);
      const bucket = grouped.get(item.courseId);
      if (bucket) bucket.push(item); else grouped.set(item.courseId, [item]);
    }
    return grouped;
  }

  async listEnrollmentsWithProgress(): Promise<EnrollmentWithProgress[]> {
    const [orgScopes, selfOnly, userId] = this.scopeArgs();
    const { rows } = await this.db.query(
      `SELECT ${ENROLLMENT_COLUMNS},
              c.code AS course_code, c.title AS course_title, c.evidence_rule AS course_evidence_rule,
              c.target_level AS course_target_level, c.skill_id AS course_skill_id
         FROM osa.enrollments en
         JOIN osa.org_units ou ON ou.tenant_id = en.tenant_id AND ou.id = en.org_unit_id
         LEFT JOIN osa.courses c ON c.tenant_id = en.tenant_id AND c.id = en.course_id
        WHERE ou.path <@ ANY($1::ltree[])
          AND (NOT $2::boolean OR en.subject_user_id = $3::uuid)
        ORDER BY en.created_at DESC`,
      [orgScopes, selfOnly, userId],
    );
    if (rows.length === 0) return [];

    const enrollments = rows.map(map.toEnrollment);
    const modulesByCourse = await this.modulesFor([...new Set(enrollments.map((item) => item.courseId))]);
    const { rows: completionRows } = await this.db.query(
      `SELECT mc.enrollment_id, mc.module_id FROM osa.module_completions mc
        WHERE mc.enrollment_id = ANY($1::uuid[])`,
      [enrollments.map((item) => item.id)],
    );
    const completedByEnrollment = new Map<string, string[]>();
    for (const row of completionRows) {
      const key = String(row.enrollment_id);
      const bucket = completedByEnrollment.get(key);
      if (bucket) bucket.push(String(row.module_id)); else completedByEnrollment.set(key, [String(row.module_id)]);
    }

    return enrollments.map((enrollment, index) => {
      const row = rows[index];
      const modules = modulesByCourse.get(enrollment.courseId) ?? [];
      const completedModuleIds = completedByEnrollment.get(enrollment.id) ?? [];
      const completed = new Set(completedModuleIds);
      const required = modules.filter((item) => item.required);
      const done = required.filter((item) => completed.has(item.id)).length;
      return {
        ...enrollment,
        course: row.course_code
          ? {
              id: enrollment.courseId, code: String(row.course_code), title: String(row.course_title),
              evidenceRule: String(row.course_evidence_rule) as Course["evidenceRule"],
              targetLevel: Number(row.course_target_level), skillId: String(row.course_skill_id),
            }
          : null,
        modules, completedModuleIds,
        progress: { completed: done, total: required.length, percent: required.length ? Math.round((done / required.length) * 100) : 0 },
      };
    });
  }

  async listSignalsInScope(): Promise<Signal[]> {
    const { rows } = await this.db.query(
      `SELECT s.id, s.tenant_id, s.org_unit_id, s.source, s.source_reference, s.title, s.summary,
              s.detected_at, s.effective_at, s.severity, s.status, s.linked_study_id,
              s.triaged_by_user_id, s.triaged_at, s.dismissed_reason,
              coalesce((SELECT array_agg(j.job_role_id::text) FROM osa.signal_job_roles j
                         WHERE j.tenant_id = s.tenant_id AND j.signal_id = s.id), '{}') AS affected_job_role_ids,
              coalesce((SELECT array_agg(k.skill_id::text) FROM osa.signal_skills k
                         WHERE k.tenant_id = s.tenant_id AND k.signal_id = s.id), '{}') AS affected_skill_ids
         FROM osa.signals s
         JOIN osa.org_units ou ON ou.tenant_id = s.tenant_id AND ou.id = s.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[])
        ORDER BY s.severity DESC, s.detected_at DESC`,
      [this.orgScopes],
    );
    return rows.map(map.toSignal);
  }

  async listOpenNotifications(): Promise<Notification[]> {
    const { rows } = await this.db.query(
      `SELECT n.id, n.tenant_id, n.org_unit_id, n.subject_user_id, n.kind, n.severity, n.title, n.body,
              n.resource_type, n.resource_id, n.due_at, n.dedupe_key, n.created_at, n.read_at, n.resolved_at
         FROM osa.notifications n
        WHERE n.resolved_at IS NULL
          AND n.subject_user_id = $1::uuid
        ORDER BY n.severity DESC, n.due_at NULLS LAST`,
      [this.scope.userId],
    );
    return rows.map(map.toNotification);
  }

  /**
   * `readinessSummary()` currently makes four full passes over the database and
   * calls `visibleRows()` on each, which is four O(rows x orgUnits) scans for
   * six integers. Here it is one query whose predicates every index can serve.
   */
  async readinessSummary(): Promise<ReadinessSummary> {
    const [orgScopes, selfOnly, userId] = this.scopeArgs();
    const { rows } = await this.db.query(
      `WITH scoped_orgs AS (
         SELECT ou.id FROM osa.org_units ou WHERE ou.path <@ ANY($1::ltree[])
       ),
       gaps AS (
         SELECT g.priority, g.required_level, g.evidenced_level
           FROM osa.gap_cases g
          WHERE g.org_unit_id IN (SELECT id FROM scoped_orgs)
            AND g.status <> 'verified'
            AND (NOT $2::boolean OR g.subject_user_id = $3::uuid)
       )
       SELECT
         (SELECT count(*) FROM osa.tna_studies s WHERE s.org_unit_id IN (SELECT id FROM scoped_orgs)) AS studies,
         (SELECT count(*) FROM gaps) AS open_gaps,
         (SELECT count(*) FROM gaps WHERE priority = 'critical') AS critical_gaps,
         (SELECT count(*) FROM osa.evidence e
            WHERE e.org_unit_id IN (SELECT id FROM scoped_orgs) AND e.status = 'verified'
              AND (NOT $2::boolean OR e.subject_user_id = $3::uuid)) AS verified_evidence,
         (SELECT count(*) FROM osa.interventions i
            WHERE i.org_unit_id IN (SELECT id FROM scoped_orgs) AND i.status = 'active') AS active_interventions,
         (SELECT coalesce(sum(required_level), 0) FROM gaps) AS required_total,
         (SELECT coalesce(sum(least(evidenced_level, required_level)), 0) FROM gaps) AS evidenced_total`,
      [orgScopes, selfOnly, userId],
    );
    const row = rows[0] ?? {};
    const required = Number(row.required_total ?? 0);
    const evidenced = Number(row.evidenced_total ?? 0);
    return {
      studies: Number(row.studies ?? 0),
      openGaps: Number(row.open_gaps ?? 0),
      criticalGaps: Number(row.critical_gaps ?? 0),
      verifiedEvidence: Number(row.verified_evidence ?? 0),
      activeInterventions: Number(row.active_interventions ?? 0),
      readinessPercent: required ? Math.round((evidenced / required) * 100) : 100,
    };
  }

  async listAuditEvents(limit: number): Promise<AuditEvent[]> {
    const { rows } = await this.db.query(
      `SELECT a.id, a.tenant_id, a.actor_user_id, a.action, a.resource_type, a.resource_id, a.outcome,
              a.occurred_at, a.request_id, a.metadata, a.previous_hash, a.event_hash
         FROM osa.audit_events a
        ORDER BY a.sequence DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return rows.map(map.toAuditEvent);
  }

  async auditChainPage(afterSequence: bigint | null, batchSize: number): Promise<Array<AuditEvent & { sequence: bigint }>> {
    const { rows } = await this.db.query(
      `SELECT a.sequence, a.id, a.tenant_id, a.actor_user_id, a.action, a.resource_type, a.resource_id,
              a.outcome, a.occurred_at, a.request_id, a.metadata, a.previous_hash, a.event_hash
         FROM osa.audit_events a
        WHERE ($1::bigint IS NULL OR a.sequence > $1::bigint)
        ORDER BY a.sequence
        LIMIT $2`,
      [afterSequence === null ? null : afterSequence.toString(), Math.max(1, batchSize)],
    );
    return rows.map((row) => ({ ...map.toAuditEvent(row), sequence: BigInt(String(row.sequence)) }));
  }

  /* ---- writes --------------------------------------------------------- */

  async insertStudy(draft: StudyDraft): Promise<TnaStudy> {
    const id = newId();
    await this.db.query(
      `INSERT INTO osa.tna_studies (id, tenant_id, org_unit_id, title, objective, status, owner_user_id, due_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::date)`,
      [id, this.scope.tenantId, toStorageId(draft.orgUnitId), draft.title, draft.objective, draft.status,
        toStorageId(draft.ownerUserId), draft.dueDate],
    );
    if (draft.targetRoleIds.length > 0) {
      await this.db.query(
        `INSERT INTO osa.tna_target_roles (tenant_id, tna_study_id, job_role_id)
         SELECT $1::uuid, $2::uuid, unnest($3::uuid[])`,
        [this.scope.tenantId, id, draft.targetRoleIds.map(toStorageId)],
      );
    }
    const { rows } = await this.db.query(
      `SELECT s.id, s.tenant_id, s.org_unit_id, s.title, s.objective, s.status, s.owner_user_id,
              s.due_date::text AS due_date, s.created_at,
              coalesce((SELECT array_agg(tr.job_role_id::text) FROM osa.tna_target_roles tr
                         WHERE tr.tenant_id = s.tenant_id AND tr.tna_study_id = s.id), '{}') AS target_role_ids
         FROM osa.tna_studies s WHERE s.id = $1::uuid`,
      [id],
    );
    return map.toStudy(rows[0]);
  }

  async insertEvidence(draft: EvidenceDraft): Promise<Evidence> {
    const { rows } = await this.db.query(
      `INSERT INTO osa.evidence (id, tenant_id, org_unit_id, subject_user_id, skill_id, evidence_type,
                                 proficiency_level, strength, observed_at, expires_at, assessor_user_id,
                                 source_reference, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::timestamptz, $10::timestamptz,
               $11::uuid, $12, $13)
       RETURNING id, tenant_id, org_unit_id, subject_user_id, skill_id, evidence_type, proficiency_level,
                 strength::float8 AS strength, observed_at, expires_at, assessor_user_id, source_reference, status`,
      [newId(), this.scope.tenantId, toStorageId(draft.orgUnitId), toStorageId(draft.subjectUserId),
        toStorageId(draft.skillId), draft.type, draft.proficiencyLevel, draft.strength, draft.observedAt,
        draft.expiresAt, toStorageIdOrNull(draft.assessorUserId), draft.sourceReference, draft.status],
    );
    return map.toEvidence(rows[0]);
  }

  async insertIntervention(draft: InterventionDraft): Promise<Intervention> {
    const { rows } = await this.db.query(
      `INSERT INTO osa.interventions (id, tenant_id, org_unit_id, gap_case_id, intervention_type, title,
                                      owner_user_id, due_date, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::date, $9)
       RETURNING id, tenant_id, org_unit_id, gap_case_id, intervention_type, title, owner_user_id,
                 due_date::text AS due_date, status`,
      [newId(), this.scope.tenantId, toStorageId(draft.orgUnitId), toStorageId(draft.gapCaseId), draft.type,
        draft.title, toStorageId(draft.ownerUserId), draft.dueDate, draft.status],
    );
    return map.toIntervention(rows[0]);
  }

  async markGapActioned(gapCaseId: Uuid): Promise<void> {
    // `gap` is GENERATED ALWAYS AS (...) STORED, so it is absent from every
    // UPDATE in this file. Including it raises
    //   ERROR: cannot insert a non-DEFAULT value into column "gap"
    // which is exactly what a literal port of refreshGapsForEvidence would do.
    await this.db.query(
      "UPDATE osa.gap_cases SET status = 'actioned', updated_at = now() WHERE id = $1::uuid AND status = 'open'",
      [toStorageId(gapCaseId)],
    );
  }

  async insertCourse(draft: CourseDraft): Promise<Course> {
    const { rows } = await this.db.query(
      `INSERT INTO osa.courses (id, tenant_id, org_unit_id, code, title, description, skill_id, target_level,
                                evidence_rule, passing_score, validity_months, version, status, recorded_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13, $14::uuid)
       RETURNING id, tenant_id, org_unit_id, code, title, description, skill_id, target_level, evidence_rule,
                 passing_score::float8 AS passing_score, validity_months, version, status, created_at`,
      [newId(), this.scope.tenantId, toStorageId(draft.orgUnitId), draft.code, draft.title, draft.description,
        toStorageId(draft.skillId), draft.targetLevel, draft.evidenceRule, draft.passingScore,
        draft.validityMonths, draft.version, draft.status, this.scope.userId],
    );
    return map.toCourse(rows[0]);
  }

  async findActiveEnrollment(courseId: Uuid, subjectUserId: Uuid): Promise<Enrollment | null> {
    const { rows } = await this.db.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM osa.enrollments en
        WHERE en.course_id = $1::uuid AND en.subject_user_id = $2::uuid
          AND en.status IN ('enrolled','in_progress')`,
      [toStorageId(courseId), toStorageId(subjectUserId)],
    );
    return rows[0] ? map.toEnrollment(rows[0]) : null;
  }

  /**
   * The "one active enrollment per learner per course" rule is enforced by the
   * partial unique index `enrollments_one_active`, not by the preceding
   * SELECT. The read-then-write in the route is a race two concurrent requests
   * both win; a unique violation here is the correct, serialized answer.
   */
  async insertEnrollment(draft: EnrollmentDraft): Promise<Enrollment> {
    const { rows } = await this.db.query(
      `INSERT INTO osa.enrollments (id, tenant_id, org_unit_id, course_id, subject_user_id, source,
                                    intervention_id, gap_case_id, status, assigned_by_user_id, due_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8::uuid, 'enrolled', $9::uuid, $10::date)
       RETURNING ${enrollmentColumns("")}`,
      [newId(), this.scope.tenantId, toStorageId(draft.orgUnitId), toStorageId(draft.courseId),
        toStorageId(draft.subjectUserId), draft.source, toStorageIdOrNull(draft.interventionId),
        toStorageIdOrNull(draft.gapCaseId), toStorageIdOrNull(draft.assignedByUserId), draft.dueDate],
    );
    return map.toEnrollment(rows[0]);
  }

  /**
   * Loads the working set `recordModuleCompletion` needs, runs the unmodified
   * domain function, then writes back only what it changed. The evidence rule,
   * the terminal-state guard and the retake behaviour are therefore identical
   * to the JSON path by construction, not by parallel implementation.
   */
  async completeModule(input: { enrollmentId: Uuid; moduleId: Uuid; score: number | null; now?: Date }): Promise<CompletionResult> {
    const now = input.now ?? new Date();
    const enrollmentId = toStorageId(input.enrollmentId);
    const moduleId = toStorageId(input.moduleId);

    // FOR UPDATE: a second concurrent completion of the final required module
    // would otherwise pass the "outstanding modules" test twice and mint two
    // evidence records for one course completion.
    const { rows: enrollmentRows } = await this.db.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM osa.enrollments en WHERE en.id = $1::uuid FOR UPDATE`,
      [enrollmentId],
    );
    if (!enrollmentRows[0]) throw new Error("Enrollment not found in tenant");
    const enrollment = map.toEnrollment(enrollmentRows[0]);

    const { rows: courseRows } = await this.db.query(
      `SELECT ${COURSE_COLUMNS} FROM osa.courses c WHERE c.id = $1::uuid`, [enrollment.courseId],
    );
    if (!courseRows[0]) throw new Error("Course not found for enrollment");
    const course = map.toCourse(courseRows[0]);

    const { rows: moduleRows } = await this.db.query(
      `SELECT ${MODULE_COLUMNS} FROM osa.course_modules m WHERE m.course_id = $1::uuid ORDER BY m.position`,
      [course.id],
    );
    const { rows: completionRows } = await this.db.query(
      `SELECT mc.id, mc.tenant_id, mc.enrollment_id, mc.module_id, mc.completed_at, mc.score::float8 AS score
         FROM osa.module_completions mc WHERE mc.enrollment_id = $1::uuid`,
      [enrollmentId],
    );

    const state = workingSet({
      courses: [course],
      courseModules: moduleRows.map(map.toCourseModule),
      moduleCompletions: completionRows.map(map.toModuleCompletion),
      enrollments: [enrollment],
    });
    const before = new Set(state.moduleCompletions.map((item) => item.id));

    const outcome = recordModuleCompletion(state, enrollment, moduleId, input.score, now);

    // Persist the completion. ON CONFLICT is the schema's version of the
    // "replaying the same module completion must not duplicate rows" rule; the
    // in-memory scan that implements it today is a race under concurrency.
    const touched = state.moduleCompletions.find(
      (item) => item.enrollmentId === enrollment.id && item.moduleId === moduleId,
    );
    if (touched) {
      await this.db.query(
        `INSERT INTO osa.module_completions (id, tenant_id, enrollment_id, module_id, course_id, completed_at, score)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7)
         ON CONFLICT (tenant_id, enrollment_id, module_id)
         DO UPDATE SET completed_at = excluded.completed_at, score = excluded.score`,
        [before.has(touched.id) ? toStorageId(touched.id) : newId(), this.scope.tenantId, enrollmentId,
          moduleId, course.id, touched.completedAt, touched.score],
      );
    }

    let evidence: Evidence | null = null;
    if (outcome.evidence) {
      evidence = await this.insertEvidence({
        tenantId: this.scope.tenantId, orgUnitId: outcome.evidence.orgUnitId,
        subjectUserId: outcome.evidence.subjectUserId, skillId: outcome.evidence.skillId,
        type: outcome.evidence.type, proficiencyLevel: outcome.evidence.proficiencyLevel,
        strength: outcome.evidence.strength, observedAt: outcome.evidence.observedAt,
        expiresAt: outcome.evidence.expiresAt, assessorUserId: outcome.evidence.assessorUserId,
        sourceReference: outcome.evidence.sourceReference, status: outcome.evidence.status,
      });
    }

    await this.db.query(
      `UPDATE osa.enrollments
          SET status = $2, started_at = $3::timestamptz, completed_at = $4::timestamptz,
              score = $5, evidence_id = $6::uuid
        WHERE id = $1::uuid`,
      [enrollmentId, outcome.enrollment.status, outcome.enrollment.startedAt, outcome.enrollment.completedAt,
        outcome.enrollment.score, evidence?.id ?? null],
    );

    const gapCasesRecalculated = evidence ? await this.recalculateGaps(evidence, now) : [];
    return {
      enrollment: { ...outcome.enrollment, evidenceId: evidence?.id ?? outcome.enrollment.evidenceId },
      evidence,
      evidenceWithheldReason: outcome.evidenceWithheldReason,
      completedModuleIds: outcome.completedModuleIds,
      outstandingModuleIds: outcome.outstandingModuleIds,
      gapCasesRecalculated,
    };
  }

  /**
   * `refreshGapsForEvidence` walks every gap, every requirement and every
   * evidence row. Here the candidate set is narrowed in SQL to gaps for this
   * subject whose requirement names this skill — typically a handful of rows —
   * and the unchanged domain function decides the new level.
   */
  private async recalculateGaps(evidence: Evidence, now: Date): Promise<Uuid[]> {
    const { rows: gapRows } = await this.db.query(
      `SELECT g.id, g.tenant_id, g.org_unit_id, g.tna_study_id, g.subject_user_id, g.requirement_id,
              g.required_level, g.evidenced_level, g.gap, g.priority, g.cause_hypothesis, g.status
         FROM osa.gap_cases g
         JOIN osa.requirements rq ON rq.tenant_id = g.tenant_id AND rq.id = g.requirement_id
        WHERE g.subject_user_id = $1::uuid AND rq.skill_id = $2::uuid
        FOR UPDATE OF g`,
      [evidence.subjectUserId, evidence.skillId],
    );
    if (gapRows.length === 0) return [];

    const { rows: requirementRows } = await this.db.query(
      `SELECT rq.id, rq.tenant_id, rq.org_unit_id, rq.job_role_id, rq.skill_id, rq.source_type,
              rq.source_reference, rq.required_level, rq.criticality, rq.valid_from, rq.valid_to, rq.version
         FROM osa.requirements rq WHERE rq.id = ANY($1::uuid[])`,
      [gapRows.map((row) => String(row.requirement_id))],
    );
    const evidenceRows = await this.listEvidenceInScopeUnfiltered(evidence.subjectUserId, evidence.skillId);

    const state = workingSet({
      gapCases: gapRows.map(map.toGapCase),
      requirements: requirementRows.map(map.toRequirement),
      evidence: evidenceRows,
    });
    const touchedIds = refreshGapsForEvidence(state, evidence, now);

    for (const gap of state.gapCases) {
      if (!touchedIds.includes(gap.id)) continue;
      // `gap` omitted: generated column.
      await this.db.query(
        "UPDATE osa.gap_cases SET evidenced_level = $2, status = $3, updated_at = now() WHERE id = $1::uuid",
        [gap.id, gap.evidencedLevel, gap.status],
      );
    }
    return touchedIds;
  }

  /** Gap recalculation is a system decision, so it is not narrowed by the actor's self-scope. */
  private async listEvidenceInScopeUnfiltered(subjectUserId: string, skillId: string): Promise<Evidence[]> {
    const { rows } = await this.db.query(
      `SELECT ${EVIDENCE_COLUMNS} FROM osa.evidence e
        WHERE e.subject_user_id = $1::uuid AND e.skill_id = $2::uuid AND e.status = 'verified'`,
      [subjectUserId, skillId],
    );
    return rows.map(map.toEvidence);
  }

  async triageSignal(input: { signalId: Uuid; status: Signal["status"]; linkedStudyId: Uuid | null; dismissedReason: string | null }): Promise<Signal> {
    await this.db.query(
      `UPDATE osa.signals
          SET status = $2, linked_study_id = $3::uuid, dismissed_reason = $4,
              triaged_by_user_id = $5::uuid, triaged_at = now()
        WHERE id = $1::uuid`,
      [toStorageId(input.signalId), input.status, toStorageIdOrNull(input.linkedStudyId),
        input.dismissedReason, this.scope.userId],
    );
    const [signal] = (await this.listSignalsInScope()).filter((item) => item.id === toStorageId(input.signalId));
    if (!signal) throw new Error("Signal not found in tenant after triage");
    return signal;
  }

  /**
   * The sweep's idempotence rests on the partial unique index
   * `notifications_one_open`, not on the sweep reading first.
   *
   * The conflict target repeats the index predicate so PostgreSQL infers the
   * PARTIAL index: an unresolved row for this condition is refreshed in place
   * (id, created_at and read_at survive, so a repeat sweep never un-reads what
   * somebody has already read), while a resolved row does not block a new
   * episode of the same condition from being raised beside it.
   */
  async upsertNotifications(drafts: readonly NotificationDraft[]): Promise<number> {
    let written = 0;
    for (const draft of drafts) {
      const { rowCount } = await this.db.query(
        `INSERT INTO osa.notifications (id, tenant_id, org_unit_id, subject_user_id, kind, severity, title,
                                        body, resource_type, resource_id, due_at, dedupe_key)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::uuid, $11::timestamptz, $12)
         ON CONFLICT (tenant_id, dedupe_key) WHERE resolved_at IS NULL
         DO UPDATE SET kind = excluded.kind, severity = excluded.severity, title = excluded.title,
                       body = excluded.body, due_at = excluded.due_at, org_unit_id = excluded.org_unit_id,
                       subject_user_id = excluded.subject_user_id, resource_type = excluded.resource_type,
                       resource_id = excluded.resource_id`,
        [newId(), this.scope.tenantId, toStorageId(draft.orgUnitId), toStorageId(draft.subjectUserId),
          draft.kind, draft.severity, draft.title, draft.body, draft.resourceType,
          toStorageId(draft.resourceId), draft.dueAt, draft.dedupeKey],
      );
      written += rowCount ?? 0;
    }
    return written;
  }

  /**
   * The hardest operation in the migration.
   *
   * `appendAudit` reads the tenant's last event, then writes a row chained to
   * it. In the JSON store a single-process write queue serialises that
   * read-modify-write. In PostgreSQL, two concurrent appenders at READ
   * COMMITTED both read the same head and both write rows claiming the same
   * `previous_hash` — a forked chain, which `verifyAuditChain` reports as
   * `broken_link` for one of them and which no amount of retrying repairs.
   *
   * A transaction-scoped advisory lock keyed on the tenant serialises appends
   * per tenant, and only per tenant, so one tenant's write rate cannot block
   * another's. The lock is released by COMMIT or ROLLBACK; there is no path
   * that leaks it.
   *
   * Signing happens over the STORAGE-form event: identifiers are mapped to
   * uuids before the HMAC is computed, never after. Signing the legacy form and
   * storing the mapped form would produce a ledger that fails its own
   * verification on the very first read — the subtlest way this migration could
   * have gone wrong.
   */
  async appendAudit(input: AuditInput): Promise<AuditEvent> {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`osa.audit:${this.scope.tenantId}`]);

    const { rows: headRows } = await this.db.query(
      `SELECT a.id, a.tenant_id, a.actor_user_id, a.action, a.resource_type, a.resource_id, a.outcome,
              a.occurred_at, a.request_id, a.metadata, a.previous_hash, a.event_hash
         FROM osa.audit_events a ORDER BY a.sequence DESC LIMIT 1`,
    );
    const head = headRows[0] ? map.toAuditEvent(headRows[0]) : null;

    // Identifiers are mapped to storage form BEFORE the HMAC is computed. See
    // audit-chain.ts for why this cannot simply call audit.ts, and why that is
    // recorded as a defect with a cutover task attached rather than accepted.
    const event: AuditEvent = signAuditEvent(head, {
      tenantId: this.scope.tenantId,
      actorUserId: toStorageIdOrNull(input.actorUserId),
      action: input.action,
      resourceType: input.resourceType,
      resourceId: toStorageIdOrNull(input.resourceId),
      outcome: input.outcome,
      requestId: input.requestId,
      metadata: input.metadata,
    });

    await this.db.query(
      `INSERT INTO osa.audit_events (id, tenant_id, actor_user_id, action, resource_type, resource_id,
                                     outcome, request_id, metadata, occurred_at, previous_hash, event_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9::jsonb, $10::timestamptz, $11, $12)`,
      [event.id, event.tenantId, event.actorUserId, event.action, event.resourceType, event.resourceId,
        event.outcome, event.requestId, JSON.stringify(event.metadata), event.occurredAt,
        map.hashToBytes(event.previousHash), map.hashToBytes(event.hash)],
    );
    return event;
  }
}

/* ---------------------------------------------------------------------------
 * Gateway
 * ------------------------------------------------------------------------- */

export class PostgresPersistence implements OsaPersistence {
  constructor(private readonly pool: Pool) {}

  async findTenantBySlug(slug: string): Promise<Tenant | null> {
    // Runs with no tenant context. `osa.tenants` is the one table 001 leaves
    // outside the RLS array, which is what makes tenant-first login possible;
    // it is a directory, and the grant matrix gives the runtime role SELECT on
    // it and nothing more. See README-migration.md, "osa.tenants has no RLS".
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT id, slug, name, home_region, locale, created_at FROM osa.tenants WHERE slug = $1",
        [slug.trim().toLowerCase()],
      );
      return rows[0] ? map.toTenant(rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async resolveSession(sessionToken: string): Promise<SessionRef | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT tenant_id, user_id, csrf_hash, expires_at FROM osa.resolve_session($1)",
        [sha256(sessionToken)],
      );
      if (!rows[0]) return null;
      return {
        tenantId: String(rows[0].tenant_id),
        userId: String(rows[0].user_id),
        csrfHash: rows[0].csrf_hash as Uint8Array,
        expiresAt: map.iso(rows[0].expires_at),
      };
    } finally {
      client.release();
    }
  }

  read<T>(scope: ActorScope, run: (repo: OsaRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, scope, (client: PoolClient) => run(new PostgresRepository(client, scope)), { readOnly: true });
  }

  write<T>(scope: ActorScope, run: (repo: OsaRepository) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, scope, (client: PoolClient) => run(new PostgresRepository(client, scope)));
  }

  async assertRuntimeRoleIsSafe(): Promise<RuntimeRoleReport> {
    const client = await this.pool.connect();
    try {
      return assertRuntimeRoleIsSafe(await inspectRuntimeRole(client));
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export type CreateOptions = {
  connectionString?: string;
  max?: number;
  /** Skip the ADR-001 role check. Only a migration/test harness should ever pass true. */
  skipRoleCheck?: boolean;
};

/**
 * Returns null — never throws — when the `pg` driver is not installed or no
 * connection string is configured. The JSON store remains the default, so an
 * absent driver is a supported state, not a failure.
 */
export async function createPostgresPersistence(options: CreateOptions = {}): Promise<PostgresPersistence | null> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) return null;
  const pg = await loadPgModule();
  if (!pg) return null;

  const persistence = new PostgresPersistence(new pg.Pool({ connectionString, max: options.max ?? 10 }));
  if (!options.skipRoleCheck) await persistence.assertRuntimeRoleIsSafe();
  return persistence;
}

/**
 * Builds the row-visibility scope from a validated principal.
 *
 * Deliberately takes the already-resolved principal rather than a Request: this
 * is the choke point where "which rows may this actor see" is decided, and
 * nothing reaching it may have come from a payload, a query string or a header.
 */
export function scopeFromPrincipal(principal: {
  tenantId: string;
  user: { id: string; orgUnitId: string };
  delegatedOrgPaths: readonly string[];
  selfOnly: boolean;
  viewerOrgPath: string;
}): ActorScope {
  return {
    tenantId: toStorageId(principal.tenantId),
    userId: toStorageId(principal.user.id),
    orgScopes: [...principal.delegatedOrgPaths],
    viewerOrgPath: principal.viewerOrgPath,
    selfOnly: principal.selfOnly,
  };
}

/** Timing-safe CSRF check against the stored `csrf_hash`; the raw token is not recoverable. */
export function csrfMatches(presented: string | null, csrfHash: Uint8Array): boolean {
  if (!presented) return false;
  const actual = sha256(presented);
  const expected = Buffer.from(csrfHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
