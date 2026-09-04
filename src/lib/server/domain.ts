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
