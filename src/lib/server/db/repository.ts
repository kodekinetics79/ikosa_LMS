/**
 * The persistence contract, derived from what the application actually asks of
 * a datastore today — not from the shape of `Database`.
 *
 * WHY THIS IS NOT `readDatabase()`
 * --------------------------------
 * `store.readDatabase()` returns the entire database and every caller filters
 * it in memory. That is not an incidental style choice; it is load-bearing in
 * a way that makes a literal port catastrophic:
 *
 *   * `visibleRows()` calls `assertScoped()` per row, and `assertScoped()` calls
 *     `orgFor()`, which is a linear scan of `orgUnits`. `GET /api/evidence` is
 *     therefore O(evidence × orgUnits) *after* having already read and parsed
 *     every row of every table. At the stated 200k evidence rows this is the
 *     4 req/s ceiling.
 *   * `appendAudit()` scans the whole audit table to find the tenant's last
 *     event, on every mutation, so audit cost grows with audit history.
 *   * `refreshGapsForEvidence()` walks `gapCases`, then `requirements`, then
 *     `evidence` for each gap: three nested scans per module completion.
 *   * `GET /api/gaps` resolves the requirement, subject and interventions for
 *     each gap with `.find()` / `.filter()`: a textbook N+1 that happens to be
 *     invisible because the "N queries" are array scans.
 *
 * A naive port turns each of those into a `SELECT *` and a client-side filter:
 * the same full table scan, now with network round trips and no index. So the
 * interface below is deliberately *query-shaped*. Every method:
 *
 *   1. takes an `ActorScope` and pushes tenant, delegated-org and self-scope
 *      into the SQL predicate, where an index can serve it;
 *   2. returns exactly the rows the caller will render, already joined, so the
 *      route has nothing left to filter;
 *   3. never exposes a "give me everything" escape hatch.
 *
 * The authorization decision does NOT move into the database. `authorize()`
 * stays the single source of truth for *whether an action is permitted*; the
 * scope predicates here decide *which rows the query is allowed to consider*.
 * RLS is the third layer, and the only one that still holds when a predicate
 * here is forgotten.
 */

import type {
  AuditEvent, Course, CourseModule, Enrollment, Evidence, GapCase, Intervention,
  JobRole, ModuleCompletion, Notification, OrgUnit, PlatformRole, Requirement,
  Signal, Skill, Tenant, TnaStudy, User,
} from "../domain";

/** A uuid. After cutover every identifier in the system is one. */
export type Uuid = string;

/**
 * The row-visibility scope of one authenticated principal.
 *
 * Built once, from the validated session, by `scopeFromPrincipal()`. Nothing
 * here may originate in a request payload, a query parameter or a header.
 */
export type ActorScope = {
  tenantId: Uuid;
  userId: Uuid;
  /**
   * Delegated organizational roots, as ltree paths. A row is in scope when its
   * org unit sits at or below one of these (`path <@ ANY(orgScopes)`), which is
   * the indexable form of `isOrgInScope()`'s `startsWith` test.
   */
  orgScopes: readonly string[];
  /** The viewer's own org unit path; drives catalogue inheritance upward. */
  viewerOrgPath: string;
  /**
   * True when the principal holds no role that legitimately grants sight of
   * other people (`isSelfScopedOnly()`). Adds `subject_user_id = userId`.
   */
  selfOnly: boolean;
};

/** What a session cookie resolves to, before any tenant context exists. */
export type SessionRef = {
  tenantId: Uuid;
  userId: Uuid;
  /**
   * SHA-256 of the CSRF token. The schema stores `csrf_hash bytea`, so the raw
   * token is not recoverable — `assertCsrf` must compare a presented token
   * against this hash rather than reading the token back. See
   * README-migration.md, "CSRF tokens are not readable".
   */
  csrfHash: Uint8Array;
  expiresAt: string;
};

export type PrincipalRecord = {
  user: User;
  roles: PlatformRole[];
  delegatedOrgPaths: string[];
};

