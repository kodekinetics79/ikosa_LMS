/**
 * Domain -> row translation: the write direction of `mapping.ts`.
 *
 * `mapping.ts` turns a PostgreSQL row into a domain object. This file turns a
 * domain object into the column/value shape `001_initial.sql` and
 * `002_learning_and_signals.sql` accept, and it exists for one consumer:
 * `scripts/provision-postgres.mjs`, which loads the demo dataset produced by
 * `src/lib/server/seed.ts`. Nothing under `src/app/**` imports it, and nothing
 * should: the application mints its own rows through `postgres.ts`.
 *
 * It is a separate file rather than inline SQL in the script so that every
 * divergence between the TypeScript `Database` type and the schema is stated
 * once, in TypeScript, next to the read direction that has to undo it. The
 * catalogue of divergences is `database/postgres/README-migration.md` §2-§3;
 * the ones that bite a bulk load are:
 *
 *   §2.1 ids are `uuid`         -> `toStorageId` (deterministic uuid v5)
 *   §2.2 `org_units.path` ltree -> `pathToLtree` / `pathsToLtree`
 *   §2.5 `gap_cases.gap` is GENERATED ALWAYS ... STORED -> never emitted
 *   §2.7 `date` drifts a day    -> calendar dates stay text, never a JS Date
 *   §3   columns with no domain source (`recorded_by`, `scale_code`, valid
 *        time) -> supplied by the caller or left to the column DEFAULT
 *
 * Two further rules that only apply on the way in:
 *
 *   * A domain field typed `string` may hold either a full ISO instant
 *     ("2026-08-01T12:00:00.000Z") or a bare calendar date ("2026-01-01").
 *     Where the column is `timestamptz`, a bare date is anchored at UTC
 *     midnight by `utcInstant` rather than handed to PostgreSQL uninterpreted,
 *     which would resolve it against the session's TimeZone and make the load
 *     non-reproducible across machines.
 *   * No function here emits `id` for a row PostgreSQL generates, and none
 *     emits a generated column. What is absent from a row object is absent
 *     from the INSERT.
 */

import type {
  Course, CourseModule, Enrollment, Evidence, GapCase, Intervention, JobRole,
  ModuleCompletion, Notification, OrgUnit, Requirement, Signal, Skill, Tenant,
  TnaStudy, User,
} from "../domain";
import { pathToLtree, pathsToLtree, toStorageId, toStorageIdOrNull } from "./ids";

/** Column name -> value. Keys are emitted verbatim as an INSERT column list. */
export type StorageRow = Record<string, unknown>;

/* ---------------------------------------------------------------------------
 * Scalars
 * ------------------------------------------------------------------------- */

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A value bound for a `timestamptz` column.
 *
 * `JobRole.effectiveFrom`, `Requirement.effectiveFrom` and `Signal.effectiveAt`
 * are calendar dates in the domain and `timestamptz` in the schema. Passing
 * "2026-01-01" straight through makes the stored instant a function of the
 * session's TimeZone, so the same script run in two places writes two different
 * rows. Anchoring at UTC midnight makes the load reproducible, which is what
 * makes re-running it a no-op.
 */
export function utcInstant(value: string): string {
  return CALENDAR_DATE.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function utcInstantOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : utcInstant(value);
}

/**
 * A value bound for a `date` column, kept as text.
 *
 * The mirror of `mapping.ts::dateText`. That function exists because
 * node-postgres parses a bare `date` into a JS Date at LOCAL midnight; the same
 * hazard runs in reverse, so a calendar date is never converted to a Date on
 * the way in either. `date` is inferred from the target column, so a string is
 * bound and parsed by PostgreSQL exactly as written.
 */
export function calendarDate(value: string): string {
  return CALENDAR_DATE.test(value) ? value : value.slice(0, 10);
}

export function calendarDateOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : calendarDate(value);
}

/* ---------------------------------------------------------------------------
 * 001_initial.sql
 * ------------------------------------------------------------------------- */

/** `osa.tenants` — the one table in the schema with no RLS policy. */
export function fromTenant(tenant: Tenant): StorageRow {
  return {
    id: toStorageId(tenant.id),
    slug: tenant.slug,
    name: tenant.name,
    home_region: tenant.homeRegion,
    locale: tenant.locale,
    created_at: tenant.createdAt,
  };
}

/**
 * `osa.org_units` — `path` is `ltree`, so `/org_ns/org_ns_ops` becomes
 * `<uuid(org_ns)>.<uuid(org_ns_ops)>`. `parent_id` is a self-reference, so
 * these rows must be inserted shallowest-first.
 */
