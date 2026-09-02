export type Id = string;

export type Tenant = {
  id: Id;
  slug: string;
  name: string;
  homeRegion: string;
  locale: string;
  createdAt: string;
};

export type OrgUnit = {
  id: Id;
  tenantId: Id;
  parentId: Id | null;
  code: string;
  name: string;
  path: string;
};

export type PlatformRole =
  | "tenant_admin"
  | "tna_analyst"
  | "manager"
  | "assessor"
  | "learner"
  | "auditor";

export type User = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  email: string;
  displayName: string;
  passwordHash: string;
  roles: PlatformRole[];
  delegatedOrgPaths: string[];
  active: boolean;
  createdAt: string;
};

export type Session = {
  id: Id;
  userId: Id;
  tenantId: Id;
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
};

export type JobRole = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  code: string;
  title: string;
  purpose: string;
  version: number;
  status: "draft" | "active" | "retired";
  effectiveFrom: string;
};

export type Skill = {
  id: Id;
  tenantId: Id;
  code: string;
  name: string;
  description: string;
  scale: "awareness-to-expert";
};

export type Requirement = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  jobRoleId: Id;
  skillId: Id;
  sourceType: "policy" | "regulation" | "risk" | "strategy" | "incident";
  sourceReference: string;
  requiredLevel: number;
  criticality: "standard" | "important" | "mandatory";
  effectiveFrom: string;
  effectiveTo: string | null;
  version: number;
};

export type TnaStudy = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  title: string;
  objective: string;
  status: "draft" | "collecting" | "analysis" | "approved";
  ownerUserId: Id;
  targetRoleIds: Id[];
  dueDate: string;
  createdAt: string;
};

export type Evidence = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  subjectUserId: Id;
  skillId: Id;
  type: "assessment" | "observation" | "work_product" | "credential";
  proficiencyLevel: number;
  strength: number;
  observedAt: string;
  expiresAt: string | null;
  assessorUserId: Id | null;
  sourceReference: string;
  status: "pending" | "verified" | "revoked";
};

export type GapCase = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  tnaStudyId: Id;
  subjectUserId: Id;
  requirementId: Id;
  requiredLevel: number;
  evidencedLevel: number;
  gap: number;
  priority: "low" | "medium" | "high" | "critical";
  causeHypothesis: string;
  status: "open" | "triaged" | "actioned" | "verified";
};

export type Intervention = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  gapCaseId: Id;
  type: "learning" | "coaching" | "job_aid" | "process" | "tooling" | "staffing";
  title: string;
  ownerUserId: Id;
  dueDate: string;
  status: "planned" | "active" | "completed" | "verified";
};

export type AuditEvent = {
  id: Id;
  tenantId: Id;
  actorUserId: Id | null;
  action: string;
  resourceType: string;
  resourceId: Id | null;
  outcome: "allowed" | "denied" | "success" | "failure";
  occurredAt: string;
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
  previousHash: string;
  hash: string;
};


/* ---------------------------------------------------------------------------
 * Learning delivery.
 *
 * The LMS is the fulfilment engine for an Intervention, not a parallel product.
 * A Course develops one Skill; completing it can produce Evidence against that
 * Skill, which is what closes a GapCase. Evidence remains the single authority
 * on capability - an Enrollment only ever records learning progress.
 * ------------------------------------------------------------------------- */

export type Course = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  code: string;
  title: string;
  description: string;
  /** The capability this course develops. Evidence is emitted against it. */
  skillId: Id;
  /** Proficiency level a successful completion can attest to (0-5). */
  targetLevel: number;
  /**
   * Whether completion may produce competence evidence at all.
   * `attendance_only` courses record completion but emit no Evidence: a viewed
   * lesson is not proof that someone can perform the work, and manufacturing
   * evidence from it would silently corrupt every downstream readiness number.
   */
  evidenceRule: "assessed" | "attendance_only";
  /** Minimum normalized assessment score (0-1) required to pass. */
  passingScore: number;
  /** Months an emitted Evidence record stays valid; null means no expiry. */
  validityMonths: number | null;
  version: number;
  status: "draft" | "published" | "retired";
  createdAt: string;
};