export type ReadinessSummary = {
  studies: number;
  openGaps: number;
  criticalGaps: number;
  verifiedEvidence: number;
  activeInterventions: number;
  readinessPercent: number;
};

export type GapCaseWithContext = GapCase & {
  requirement: Requirement | null;
  subject: { id: Uuid; displayName: string } | null;
  interventions: Intervention[];
};

export type CourseWithModules = Course & {
  modules: CourseModule[];
  moduleCount: number;
  durationMinutes: number;
};

export type EnrollmentWithProgress = Enrollment & {
  course: Pick<Course, "id" | "code" | "title" | "evidenceRule" | "targetLevel" | "skillId"> | null;
  modules: CourseModule[];
  completedModuleIds: Uuid[];
  progress: { completed: number; total: number; percent: number };
};

export type CompletionResult = {
  enrollment: Enrollment;
  evidence: Evidence | null;
  evidenceWithheldReason: "not_complete" | "attendance_only" | "assessment_not_passed" | "already_complete" | null;
  completedModuleIds: Uuid[];
  outstandingModuleIds: Uuid[];
  /** Gap cases whose evidenced level was recomputed, in the same transaction. */
  gapCasesRecalculated: Uuid[];
};

export type AuditInput = Pick<AuditEvent, "actorUserId" | "action" | "resourceType" | "resourceId" | "outcome" | "requestId"> & {
  metadata?: AuditEvent["metadata"];
};

export type NotificationDraft = Omit<Notification, "id" | "createdAt" | "readAt" | "resolvedAt">;

export type EvidenceDraft = Omit<Evidence, "id">;
export type StudyDraft = Omit<TnaStudy, "id" | "createdAt">;
export type InterventionDraft = Omit<Intervention, "id">;
export type CourseDraft = Omit<Course, "id" | "createdAt">;
export type EnrollmentDraft = Omit<Enrollment, "id" | "createdAt" | "startedAt" | "completedAt" | "score" | "evidenceId" | "status">;

/**
 * Everything reachable once a tenant context is established.
 *
 * Every method on this interface runs inside a transaction that has already
 * executed `set_config('app.tenant_id', …, true)` and
 * `set_config('app.user_id', …, true)`. Instances are therefore transaction-
 * scoped and must never be cached across requests.
 */
export interface OsaRepository {
  /* ---- identity ------------------------------------------------------- */

  /** Login step 2. Step 1 (`slug -> tenantId`) happens outside any tenant context. */
  findUserByEmail(email: string): Promise<User | null>;
  loadPrincipal(userId: Uuid): Promise<PrincipalRecord | null>;
  createSession(input: { sessionToken: string; csrfToken: string; expiresAt: string }): Promise<void>;
  /** Logout. Also used to evict a user's prior sessions at login. */
  deleteSession(sessionToken: string): Promise<void>;
  deleteSessionsForUser(userId: Uuid): Promise<void>;

  /* ---- reads ---------------------------------------------------------- */

  tenant(): Promise<Tenant | null>;
  listOrgUnitsInScope(): Promise<OrgUnit[]>;
  listSkills(): Promise<Skill[]>;
  listJobRolesInScope(): Promise<JobRole[]>;
  listRequirementsInScope(): Promise<Requirement[]>;
  listStudiesInScope(): Promise<TnaStudy[]>;
  listEvidenceInScope(filter?: { status?: Evidence["status"]; subjectUserId?: Uuid; skillId?: Uuid }): Promise<Evidence[]>;
  /** Replaces the four-array N+1 in `GET /api/gaps` with one join. */
  listGapCasesWithContext(): Promise<GapCaseWithContext[]>;
  listInterventionsInScope(): Promise<Intervention[]>;
  /**
   * Catalogue visibility runs in the opposite direction to record visibility:
   * a course published at Field Operations is meant to be taken by the crews
   * beneath it. Expressed as `path <@ ANY(scopes) OR path @> viewerPath`.
   */
  listAvailableCourses(): Promise<CourseWithModules[]>;
  listEnrollmentsWithProgress(): Promise<EnrollmentWithProgress[]>;
  listSignalsInScope(): Promise<Signal[]>;
  listOpenNotifications(): Promise<Notification[]>;
  /**
   * The current tenant's rows in the shape the application already reads.
   *
   * A transitional read used by `store.ts::readDatabase` so pages and routes
   * could keep their existing filtering while the datastore changed underneath
   * them. Prefer the scoped queries above for anything on a hot path.
   */
  loadSnapshot(): Promise<import("../domain").Database>;

