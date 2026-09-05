/**
 * Row <-> domain translation.
 *
 * Every conversion here exists because a column type in `001_initial.sql` and
 * the TypeScript type in `domain.ts` disagree. They are collected in one file
 * so the list of disagreements is countable rather than scattered through the
 * adapter. `database/postgres/README-migration.md` documents each one.
 */

import type {
  AuditEvent, Course, CourseModule, Enrollment, Evidence, GapCase, Intervention,
  JobRole, ModuleCompletion, Notification, OrgUnit, PlatformRole, Requirement,
  Signal, Skill, Tenant, TnaStudy, User,
} from "../domain";
import { ltreeToPath, ltreeToPaths } from "./ids";

export type Row = Record<string, unknown>;

/* ---------------------------------------------------------------------------
 * Scalars
 * ------------------------------------------------------------------------- */

/** `timestamptz` arrives as a JS Date; the domain uses ISO-8601 strings. */
export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new TypeError(`Expected a timestamp, received ${typeof value}`);
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/**
 * `date` columns are selected as `col::text` throughout the adapter.
 *
 * node-postgres parses a bare `date` into a JS Date at LOCAL midnight, so a
 * `due_date` of 2026-09-15 read on a machine west of UTC becomes
 * `2026-09-14T…Z` and the domain's `dueDate: string` silently loses a day.
 * Casting in SQL keeps the calendar date a calendar date.
 */
export function dateText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new TypeError(`Expected a date, received ${typeof value}`);
}

export function dateTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : dateText(value);
}

/**
 * `numeric` columns are selected as `col::float8`.
 *
 * node-postgres returns `numeric` as a STRING, because arbitrary precision does
 * not fit a JS double. `evidence.strength` and `enrollments.score` are 0..1
 * confidence values that the domain types as `number` and that arithmetic like
 * `finalScore < course.passingScore` compares directly — a string there
 * compares lexicographically and silently passes the wrong learners.
 */
export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  throw new TypeError(`Expected a number, received ${typeof value}`);
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function int(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/* ---------------------------------------------------------------------------
 * Audit hashes
 *
 * `audit_events.previous_hash` and `event_hash` are `bytea`. `audit.ts` writes
 * hex strings, and the first event of each tenant chain writes the literal
 * sentinel "GENESIS", which has no hexadecimal reading at all:
 *
 *     ik_osa=# select decode('GENESIS','hex');
 *     ERROR:  invalid hexadecimal digit: "G"
 *
 * The sentinel is encoded as 32 zero bytes — a value the HMAC can never
 * produce, so it stays unambiguous. Crucially the DIGEST is still computed over
 * the domain object carrying the string "GENESIS", so every historical
 * signature verifies unchanged after the migration. The bytea column is a
 * storage encoding, never a hash input.
 * ------------------------------------------------------------------------- */

export const GENESIS = "GENESIS";
const GENESIS_BYTES = Buffer.alloc(32, 0);

export function hashToBytes(hash: string): Buffer {
  if (hash === GENESIS) return GENESIS_BYTES;
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new TypeError("Audit hash must be 64 hex characters or the GENESIS sentinel");
  return Buffer.from(hash, "hex");
}

export function bytesToHash(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  return bytes.equals(GENESIS_BYTES) ? GENESIS : bytes.toString("hex");
}

/* ---------------------------------------------------------------------------
 * Entities
 * ------------------------------------------------------------------------- */

export function toTenant(row: Row): Tenant {
  return {
    id: str(row.id), slug: str(row.slug), name: str(row.name),
    homeRegion: str(row.home_region), locale: str(row.locale), createdAt: iso(row.created_at),
  };
}

/** `path ltree` -> `/a/b`. See ids.ts for why the encodings differ. */
export function toOrgUnit(row: Row): OrgUnit {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), parentId: strOrNull(row.parent_id),
    code: str(row.code), name: str(row.name), path: ltreeToPath(str(row.path)),
  };
}

/**
 * `roles` comes from an aggregate over `osa.user_roles` — the schema normalises
 * what the domain type keeps as an array. `password_hash` is nullable in SQL
 * (SSO users have none) and non-nullable in the domain type; an empty string
 * fails `verifyPassword` closed, which is the correct reading of "no password".
 */
export function toUser(row: Row): User {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    email: str(row.email), displayName: str(row.display_name),
    passwordHash: row.password_hash === null || row.password_hash === undefined ? "" : String(row.password_hash),
    roles: strArray(row.roles) as PlatformRole[],
    delegatedOrgPaths: ltreeToPaths(strArray(row.delegated_org_paths)),
    active: bool(row.active), createdAt: iso(row.created_at),
  };
}

export function toSkill(row: Row): Skill {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), code: str(row.code), name: str(row.name),
    description: str(row.description), scale: "awareness-to-expert",
  };
}

/** SQL splits validity into valid_from/valid_to; the domain keeps effectiveFrom only. */
export function toJobRole(row: Row): JobRole {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    code: str(row.code), title: str(row.title), purpose: str(row.purpose), version: int(row.version),
    status: str(row.status) as JobRole["status"], effectiveFrom: iso(row.valid_from),
  };
}

export function toRequirement(row: Row): Requirement {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    jobRoleId: str(row.job_role_id), skillId: str(row.skill_id),
    sourceType: str(row.source_type) as Requirement["sourceType"], sourceReference: str(row.source_reference),
    requiredLevel: int(row.required_level), criticality: str(row.criticality) as Requirement["criticality"],
    effectiveFrom: iso(row.valid_from), effectiveTo: isoOrNull(row.valid_to), version: int(row.version),
  };
}