export type CourseModule = {
  id: Id;
  tenantId: Id;
  courseId: Id;
  position: number;
  title: string;
  kind: "lesson" | "document" | "video" | "scorm" | "assessment";
  durationMinutes: number;
  required: boolean;
};

export type Enrollment = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  courseId: Id;
  /** Named subjectUserId so the existing tenant/org/self scoping helpers apply unchanged. */
  subjectUserId: Id;
  source: "self" | "assigned" | "intervention";
  /** Junction back to the assurance spine. Set when learning fulfils an intervention. */
  interventionId: Id | null;
  gapCaseId: Id | null;
  status: "enrolled" | "in_progress" | "completed" | "withdrawn";
  assignedByUserId: Id | null;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Normalized final assessment score (0-1); null for attendance-only courses. */
  score: number | null;
  /** The Evidence this completion produced, when it produced any. */
  evidenceId: Id | null;
  createdAt: string;
};

export type ModuleCompletion = {
  id: Id;
  tenantId: Id;
  enrollmentId: Id;
  moduleId: Id;
  completedAt: string;
  score: number | null;
};


/* ---------------------------------------------------------------------------
 * Change signals.
 *
 * The front of the continuous-TNA funnel. A Signal is an external or internal
 * change that may alter what the workforce must be able to do: a regulation, an
 * incident, an audit finding, a process change. Triage either links it to a TNA
 * study or dismisses it with a stated reason - a signal is never silently
 * dropped, because "nobody looked at it" is the failure this product exists to
 * prevent.
 * ------------------------------------------------------------------------- */

export type Signal = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  source: "regulation" | "policy" | "incident" | "audit" | "workforce" | "performance";
  sourceReference: string;
  title: string;
  summary: string;
  detectedAt: string;
  /** When the change starts to bite. Drives triage urgency. */
  effectiveAt: string | null;
  severity: "critical" | "high" | "medium" | "low";
  status: "new" | "triaged" | "linked" | "dismissed";
  affectedJobRoleIds: Id[];
  affectedSkillIds: Id[];
  /** Set when triage converts the signal into a study. */
  linkedStudyId: Id | null;
  triagedByUserId: Id | null;
  triagedAt: string | null;
  dismissedReason: string | null;
};

/* ---------------------------------------------------------------------------
 * Notifications.
 *
 * A compliance platform is largely a chasing machine: evidence expires,
 * enrollments fall due, gaps go unowned. These are DERIVED from state by an
 * idempotent sweep rather than written ad hoc, so the same condition can never
 * raise two rows and a missed sweep never loses one.
 * ------------------------------------------------------------------------- */

export type Notification = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  /** The person who needs to act. */
  subjectUserId: Id;
  kind:
    | "evidence_expiring"
    | "evidence_expired"
    | "enrollment_due"
    | "enrollment_overdue"
    | "signal_untriaged"
    | "intervention_overdue";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  resourceType: string;
  resourceId: Id;
  dueAt: string | null;
  /**
   * Stable identity for the underlying condition. The sweep upserts on this, so
   * running it twice - or twice a minute - cannot duplicate a reminder.
   */
  dedupeKey: string;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
};

export type Database = {
  schemaVersion: 2;
  tenants: Tenant[];
  orgUnits: OrgUnit[];
  users: User[];
  sessions: Session[];
  jobRoles: JobRole[];
  skills: Skill[];
  requirements: Requirement[];
  tnaStudies: TnaStudy[];
  evidence: Evidence[];
  gapCases: GapCase[];
  interventions: Intervention[];
  courses: Course[];
  courseModules: CourseModule[];
  enrollments: Enrollment[];
  moduleCompletions: ModuleCompletion[];
  signals: Signal[];
  notifications: Notification[];
  auditEvents: AuditEvent[];
};

export type PublicUser = Omit<User, "passwordHash">;

export function withoutSecrets(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}