export function fromOrgUnit(unit: OrgUnit): StorageRow {
  return {
    id: toStorageId(unit.id),
    tenant_id: toStorageId(unit.tenantId),
    parent_id: toStorageIdOrNull(unit.parentId),
    code: unit.code,
    name: unit.name,
    path: pathToLtree(unit.path),
  };
}

/**
 * `osa.users` — `password_hash` is written verbatim. `security.ts::hashPassword`
 * produces `scrypt$<salt>$<derived>`; re-deriving or normalising it would leave
 * `verifyPassword` unable to match and nobody able to sign in.
 *
 * `roles` lives in `osa.user_roles`; see `fromUserRoles`.
 */
export function fromUser(user: User): StorageRow {
  return {
    id: toStorageId(user.id),
    tenant_id: toStorageId(user.tenantId),
    org_unit_id: toStorageId(user.orgUnitId),
    email: user.email,
    display_name: user.displayName,
    password_hash: user.passwordHash,
    active: user.active,
    delegated_org_paths: pathsToLtree(user.delegatedOrgPaths),
    created_at: user.createdAt,
  };
}

/** `osa.user_roles` — the normalised form of `User.roles`. */
export function fromUserRoles(user: User): StorageRow[] {
  return user.roles.map((role) => ({
    tenant_id: toStorageId(user.tenantId),
    user_id: toStorageId(user.id),
    role_code: role,
  }));
}

/**
 * `osa.skills` — SQL calls the scale `scale_code`. `status` and `version` have
 * no domain source and are left to their DEFAULTs (`'active'`, `1`), which is
 * what `mapping.ts::toSkill` assumes when it reads them back.
 */
export function fromSkill(skill: Skill): StorageRow {
  return {
    id: toStorageId(skill.id),
    tenant_id: toStorageId(skill.tenantId),
    code: skill.code,
    name: skill.name,
    description: skill.description,
    scale_code: skill.scale,
  };
}

/**
 * `osa.job_roles` — SQL splits validity into `valid_from`/`valid_to`; the
 * domain keeps `effectiveFrom` only, and `mapping.ts::toJobRole` reads
 * `valid_from` back into it.
 *
 * `recorded_by` is `NOT NULL` with a foreign key to `osa.users` and has no
 * domain source at all (README-migration.md §3). The caller supplies it, so the
 * choice of author is made once, visibly, by the provisioning script rather
 * than invented here.
 */
export function fromJobRole(role: JobRole, recordedBy: string): StorageRow {
  return {
    id: toStorageId(role.id),
    tenant_id: toStorageId(role.tenantId),
    org_unit_id: toStorageId(role.orgUnitId),
    code: role.code,
    title: role.title,
    purpose: role.purpose,
    version: role.version,
    status: role.status,
    valid_from: utcInstant(role.effectiveFrom),
    recorded_by: toStorageId(recordedBy),
  };
}

/** `osa.requirements` — same valid-time split and same `recorded_by` gap. */
export function fromRequirement(requirement: Requirement, recordedBy: string): StorageRow {
  return {
    id: toStorageId(requirement.id),
    tenant_id: toStorageId(requirement.tenantId),
    org_unit_id: toStorageId(requirement.orgUnitId),
    job_role_id: toStorageId(requirement.jobRoleId),
    skill_id: toStorageId(requirement.skillId),
    source_type: requirement.sourceType,
    source_reference: requirement.sourceReference,
    required_level: requirement.requiredLevel,
    criticality: requirement.criticality,
    version: requirement.version,
    valid_from: utcInstant(requirement.effectiveFrom),
    valid_to: utcInstantOrNull(requirement.effectiveTo),
    recorded_by: toStorageId(recordedBy),
  };
}

/** `osa.tna_studies` — `due_date` is a `date` column and stays text. */
export function fromStudy(study: TnaStudy): StorageRow {
  return {
    id: toStorageId(study.id),
    tenant_id: toStorageId(study.tenantId),
    org_unit_id: toStorageId(study.orgUnitId),
    title: study.title,
    objective: study.objective,
    status: study.status,
    owner_user_id: toStorageId(study.ownerUserId),
    due_date: calendarDate(study.dueDate),
    created_at: study.createdAt,
  };
}