  /** One aggregate query, not five in-memory passes over the whole database. */
  readinessSummary(): Promise<ReadinessSummary>;
  listAuditEvents(limit: number): Promise<AuditEvent[]>;
  /**
   * The tenant's chain in `sequence` order — the only total order the chain can
   * trust. Batched, because verification must not require the whole ledger in
   * memory.
   */
  auditChainPage(afterSequence: bigint | null, batchSize: number): Promise<Array<AuditEvent & { sequence: bigint }>>;

  /* ---- writes --------------------------------------------------------- */

  insertStudy(draft: StudyDraft): Promise<TnaStudy>;
  insertEvidence(draft: EvidenceDraft): Promise<Evidence>;
  insertIntervention(draft: InterventionDraft): Promise<Intervention>;
  /** `status = 'actioned'` where the gap is still open. Idempotent. */
  markGapActioned(gapCaseId: Uuid): Promise<void>;
  insertCourse(draft: CourseDraft): Promise<Course>;
  findActiveEnrollment(courseId: Uuid, subjectUserId: Uuid): Promise<Enrollment | null>;
  insertEnrollment(draft: EnrollmentDraft): Promise<Enrollment>;
  /**
   * The whole of `recordModuleCompletion` + `refreshGapsForEvidence`, in one
   * transaction: the completion, the evidence decision, the gap recalculation
   * and the audit entry either all land or none do.
   */
  completeModule(input: { enrollmentId: Uuid; moduleId: Uuid; score: number | null; now?: Date }): Promise<CompletionResult>;
  triageSignal(input: { signalId: Uuid; status: Signal["status"]; linkedStudyId: Uuid | null; dismissedReason: string | null }): Promise<Signal>;
  /** Upsert on `(tenant_id, dedupe_key)`, which is what makes the sweep idempotent. */
  upsertNotifications(drafts: readonly NotificationDraft[]): Promise<number>;
  /**
   * Appends to the tenant's hash chain.
   *
   * Takes a transaction-scoped advisory lock on the tenant before reading the
   * chain head. Without it, two concurrent appenders read the same
   * `previous_hash` and fork the chain — a failure the single-process JSON
   * write queue hides completely, and the single hardest part of this migration.
   */
  appendAudit(input: AuditInput): Promise<AuditEvent>;
}

/**
 * The gateway. Owns the pool and the transaction boundary; hands out a
 * transaction-scoped `OsaRepository`.
 */
export interface OsaPersistence {
  /** Tenant lookup by slug. Runs with no tenant context: `osa.tenants` carries no RLS. */
  findTenantBySlug(slug: string): Promise<Tenant | null>;
  /**
   * Session cookie -> tenant. The one operation that genuinely cannot be
   * tenant-scoped first, and the only RLS escape in the system: a single
   * STABLE `SECURITY DEFINER` function owned by a NOLOGIN role
   * (`osa.resolve_session`, migration 002 §6).
   */
  resolveSession(sessionToken: string): Promise<SessionRef | null>;
  /** READ ONLY transaction. Use for every GET. */
  read<T>(scope: ActorScope, run: (repo: OsaRepository) => Promise<T>): Promise<T>;
  /** Read-write transaction. */
  write<T>(scope: ActorScope, run: (repo: OsaRepository) => Promise<T>): Promise<T>;
  /**
   * Asserts the connected role satisfies ADR-001: no BYPASSRLS, not a
   * superuser, owns no table in `osa`. Called once at pool creation; a failure
   * is fatal, not a warning.
   */
  assertRuntimeRoleIsSafe(): Promise<{ role: string; bypassRls: boolean; superuser: boolean; ownedTables: number }>;
  close(): Promise<void>;
}
