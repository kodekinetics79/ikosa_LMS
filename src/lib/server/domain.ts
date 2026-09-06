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

export type Course = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  code: string;
  title: string;
  description: string;
  skillId: Id;
  targetLevel: number;
  evidenceRule: "assessed" | "attendance_only";
  passingScore: number;
  validityMonths: number | null;
  version: number;
  status: "draft" | "published" | "retired";
  createdAt: string;
  /**
   * Who may FIND this course, which is a separate question from who may be
   * enrolled on it. 'organization' is the rule the rest of the product already
   * uses for delivery (owned at or above the viewer's org); 'tenant' widens it
   * to everyone in the tenant; 'listed' additionally marks the course as
   * offered for discovery. See `visibilityPredicate` in catalog.ts — 'listed'
   * is NOT cross-tenant, and cannot be until somebody decides it should be.
   */
  visibility: "organization" | "tenant" | "listed";
  /** Short catalogue blurb. `description` is the syllabus and is far too long for a card. */
  summary: string;
  instructorUserId: Id | null;
  /**
   * A DISPLAYED asking price, in minor units. Nothing in this system can take
   * money: there is no order, no ledger, no payout and no charge. Rendering a
   * Buy control against this field would be a lie about what happens next.
   */
  listPriceCents: number | null;
  /** ISO-4217, upper case. Null exactly when `listPriceCents` is null — the
   *  schema's `courses_price_needs_currency` CHECK refuses any other pairing. */
  currency: string | null;
};

export type CourseModule = {
  id: Id;
  tenantId: Id;
  courseId: Id;
  position: number;
  title: string;
  /**
   * What this step of the course IS.
   *
   * Only `lesson`, `document`, `video` and `assessment` are delivered. `scorm`
   * is a value the schema has always accepted and that nothing implements — no
   * player, no manifest parsing, no runtime, no CMI data model — so it is not
   * offered by authoring and must not be described to a customer as supported.
   * It is kept in the union rather than removed because removing it would need
   * a data migration for a value no row currently holds.
   */
  kind: "lesson" | "document" | "video" | "scorm" | "assessment";
  durationMinutes: number;
  required: boolean;
  /**
   * The assessment this module delivers, for `kind: "assessment"`.
   *
   * This is the join that lets a graded attempt satisfy a course requirement.
   * Before it existed, an "assessment" module was a label and the learner typed
   * their own score into a free-text box. Null on every other kind, which the
   * schema enforces (migration 008).
   */
  assessmentId: Id | null;
};

export type Enrollment = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  courseId: Id;
  subjectUserId: Id;
  source: "self" | "assigned" | "intervention";
  interventionId: Id | null;
  gapCaseId: Id | null;
  status: "enrolled" | "in_progress" | "completed" | "withdrawn";
  assignedByUserId: Id | null;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
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

export type Signal = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  source: "regulation" | "policy" | "incident" | "audit" | "workforce" | "performance";
  sourceReference: string;
  title: string;
  summary: string;
  detectedAt: string;
  effectiveAt: string | null;
  severity: "critical" | "high" | "medium" | "low";
  status: "new" | "triaged" | "linked" | "dismissed";
  affectedJobRoleIds: Id[];
  affectedSkillIds: Id[];
  linkedStudyId: Id | null;
  triagedByUserId: Id | null;
  triagedAt: string | null;
  dismissedReason: string | null;
};

export type Notification = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
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
  dedupeKey: string;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
};

/* Assessment entities are PostgreSQL-only during the P1 cutover. */
export type QuestionType =
  | "single_choice"
  | "multiple_choice"
  | "true_false"
  | "short_text"
  | "long_text"
  | "numeric"
  | "matching"
  | "ordering";

export type BloomLevel = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

export type QuestionBank = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  code: string;
  name: string;
  description: string;
  status: "draft" | "active" | "retired";
  createdBy: Id;
  createdAt: string;
  updatedAt: string;
};

export type AssessmentQuestion = {
  id: Id;
  tenantId: Id;
  bankId: Id;
  questionType: QuestionType;
  prompt: string;
  options: unknown;
  answerKey: unknown;
  rationale: string;
  points: number;
  difficulty: number;
  bloomLevel: BloomLevel;
  skillId: Id | null;
  rubricId: Id | null;
  origin: "manual" | "ai" | "import";
  reviewStatus: "draft" | "approved" | "rejected";
  version: number;
  createdBy: Id;
  createdAt: string;
  updatedAt: string;
};

export type Assessment = {
  id: Id;
  tenantId: Id;
  orgUnitId: Id;
  courseId: Id | null;
  code: string;
  title: string;
  description: string;
  assessmentType: "quiz" | "exam" | "practice";
  status: "draft" | "published" | "retired";
  durationMinutes: number | null;
  passPercentage: number;
  attemptLimit: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  feedbackMode: "immediate" | "after_submit" | "after_close";
  opensAt: string | null;
  closesAt: string | null;
  createdBy: Id;
  createdAt: string;
  updatedAt: string;
};

export type AssessmentAttempt = {
  id: Id;
  tenantId: Id;
  assessmentId: Id;
  subjectUserId: Id;
  attemptNumber: number;
  status: "in_progress" | "submitted" | "graded" | "void";
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  scorePoints: number | null;
  maxPoints: number | null;
  percentage: number | null;
  passed: boolean | null;
  graderUserId: Id | null;
  createdAt: string;
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