export function toStudy(row: Row): TnaStudy {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    title: str(row.title), objective: str(row.objective), status: str(row.status) as TnaStudy["status"],
    ownerUserId: str(row.owner_user_id), targetRoleIds: strArray(row.target_role_ids),
    dueDate: dateText(row.due_date), createdAt: iso(row.created_at),
  };
}

export function toEvidence(row: Row): Evidence {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    subjectUserId: str(row.subject_user_id), skillId: str(row.skill_id),
    type: str(row.evidence_type) as Evidence["type"], proficiencyLevel: int(row.proficiency_level),
    strength: num(row.strength), observedAt: iso(row.observed_at), expiresAt: isoOrNull(row.expires_at),
    assessorUserId: strOrNull(row.assessor_user_id), sourceReference: str(row.source_reference),
    status: str(row.status) as Evidence["status"],
  };
}

export function toGapCase(row: Row): GapCase {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    tnaStudyId: str(row.tna_study_id), subjectUserId: str(row.subject_user_id),
    requirementId: str(row.requirement_id), requiredLevel: int(row.required_level),
    evidencedLevel: int(row.evidenced_level), gap: int(row.gap),
    priority: str(row.priority) as GapCase["priority"], causeHypothesis: str(row.cause_hypothesis),
    status: str(row.status) as GapCase["status"],
  };
}

export function toIntervention(row: Row): Intervention {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    gapCaseId: str(row.gap_case_id), type: str(row.intervention_type) as Intervention["type"],
    title: str(row.title), ownerUserId: str(row.owner_user_id), dueDate: dateText(row.due_date),
    status: str(row.status) as Intervention["status"],
  };
}

export function toCourse(row: Row): Course {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    code: str(row.code), title: str(row.title), description: str(row.description),
    skillId: str(row.skill_id), targetLevel: int(row.target_level),
    evidenceRule: str(row.evidence_rule) as Course["evidenceRule"], passingScore: num(row.passing_score),
    validityMonths: row.validity_months === null || row.validity_months === undefined ? null : int(row.validity_months),
    version: int(row.version), status: str(row.status) as Course["status"], createdAt: iso(row.created_at),
  };
}

export function toCourseModule(row: Row): CourseModule {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), courseId: str(row.course_id),
    position: int(row.position), title: str(row.title), kind: str(row.kind) as CourseModule["kind"],
    durationMinutes: int(row.duration_minutes), required: bool(row.required),
    assessmentId: strOrNull(row.assessment_id),
  };
}

export function toEnrollment(row: Row): Enrollment {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    courseId: str(row.course_id), subjectUserId: str(row.subject_user_id),
    source: str(row.source) as Enrollment["source"], interventionId: strOrNull(row.intervention_id),
    gapCaseId: strOrNull(row.gap_case_id), status: str(row.status) as Enrollment["status"],
    assignedByUserId: strOrNull(row.assigned_by_user_id), dueDate: dateTextOrNull(row.due_date),
    startedAt: isoOrNull(row.started_at), completedAt: isoOrNull(row.completed_at),
    score: numOrNull(row.score), evidenceId: strOrNull(row.evidence_id), createdAt: iso(row.created_at),
  };
}

export function toModuleCompletion(row: Row): ModuleCompletion {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), enrollmentId: str(row.enrollment_id),
    moduleId: str(row.module_id), completedAt: iso(row.completed_at), score: numOrNull(row.score),
  };
}

export function toSignal(row: Row): Signal {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    source: str(row.source) as Signal["source"], sourceReference: str(row.source_reference),
    title: str(row.title), summary: str(row.summary), detectedAt: iso(row.detected_at),
    effectiveAt: isoOrNull(row.effective_at), severity: str(row.severity) as Signal["severity"],
    status: str(row.status) as Signal["status"],
    affectedJobRoleIds: strArray(row.affected_job_role_ids),
    affectedSkillIds: strArray(row.affected_skill_ids),
    linkedStudyId: strOrNull(row.linked_study_id), triagedByUserId: strOrNull(row.triaged_by_user_id),
    triagedAt: isoOrNull(row.triaged_at), dismissedReason: strOrNull(row.dismissed_reason),
  };
}

export function toNotification(row: Row): Notification {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), orgUnitId: str(row.org_unit_id),
    subjectUserId: str(row.subject_user_id), kind: str(row.kind) as Notification["kind"],
    severity: str(row.severity) as Notification["severity"], title: str(row.title), body: str(row.body),
    resourceType: str(row.resource_type), resourceId: str(row.resource_id),
    dueAt: isoOrNull(row.due_at), dedupeKey: str(row.dedupe_key), createdAt: iso(row.created_at),
    readAt: isoOrNull(row.read_at), resolvedAt: isoOrNull(row.resolved_at),
  };
}

/**
 * `metadata jsonb` round-trips as an object. `resource_id uuid NULL` cannot
 * hold what `auth.ts` currently writes for authentication events
 * (`session.id.slice(0, 12)` — twelve characters of a base64url token), so the
 * adapter stores NULL there and preserves the value in metadata; see
 * README-migration.md, "audit_events.resource_id".
 */
export function toAuditEvent(row: Row): AuditEvent {
  return {
    id: str(row.id), tenantId: str(row.tenant_id), actorUserId: strOrNull(row.actor_user_id),
    action: str(row.action), resourceType: str(row.resource_type), resourceId: strOrNull(row.resource_id),
    outcome: str(row.outcome) as AuditEvent["outcome"], occurredAt: iso(row.occurred_at),
    requestId: str(row.request_id),
    metadata: (row.metadata ?? {}) as AuditEvent["metadata"],
    previousHash: bytesToHash(row.previous_hash), hash: bytesToHash(row.event_hash),
  };
}
