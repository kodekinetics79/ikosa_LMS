import type { Database, Notification, OrgUnit, PlatformRole, Signal, User } from "./domain";
import { id as newId } from "./security";

/* ---------------------------------------------------------------------------
 * The reminder engine.
 *
 * A compliance platform is a chasing machine. Evidence lapses, enrollments fall
 * due, interventions slip and change signals sit untriaged - and none of those
 * announce themselves. `Evidence.expiresAt` was written by the learning module
 * and then read by nothing at all, which means a qualification could expire and
 * the only place that knew was a field in a JSON file.
 *
 * Everything here is DERIVED from current state by an idempotent sweep rather
 * than written ad hoc at the moment something happens. That choice is the whole
 * design:
 *
 *   - A missed sweep loses nothing. The condition is still true next time, so
 *     the reminder is still raised. Event-at-write-time reminders are lost for
 *     good if the write path did not think to emit one.
 *   - A repeated sweep duplicates nothing. Identity lives in `dedupeKey`, not in
 *     when the sweep happened, so running it twice a minute is a no-op.
 *   - A condition that stops being true is RESOLVED, never deleted, so "we did
 *     chase this and it was dealt with" survives in the record.
 *
 * The sweep is a pure function over the database object - it mutates the state
 * it is handed and reaches for nothing else - so every rule below is unit
 * testable without HTTP, a session or a clock. `now` is always a parameter.
 *
 * NOTE: nothing in this build calls the sweep on a timer. There is no
 * scheduler. `POST /api/notifications/sweep` is the only thing that runs it, and
 * it runs when a person asks it to.
 * ------------------------------------------------------------------------- */

/** Verified evidence inside this window is chased before it lapses. */
export const EVIDENCE_EXPIRY_HORIZON_DAYS = 90;
/**
 * Enrollments get a shorter horizon than evidence. A course takes weeks, so a
 * 90-day nag would be noise the learner learns to ignore - and a reminder that
 * is ignored is worse than no reminder, because it looks like coverage.
 */
export const ENROLLMENT_DUE_HORIZON_DAYS = 30;
/** Untriaged signals are chased once the change is within a month of biting. */
export const SIGNAL_TRIAGE_HORIZON_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Roles granted `signal:triage` in auth.ts, held here as data so the sweep stays pure. */
const SIGNAL_TRIAGE_ROLES: PlatformRole[] = ["tna_analyst", "tenant_admin"];

const SWEPT_KINDS: Notification["kind"][] = [
  "evidence_expiring",
  "evidence_expired",
  "enrollment_due",
  "enrollment_overdue",
  "signal_untriaged",
  "intervention_overdue",
];