/** `osa.tna_target_roles` — the normalised form of `TnaStudy.targetRoleIds`. */
export function fromStudyTargetRoles(study: TnaStudy): StorageRow[] {
  return study.targetRoleIds.map((roleId) => ({
    tenant_id: toStorageId(study.tenantId),
    tna_study_id: toStorageId(study.id),
    job_role_id: toStorageId(roleId),
  }));
}

/**
 * `osa.evidence` — `strength` is `numeric(4,3)`. A JS number is bound and
 * PostgreSQL parses it; the string-on-the-way-out hazard `mapping.ts::num`
 * handles does not exist in this direction.
 */
export function fromEvidence(evidence: Evidence): StorageRow {
  return {
    id: toStorageId(evidence.id),
    tenant_id: toStorageId(evidence.tenantId),
    org_unit_id: toStorageId(evidence.orgUnitId),
    subject_user_id: toStorageId(evidence.subjectUserId),
    skill_id: toStorageId(evidence.skillId),
    evidence_type: evidence.type,
    proficiency_level: evidence.proficiencyLevel,
    strength: evidence.strength,
    observed_at: utcInstant(evidence.observedAt),
    expires_at: utcInstantOrNull(evidence.expiresAt),
    assessor_user_id: toStorageIdOrNull(evidence.assessorUserId),
    source_reference: evidence.sourceReference,
    status: evidence.status,
  };
}

/**
 * `osa.gap_cases` — `gap` is `GENERATED ALWAYS AS (greatest(required_level -
 * evidenced_level, 0)) STORED`, so it is deliberately absent from this row:
 *
 *     ERROR: cannot insert a non-DEFAULT value into column "gap"
 *
 * `GapCase.gap` from the seed is therefore discarded on the way in and
 * recomputed by the database. Asserting that the recomputed value equals the
 * seed's is one of the provisioning script's verification steps.
 */
export function fromGapCase(gapCase: GapCase): StorageRow {
  return {
    id: toStorageId(gapCase.id),
    tenant_id: toStorageId(gapCase.tenantId),
    org_unit_id: toStorageId(gapCase.orgUnitId),
    tna_study_id: toStorageId(gapCase.tnaStudyId),
    subject_user_id: toStorageId(gapCase.subjectUserId),
    requirement_id: toStorageId(gapCase.requirementId),
    required_level: gapCase.requiredLevel,
    evidenced_level: gapCase.evidencedLevel,
    priority: gapCase.priority,
    cause_hypothesis: gapCase.causeHypothesis,
    status: gapCase.status,
  };
}

/** `osa.interventions` — `due_date` is a `date` column. */
export function fromIntervention(intervention: Intervention): StorageRow {
  return {
    id: toStorageId(intervention.id),
    tenant_id: toStorageId(intervention.tenantId),
    org_unit_id: toStorageId(intervention.orgUnitId),
    gap_case_id: toStorageId(intervention.gapCaseId),
    intervention_type: intervention.type,
    title: intervention.title,
    owner_user_id: toStorageId(intervention.ownerUserId),
    due_date: calendarDate(intervention.dueDate),
    status: intervention.status,
  };
}

/* ---------------------------------------------------------------------------
 * 002_learning_and_signals.sql
 * ------------------------------------------------------------------------- */

/**
 * `osa.courses` — `status` is a CHECK, not `osa.record_status`, precisely
 * because `Course.status` includes `published` and that enum does not
 * (README-migration.md §2.9). `recorded_by` is left NULL: 002 declares it
 * nullable because the application captures no course author, and inventing one
 * for the demo dataset would make an absent fact look recorded.
 */
export function fromCourse(course: Course): StorageRow {
  return {
    id: toStorageId(course.id),
    tenant_id: toStorageId(course.tenantId),
    org_unit_id: toStorageId(course.orgUnitId),
    code: course.code,
    title: course.title,
    description: course.description,
    skill_id: toStorageId(course.skillId),
    target_level: course.targetLevel,
    evidence_rule: course.evidenceRule,
    passing_score: course.passingScore,
    validity_months: course.validityMonths,
    version: course.version,
    status: course.status,
    created_at: course.createdAt,
  };
}

export function fromCourseModule(module: CourseModule): StorageRow {
  return {
    id: toStorageId(module.id),
    tenant_id: toStorageId(module.tenantId),
    course_id: toStorageId(module.courseId),
    position: module.position,
    title: module.title,
    kind: module.kind,
    duration_minutes: module.durationMinutes,
    required: module.required,
  };
}