export const SEVERITY_RANK: Record<Notification["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1 };

export const NOTIFICATION_KIND_LABEL: Record<Notification["kind"], string> = {
  evidence_expiring: "Evidence expiring",
  evidence_expired: "Evidence expired",
  enrollment_due: "Course due",
  enrollment_overdue: "Course overdue",
  signal_untriaged: "Signal awaiting triage",
  intervention_overdue: "Intervention overdue",
};

export type SweepResult = {
  /** Conditions that had no open notification and now do. */
  raised: number;
  /** Conditions that were already open; their copy was refreshed in place. */
  refreshed: number;
  /** Open notifications whose condition no longer holds; marked resolved, not deleted. */
  resolved: number;
  /** Open notifications in scope after the sweep. */
  open: number;
  /**
   * Conditions that are real but have nobody to send to (the subject, owner or
   * triage analyst could not be resolved to an active user in the same tenant).
   * Counted rather than silently dropped: "nobody was told" is precisely the
   * failure this engine exists to prevent, so it has to be visible.
   */
  unroutable: number;
};

/** Everything the sweep derives; identity, timestamps and read state are not its business. */
type DerivedNotification = Omit<Notification, "id" | "createdAt" | "readAt" | "resolvedAt">;

/* --------------------------------------------------------------------------
 * Small shared helpers.
 * ------------------------------------------------------------------------ */

/**
 * The sweep is a pure function over any Database object, including one that did
 * not come from the store's migration - a fixture, or a file written before
 * these entities existed. Reading collections through these accessors means a
 * missing array is an empty list rather than a crash on the first `.filter`.
 */
export function notificationsOf(database: Database): Notification[] {
  const rows = (database as Partial<Database>).notifications;
  return Array.isArray(rows) ? rows : [];
}

function signalsOf(database: Database): Signal[] {
  const rows = (database as Partial<Database>).signals;
  return Array.isArray(rows) ? rows : [];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A deadline written as a calendar date is not breached until that day is over.
 * Parsing "2026-09-10" as UTC midnight would report a course overdue for the
 * whole of the day it is actually due, which is both wrong and the kind of
 * wrong that trains people to distrust the list. Full timestamps - which is what
 * `Evidence.expiresAt` carries - are used exactly as written.
 */
function deadlineMs(value: string): number {
  return Date.parse(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}

/** Calendar date for display. Locale formatting is deliberately avoided: it depends on the server's environment. */
function isoDate(value: string): string {
  return value.slice(0, 10);
}

function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.ceil((toMs - fromMs) / MS_PER_DAY);
}

/**
 * The recipient must exist, be active, and belong to the SAME tenant as the row
 * that produced the condition. That single check is what makes a cross-tenant
 * notification structurally impossible rather than merely unlikely.
 */
function activeUser(database: Database, tenantId: string, userId: string | null): User | undefined {
  if (!userId) return undefined;
  return database.users.find((candidate) => candidate.id === userId && candidate.tenantId === tenantId && candidate.active);
}

function orgUnitOf(database: Database, tenantId: string, orgUnitId: string): OrgUnit | undefined {
  return database.orgUnits.find((unit) => unit.id === orgUnitId && unit.tenantId === tenantId);
}

function pathCovers(scope: string, path: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

/**
 * A `new` signal has not been linked to a study yet, so there is no study owner
 * to notify and the recipient has to be inferred. The rule, stated so it can be
 * argued with rather than guessed at:
 *
 *   1. The owner of the most specific TNA study already covering the signal's
 *      organizational unit (that unit or the nearest ancestor). That analyst is
 *      already accountable for this part of the organization, so the signal
 *      lands with the person whose study it would change.
 *   2. Failing that, the most specifically scoped active user who may triage
 *      signals at all and whose delegated scope covers the unit.
 *
 * Ties are broken by id so two runs over identical state pick the same person.
 * If neither step resolves anyone the condition is counted as unroutable rather
 * than dropped.
 */
function signalTriageOwner(database: Database, signal: Signal): User | undefined {
  const signalOrg = orgUnitOf(database, signal.tenantId, signal.orgUnitId);
  if (!signalOrg) return undefined;

  const studies = database.tnaStudies
    .filter((study) => study.tenantId === signal.tenantId)
    .flatMap((study) => {
      const org = orgUnitOf(database, study.tenantId, study.orgUnitId);
      if (!org || !pathCovers(org.path, signalOrg.path)) return [];
      return [{ study, depth: org.path.length }];
    })
    .sort((a, b) =>
      b.depth - a.depth ||
      b.study.createdAt.localeCompare(a.study.createdAt) ||
      a.study.id.localeCompare(b.study.id));

  for (const { study } of studies) {
    const owner = activeUser(database, signal.tenantId, study.ownerUserId);
    if (owner) return owner;
  }

  const scopeDepth = (user: User): number =>
    user.delegatedOrgPaths.filter((scope) => pathCovers(scope, signalOrg.path)).reduce((deepest, scope) => Math.max(deepest, scope.length), 0);

  return database.users
    .filter((user) =>
      user.tenantId === signal.tenantId &&
      user.active &&
      user.roles.some((role) => SIGNAL_TRIAGE_ROLES.includes(role)) &&
      scopeDepth(user) > 0)
    .sort((a, b) => scopeDepth(b) - scopeDepth(a) || a.id.localeCompare(b.id))[0];
}

/* --------------------------------------------------------------------------
 * The rules.
 * ------------------------------------------------------------------------ */

type Collector = {
  push: (derived: DerivedNotification) => void;
  /** A condition that holds but has no resolvable recipient. */
  drop: () => void;
};

/**
 * Builds the recipient-facing envelope shared by every rule.
 *
 * The notification is filed at the RECIPIENT's organizational unit, not the
 * source record's. `visibleRows` scopes by org path, so filing an intervention
 * reminder at the gap's unit can put it outside the delegated scope of the very
 * person who owns the intervention - the reminder would exist and its recipient
 * could never see it. A notification is addressed to a person; it belongs where
 * that person sits.
 */
function envelope(recipient: User): Pick<Notification, "tenantId" | "orgUnitId" | "subjectUserId"> {
  return { tenantId: recipient.tenantId, orgUnitId: recipient.orgUnitId, subjectUserId: recipient.id };
}

function collectEvidence(database: Database, nowMs: number, tenantId: string | undefined, into: Collector): void {
  const horizonMs = nowMs + EVIDENCE_EXPIRY_HORIZON_DAYS * MS_PER_DAY;

  for (const evidence of database.evidence) {
    if (tenantId && evidence.tenantId !== tenantId) continue;
    // Only verified evidence carries a live competence claim. Pending evidence
    // claims nothing yet and revoked evidence already claims nothing, so
    // neither has anything to lose by lapsing.
    if (evidence.status !== "verified") continue;
    if (!evidence.expiresAt) continue;

    const expiry = deadlineMs(evidence.expiresAt);
    if (!Number.isFinite(expiry)) continue;
    if (expiry > horizonMs) continue;

    const recipient = activeUser(database, evidence.tenantId, evidence.subjectUserId);
    if (!recipient) { into.drop(); continue; }

    const skill = database.skills.find((candidate) => candidate.id === evidence.skillId && candidate.tenantId === evidence.tenantId);
    const skillName = skill?.name ?? "an unrecorded capability";
    const when = isoDate(evidence.expiresAt);

    // The boundary is inclusive on the expired side: at the instant of expiry
    // the claim has lapsed. "Expires today" is not a state anyone can act on.
    if (expiry <= nowMs) {
      into.push({
        ...envelope(recipient),
        kind: "evidence_expired",
        severity: "critical",
        title: `Evidence for ${skillName} expired on ${when}`,
        body: `The verified ${evidence.type.replace(/_/g, " ")} evidence at level ${evidence.proficiencyLevel} lapsed on ${when}. Any requirement relying on it is no longer met until the capability is re-evidenced.`,
        resourceType: "evidence",
        resourceId: evidence.id,
        dueAt: evidence.expiresAt,
        // Keyed on the expiry instant, so extending the expiry retires this
        // reminder and raises a fresh one for the new date.
        dedupeKey: `evidence_expired:${evidence.id}:${evidence.expiresAt}`,
      });
      continue;
    }

    const daysLeft = wholeDaysBetween(nowMs, expiry);
    into.push({
      ...envelope(recipient),
      kind: "evidence_expiring",
      severity: daysLeft <= 30 ? "high" : "medium",
      title: `Evidence for ${skillName} expires on ${when}`,
      body: `The verified ${evidence.type.replace(/_/g, " ")} evidence at level ${evidence.proficiencyLevel} lapses on ${when}. Re-evidence the capability before then to keep the requirement met.`,
      resourceType: "evidence",
      resourceId: evidence.id,
      dueAt: evidence.expiresAt,
      dedupeKey: `evidence_expiring:${evidence.id}:${evidence.expiresAt}`,
    });
  }
}

function collectEnrollments(database: Database, nowMs: number, tenantId: string | undefined, into: Collector): void {
  const horizonMs = nowMs + ENROLLMENT_DUE_HORIZON_DAYS * MS_PER_DAY;

  for (const enrollment of database.enrollments) {
    if (tenantId && enrollment.tenantId !== tenantId) continue;
    // Terminal states are not chased. Completing or withdrawing from a course
    // is exactly the outcome the reminder was asking for.
    if (enrollment.status === "completed" || enrollment.status === "withdrawn") continue;
    if (!enrollment.dueDate) continue;

    const due = deadlineMs(enrollment.dueDate);
    if (!Number.isFinite(due)) continue;
    if (due > horizonMs) continue;

    const recipient = activeUser(database, enrollment.tenantId, enrollment.subjectUserId);
    if (!recipient) { into.drop(); continue; }

    const course = database.courses.find((candidate) => candidate.id === enrollment.courseId && candidate.tenantId === enrollment.tenantId);
    const courseName = course ? `${course.title} (${course.code})` : "an assigned course";
    const when = isoDate(enrollment.dueDate);
    const overdue = due <= nowMs;

    into.push({
      ...envelope(recipient),
      kind: overdue ? "enrollment_overdue" : "enrollment_due",
      severity: overdue ? "high" : "medium",
      title: overdue ? `${courseName} was due on ${when}` : `${courseName} is due on ${when}`,
      body: overdue
        ? `This enrollment passed its due date on ${when} and is still ${enrollment.status === "enrolled" ? "not started" : "in progress"}.${enrollment.gapCaseId ? " It was assigned to close an identified capability gap." : ""}`
        : `This enrollment is due on ${when} and is currently ${enrollment.status === "enrolled" ? "not started" : "in progress"}.${enrollment.gapCaseId ? " It was assigned to close an identified capability gap." : ""}`,
      resourceType: "enrollment",
      resourceId: enrollment.id,
      dueAt: enrollment.dueDate,
      // The due date is part of the identity: moving the deadline retires the
      // old chase and starts a new one against the new date.
      dedupeKey: `${overdue ? "enrollment_overdue" : "enrollment_due"}:${enrollment.id}:${enrollment.dueDate}`,
    });
  }
}

function collectInterventions(database: Database, nowMs: number, tenantId: string | undefined, into: Collector): void {
  for (const intervention of database.interventions) {
    if (tenantId && intervention.tenantId !== tenantId) continue;
    if (intervention.status === "completed" || intervention.status === "verified") continue;

    const due = deadlineMs(intervention.dueDate);
    if (!Number.isFinite(due) || due > nowMs) continue;

    // The owner is accountable for the intervention, so the owner is chased -
    // not the person whose gap it closes, who cannot act on it.
    const recipient = activeUser(database, intervention.tenantId, intervention.ownerUserId);
    if (!recipient) { into.drop(); continue; }

    const gap = database.gapCases.find((candidate) => candidate.id === intervention.gapCaseId && candidate.tenantId === intervention.tenantId);
    const when = isoDate(intervention.dueDate);

    into.push({
      ...envelope(recipient),
      kind: "intervention_overdue",
      severity: gap?.priority === "critical" ? "critical" : "high",
      title: `Intervention "${intervention.title}" was due on ${when}`,
      body: `This ${intervention.type.replace(/_/g, " ")} intervention is still ${intervention.status} after its due date of ${when}.${gap ? ` The gap it addresses is ${gap.priority} priority and remains ${gap.status}.` : ""}`,
      resourceType: "intervention",
      resourceId: intervention.id,
      dueAt: intervention.dueDate,
      dedupeKey: `intervention_overdue:${intervention.id}:${intervention.dueDate}`,
    });
  }
}

function collectSignals(database: Database, nowMs: number, tenantId: string | undefined, into: Collector): void {
  const horizonMs = nowMs + SIGNAL_TRIAGE_HORIZON_DAYS * MS_PER_DAY;

  for (const signal of signalsOf(database)) {
    if (tenantId && signal.tenantId !== tenantId) continue;
    // Triaged, linked and dismissed signals have all had a decision recorded
    // against them. Only "nobody has looked at this yet" is chaseable.
    if (signal.status !== "new") continue;
    // A signal with no effective date has no deadline to chase against. It stays
    // visible in the signal inbox, which lists every untriaged signal; inventing
    // an urgency for it here would put undated items above dated ones.
    if (!signal.effectiveAt) continue;

    const effective = deadlineMs(signal.effectiveAt);
    if (!Number.isFinite(effective) || effective > horizonMs) continue;

    const recipient = signalTriageOwner(database, signal);
    if (!recipient) { into.drop(); continue; }

    const when = isoDate(signal.effectiveAt);
    const inForce = effective <= nowMs;

    into.push({
      ...envelope(recipient),
      kind: "signal_untriaged",
      // The signal already carries a severity assessment; re-deriving one here
      // would give the same change two different urgencies on two screens.
      severity: signal.severity,
      title: inForce
        ? `Untriaged signal "${signal.title}" has been in force since ${when}`
        : `Untriaged signal "${signal.title}" takes effect on ${when}`,
      body: `${signal.sourceReference} is ${inForce ? `already in force since ${when}` : `effective from ${when}`} and has not been triaged. Link it to a TNA study or dismiss it with a stated reason.`,
      resourceType: "signal",
      resourceId: signal.id,
      dueAt: signal.effectiveAt,
      dedupeKey: `signal_untriaged:${signal.id}:${signal.effectiveAt}`,
    });
  }
}

/* --------------------------------------------------------------------------
 * The sweep.
 * ------------------------------------------------------------------------ */

/**
 * Derives every outstanding reminder from current state and reconciles it
 * against what is already on file.
 *
 * Idempotency, precisely: a condition's identity is its `dedupeKey`, and the
 * invariant maintained here is that at most ONE UNRESOLVED notification exists
 * per (tenant, dedupeKey). A second run finds the open row and refreshes it in
 * place - same id, same createdAt, same read state - so sweeping twice, or twice
 * a minute, changes nothing. Because the derived text is built from the record
 * rather than from the current time, a repeat sweep over unchanged state writes
 * byte-identical rows.
 *
 * Resolution and recurrence: an open notification whose condition has gone gets
 * `resolvedAt` set and is left in place, because "this was chased and dealt
 * with" is part of the record an auditor asks for. The match on upsert requires
 * `resolvedAt === null`, so if the same condition later recurs - the enrollment
 * reopens, the signal is untriaged again - the resolved row is NOT revived. A
 * fresh, unread row is raised beside it with the same `dedupeKey`. The key
 * identifies the condition; a row is one episode of it.
 *
 * @param now       Injected clock. Every rule reads time from here.
 * @param options.tenantId Restrict the sweep to one tenant. The operational
 *   endpoint passes the caller's tenant so an operator can never raise, refresh
 *   or resolve rows belonging to another customer.
 */
export function sweepNotifications(
  database: Database,
  now = new Date(),
  options: { tenantId?: string } = {},
): SweepResult {
  // Creating the empty array is the only structural write the sweep performs,
  // and it is what lets the function run against a state object that never
  // passed through the store's migration.
  if (!Array.isArray((database as Partial<Database>).notifications)) database.notifications = [];
  const notifications = database.notifications;

  const nowMs = now.getTime();
  const timestamp = now.toISOString();
  const scope = options.tenantId;

  const derived: DerivedNotification[] = [];
  let unroutable = 0;
  const collector: Collector = { push: (item) => derived.push(item), drop: () => { unroutable += 1; } };

  collectEvidence(database, nowMs, scope, collector);
  collectEnrollments(database, nowMs, scope, collector);
  collectInterventions(database, nowMs, scope, collector);
  collectSignals(database, nowMs, scope, collector);

  // Keyed by tenant AND dedupeKey: two tenants can never contend for one key,
  // and a first-writer-wins map means a rule that somehow derived the same
  // condition twice in one pass still yields exactly one row. The separator is
  // NUL because no identifier or timestamp can contain one, so no two distinct
  // (tenant, key) pairs can concatenate into the same string.
  const identity = (row: { tenantId: string; dedupeKey: string }): string => `${row.tenantId}\u0000${row.dedupeKey}`;
  const desired = new Map<string, DerivedNotification>();
  for (const candidate of derived) {
    if (!desired.has(identity(candidate))) desired.set(identity(candidate), candidate);
  }

  let raised = 0;
  let refreshed = 0;
  let resolved = 0;

  for (const [key, candidate] of desired) {
    const open = notifications.find((row) => row.resolvedAt === null && identity(row) === key);
    if (open) {
      // Only derived fields are copied. id, createdAt and readAt survive, so
      // re-running the sweep never un-reads what somebody has already read.
      Object.assign(open, candidate);
      refreshed += 1;
    } else {
      notifications.push({ id: newId("ntf"), ...candidate, createdAt: timestamp, readAt: null, resolvedAt: null });
      raised += 1;
    }
  }

  for (const row of notifications) {
    if (row.resolvedAt !== null) continue;
    if (scope && row.tenantId !== scope) continue;
    // Only rows this engine produced are resolvable by it. A key that does not
    // start with its own row's kind was written by something else, and quietly
    // closing another author's rows is not this function's business.
    if (!SWEPT_KINDS.includes(row.kind) || !row.dedupeKey.startsWith(`${row.kind}:`)) continue;
    if (desired.has(identity(row))) continue;
    row.resolvedAt = timestamp;
    resolved += 1;
  }

  const open = notifications.filter((row) => row.resolvedAt === null && (!scope || row.tenantId === scope)).length;
  return { raised, refreshed, resolved, open, unroutable };
}

/* --------------------------------------------------------------------------
 * Read state.
 * ------------------------------------------------------------------------ */

/**
 * Read state is personal, so it is the recipient's alone to change - including
 * against a manager or administrator who can otherwise see the row. A supervisor
 * clearing somebody else's chase list would hide the reminder from the only
 * person able to act on it, which is a silent failure dressed up as tidiness.
 */
export function canChangeReadState(notification: Notification, userId: string): boolean {
  return notification.subjectUserId === userId;
}

/**
 * Idempotent: marking an already-read notification read keeps the original read
 * time, so replaying the request never rewrites history.
 */
export function setReadState(notification: Notification, read: boolean, now = new Date()): Notification {
  notification.readAt = read ? notification.readAt ?? now.toISOString() : null;
  return notification;
}

/** Most urgent first, then soonest deadline, then newest. Undated items sort last. */
export function compareNotifications(a: Notification, b: Notification): number {
  const deadline = (value: string | null): number => {
    if (!value) return Number.MAX_SAFE_INTEGER;
    const parsed = deadlineMs(value);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    deadline(a.dueAt) - deadline(b.dueAt) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}