export function fromEnrollment(enrollment: Enrollment): StorageRow {
  return {
    id: toStorageId(enrollment.id),
    tenant_id: toStorageId(enrollment.tenantId),
    org_unit_id: toStorageId(enrollment.orgUnitId),
    course_id: toStorageId(enrollment.courseId),
    subject_user_id: toStorageId(enrollment.subjectUserId),
    source: enrollment.source,
    intervention_id: toStorageIdOrNull(enrollment.interventionId),
    gap_case_id: toStorageIdOrNull(enrollment.gapCaseId),
    status: enrollment.status,
    assigned_by_user_id: toStorageIdOrNull(enrollment.assignedByUserId),
    due_date: calendarDateOrNull(enrollment.dueDate),
    started_at: utcInstantOrNull(enrollment.startedAt),
    completed_at: utcInstantOrNull(enrollment.completedAt),
    score: enrollment.score,
    evidence_id: toStorageIdOrNull(enrollment.evidenceId),
    created_at: enrollment.createdAt,
  };
}

/**
 * `osa.module_completions` — `course_id` is denormalised onto the table so the
 * two composite foreign keys can prove that the completed module and the
 * enrollment agree on the same course. It has no domain field, so the caller
 * resolves it from the enrollment.
 */
export function fromModuleCompletion(completion: ModuleCompletion, courseId: string): StorageRow {
  return {
    id: toStorageId(completion.id),
    tenant_id: toStorageId(completion.tenantId),
    enrollment_id: toStorageId(completion.enrollmentId),
    module_id: toStorageId(completion.moduleId),
    course_id: toStorageId(courseId),
    completed_at: utcInstant(completion.completedAt),
    score: completion.score,
  };
}

/**
 * `osa.signals` — `severity` is the `osa.severity` enum, the one vocabulary
 * shared by signals and notifications. `effective_at` is `timestamptz` while
 * `Signal.effectiveAt` carries a calendar date, so it is anchored at UTC
 * midnight; `mapping.ts::toSignal` reads it back as a full ISO instant.
 */
export function fromSignal(signal: Signal): StorageRow {
  return {
    id: toStorageId(signal.id),
    tenant_id: toStorageId(signal.tenantId),
    org_unit_id: toStorageId(signal.orgUnitId),
    source: signal.source,
    source_reference: signal.sourceReference,
    title: signal.title,
    summary: signal.summary,
    detected_at: utcInstant(signal.detectedAt),
    effective_at: utcInstantOrNull(signal.effectiveAt),
    severity: signal.severity,
    status: signal.status,
    linked_study_id: toStorageIdOrNull(signal.linkedStudyId),
    triaged_by_user_id: toStorageIdOrNull(signal.triagedByUserId),
    triaged_at: utcInstantOrNull(signal.triagedAt),
    dismissed_reason: signal.dismissedReason,
  };
}

/** `osa.signal_job_roles` — the normalised form of `Signal.affectedJobRoleIds`. */
export function fromSignalJobRoles(signal: Signal): StorageRow[] {
  return signal.affectedJobRoleIds.map((jobRoleId) => ({
    tenant_id: toStorageId(signal.tenantId),
    signal_id: toStorageId(signal.id),
    job_role_id: toStorageId(jobRoleId),
  }));
}

/** `osa.signal_skills` — the normalised form of `Signal.affectedSkillIds`. */
export function fromSignalSkills(signal: Signal): StorageRow[] {
  return signal.affectedSkillIds.map((skillId) => ({
    tenant_id: toStorageId(signal.tenantId),
    signal_id: toStorageId(signal.id),
    skill_id: toStorageId(skillId),
  }));
}

/**
 * `osa.notifications` — included for completeness of the write direction. The
 * seed carries none: notifications are DERIVED by `sweepNotifications()` from
 * the state this script loads, and pre-writing them would put rows on file that
 * no condition raised.
 */
export function fromNotification(notification: Notification): StorageRow {
  return {
    id: toStorageId(notification.id),
    tenant_id: toStorageId(notification.tenantId),
    org_unit_id: toStorageId(notification.orgUnitId),
    subject_user_id: toStorageId(notification.subjectUserId),
    kind: notification.kind,
    severity: notification.severity,
    title: notification.title,
    body: notification.body,
    resource_type: notification.resourceType,
    resource_id: toStorageId(notification.resourceId),
    due_at: utcInstantOrNull(notification.dueAt),
    dedupe_key: notification.dedupeKey,
    created_at: notification.createdAt,
    read_at: utcInstantOrNull(notification.readAt),
    resolved_at: utcInstantOrNull(notification.resolvedAt),
  };
}
