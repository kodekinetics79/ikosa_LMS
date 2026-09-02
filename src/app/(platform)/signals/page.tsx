import Link from "next/link";
import { Badge, PageHeader } from "@/components/ui";
import { SignalTriage, type TriageStudyOption } from "@/components/signal-triage";
import { AuthError, authorize, principalFromCookies } from "@/lib/server/auth";
import type { Principal } from "@/lib/server/auth";
import type { Database, Signal } from "@/lib/server/domain";
import { assertScoped, visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Signal inbox" };

/**
 * The change-signal inbox: the front of the continuous-TNA funnel.
 *
 * Every value on this screen is read from the tenant's own records through the
 * same scoping the API enforces. There are no counts of "affected people", no
 * confidence percentages and no impact estimates, because the store holds none
 * of those - a Signal records what changed, not who it will hit. Publishing a
 * plausible-looking number for those is how a defensibility product stops being
 * defensible, so the widgets that would carry them are absent.
 *
 * Linked and dismissed signals stay on the screen with their outcome and their
 * stated reason. Hiding a declined change is the failure mode this inbox exists
 * to prevent: an auditor's first question is what you decided NOT to act on.
 */

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const SEVERITY_TONE = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;

const SOURCE_LABEL = {
  regulation: "Regulation", policy: "Policy", incident: "Incident",
  audit: "Audit finding", workforce: "Workforce change", performance: "Performance",
} as const;

const STATUS_LABEL = { new: "Awaiting triage", triaged: "Triaged", linked: "Linked to a study", dismissed: "Dismissed" } as const;
const STATUS_TONE = { new: "warning", triaged: "info", linked: "success", dismissed: "neutral" } as const;

const STUDY_STATUS_LABEL = { draft: "Draft", collecting: "Collecting evidence", analysis: "In analysis", approved: "Approved" } as const;

const ROLE_LABEL: Record<string, string> = {
  tenant_admin: "Tenant administrator", tna_analyst: "TNA analyst", manager: "Manager",
  assessor: "Assessor", learner: "Learner", auditor: "Auditor",
};

/** Signals with no effective date sort last: nothing about them is imminent. */
const NO_DEADLINE = Number.MAX_SAFE_INTEGER;
const MS_PER_DAY = 86_400_000;
/** Window used only for the "effective soon" count, and labelled as such. */
const IMMINENT_DAYS = 30;

function utcMidnight(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Whole days from today until the change bites; negative once it already has. */
function daysUntil(effectiveAt: string | null, now: number): number | null {
  if (!effectiveAt) return null;
  const parsed = Date.parse(effectiveAt);
  if (Number.isNaN(parsed)) return null;
  return Math.round((utcMidnight(parsed) - utcMidnight(now)) / MS_PER_DAY);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function effectiveSummary(effectiveAt: string | null, days: number | null): string {
  if (effectiveAt === null || days === null) return "No effective date recorded";
  const date = effectiveAt.slice(0, 10);
  if (days < 0) return `Effective ${date} · already in force, ${plural(Math.abs(days), "day", "days")} ago`;
  if (days === 0) return `Effective ${date} · today`;
  return `Effective ${date} · in ${plural(days, "day", "days")}`;
}

function roleNames(principal: Principal): string {
  return principal.roles.map((role) => ROLE_LABEL[role] ?? role).join(", ") || "no role assigned";
}

export default async function SignalInbox() {
  const principal = await principalFromCookies();
  const db = await readDatabase();
  const now = Date.now();

  // A truthful permission panel rather than a crash or - worse - an empty
  // inbox, which a reader would take to mean "no change has been detected".
  try {
    authorize(principal, "signal:read", { tenantId: principal.tenantId });
  } catch {
    return <PermissionPanel principal={principal} />;
  }

  const signals = visibleRows(db, principal, "signal:read", db.signals);

  // Checked per row against the same helper the endpoint uses, so the screen
  // can never offer a control the server would refuse.
  const canTriage = (signal: Signal): boolean => {
    try {
      assertScoped(db, principal, "signal:triage", signal);
      return true;
    } catch (error) {
      // Only an authorization decision means "not yours to decide". A row
      // pointing at a missing organizational unit is a data-integrity fault and
      // must surface rather than quietly read as a permission problem.
      if (error instanceof AuthError) return false;
      throw error;
    }
  };

  // Only studies this caller can actually read are offered as a link target,
  // because that is exactly what the triage endpoint will accept.
  const studyOptions: TriageStudyOption[] = visibleRows(db, principal, "tna:read", db.tnaStudies)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((study) => ({ id: study.id, label: `${study.title} · ${STUDY_STATUS_LABEL[study.status]}` }));

  const rows = signals.map((signal) => ({ signal, days: daysUntil(signal.effectiveAt, now), triageable: canTriage(signal) }));

  // Urgency ordering, stated on screen so it can be checked rather than
  // trusted: severity first, then how soon the change lands, then how long the
  // signal has already waited.
  const awaiting = rows
    .filter(({ signal }) => signal.status === "new")
    .sort((a, b) =>
      SEVERITY_RANK[b.signal.severity] - SEVERITY_RANK[a.signal.severity] ||
      (a.days ?? NO_DEADLINE) - (b.days ?? NO_DEADLINE) ||
      a.signal.detectedAt.localeCompare(b.signal.detectedAt) ||
      a.signal.id.localeCompare(b.signal.id));

  const decided = rows
    .filter(({ signal }) => signal.status !== "new")
    .sort((a, b) =>
      (b.signal.triagedAt ?? "").localeCompare(a.signal.triagedAt ?? "") ||
      a.signal.id.localeCompare(b.signal.id));

  const imminent = awaiting.filter(({ days }) => days !== null && days <= IMMINENT_DAYS).length;
  const linked = decided.filter(({ signal }) => signal.status === "linked").length;
  const dismissed = decided.filter(({ signal }) => signal.status === "dismissed").length;
  const oldestWaiting = awaiting.map(({ signal }) => signal.detectedAt).sort()[0]?.slice(0, 10);
  const nextEffective = awaiting.map(({ signal }) => signal.effectiveAt).filter((value): value is string => value !== null).sort()[0]?.slice(0, 10);
  const anyTriageable = rows.some(({ signal, triageable }) => signal.status === "new" && triageable);
  const tenantName = db.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? "This workspace";

  return <div className="page fade-in">
    <PageHeader
      eyebrow={`${tenantName} · continuous sensing`}
      title="Signal inbox"
      description="Changes that may alter what the workforce must be able to do. Each one is either linked to a TNA study or dismissed with a stated reason - never dropped."
    />

    <section className="stat-strip" aria-label="Signal inbox totals">
      <div><span>Awaiting triage</span><strong>{awaiting.length}</strong></div>
      <div><span>Untriaged, effective within {IMMINENT_DAYS} days</span><strong>{imminent}</strong></div>
      <div><span>Linked to a TNA study</span><strong>{linked}</strong></div>
      <div><span>Dismissed with a stated reason</span><strong>{dismissed}</strong></div>
    </section>

    <p className="muted">
      <small>
        The queue is ordered by severity, then by how soon the change takes effect - already in force first, then the nearest date, with signals carrying no
        effective date last. Counts cover only the signals your delegated organizational scope allows you to read.
      </small>
    </p>

    <div className="detail-grid">
      <section className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Decision queue</p><h2>Awaiting triage</h2></div>
          <span className="count-badge">{awaiting.length}</span>
        </div>

        {awaiting.length === 0
          ? <p className="muted">No signal in your scope is awaiting triage. New signals appear here as soon as they are detected.</p>
          : <div className="record-list">
            {awaiting.map(({ signal, days, triageable }) => <SignalRow
              key={signal.id}
              signal={signal}
              days={days}
              db={db}
              principal={principal}
              triage={triageable
                ? <SignalTriage signalId={signal.id} signalTitle={signal.title} csrfToken={principal.session.csrfToken} studies={studyOptions} />
                : null}
            />)}
          </div>}
      </section>

      <aside className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Scope</p><h2>What this inbox shows</h2></div>
        </div>
        <dl>
          <div className="definition-row"><dt>Signals readable to you</dt><dd>{signals.length}</dd></div>
          <div className="definition-row"><dt>Your roles</dt><dd>{roleNames(principal)}</dd></div>
          <div className="definition-row"><dt>Triage decisions</dt><dd>{anyTriageable ? "You may record them" : "Read only"}</dd></div>
          <div className="definition-row"><dt>Studies you can link to</dt><dd>{studyOptions.length}</dd></div>
          <div className="definition-row"><dt>Longest wait in the queue</dt><dd>{oldestWaiting ? `detected ${oldestWaiting}` : "nothing waiting"}</dd></div>
          <div className="definition-row"><dt>Next effective date</dt><dd>{nextEffective ?? "none recorded"}</dd></div>
        </dl>
        {anyTriageable
          ? <p className="inline-note">A dismissal is refused unless it states a reason, and a signal can be triaged once - the decision and its author are written to the audit ledger in the same step.</p>
          : <p className="inline-note">Recording a decision needs the signal:triage action, held by tenant administrators and TNA analysts. You can read the queue and every decision already taken.</p>}
      </aside>

      <section className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Decisions on record</p><h2>Triaged signals</h2></div>
          <span className="count-badge">{decided.length}</span>
        </div>

        {decided.length === 0
          ? <p className="muted">No signal in your scope has been triaged yet.</p>
          : <>
            <p className="muted"><small>Most recent decision first. Dismissed signals stay here with the reason they were declined and the person who declined them.</small></p>
            <div className="record-list">
              {decided.map(({ signal, days }) => <SignalRow key={signal.id} signal={signal} days={days} db={db} principal={principal} triage={null} />)}
            </div>
          </>}
      </section>
    </div>
  </div>;
}

function PermissionPanel({ principal }: { principal: Principal }) {
  return <div className="page fade-in">
    <PageHeader
      eyebrow="Continuous sensing"
      title="Signal inbox"
      description="Changes that may alter what the workforce must be able to do."
    />
    <section className="panel">
      <div className="panel-header">
        <div><p className="eyebrow">Access</p><h2>Your role cannot read change signals</h2></div>
      </div>
      <p className="muted">
        This inbox needs the signal:read action, held by tenant administrators, TNA analysts, managers and auditors.
      </p>
      <p className="inline-note">
        Signed in as {principal.user.displayName} with {plural(principal.roles.length, "role", "roles")}: {roleNames(principal)}. This screen is empty because of
        that permission, not because no change signal exists.
      </p>
    </section>
  </div>;
}

function SignalRow({ signal, days, db, principal, triage }: {
  signal: Signal;
  days: number | null;
  db: Database;
  principal: Principal;
  triage: React.ReactNode;
}) {
  const inTenant = <T extends { id: string; tenantId: string }>(candidates: T[], id: string): T | undefined =>
    candidates.find((row) => row.id === id && row.tenantId === principal.tenantId);

  const roles = signal.affectedJobRoleIds.map((id) => inTenant(db.jobRoles, id)?.title ?? "Unknown job role");
  const skills = signal.affectedSkillIds.map((id) => inTenant(db.skills, id)?.name ?? "Unknown skill");
  const unitName = db.orgUnits.find((unit) => unit.id === signal.orgUnitId && unit.tenantId === principal.tenantId)?.name;
  const study = signal.linkedStudyId ? inTenant(db.tnaStudies, signal.linkedStudyId) : undefined;
  const triagedBy = signal.triagedByUserId ? inTenant(db.users, signal.triagedByUserId) : undefined;

  return <article className="record-row">
    {/* Decorative only: the severity is also stated in the badge below, so it
        is never carried by colour alone. */}
    <span className={`severity-mark severity-mark--${signal.severity}`} aria-hidden="true" />

    <div className="record-main">
      <strong>{signal.title}</strong>

      <div className="record-meta">
        <Badge tone={SEVERITY_TONE[signal.severity]}>{SEVERITY_LABEL[signal.severity]} severity</Badge>
        <Badge tone={STATUS_TONE[signal.status]}>{STATUS_LABEL[signal.status]}</Badge>
        <span>{SOURCE_LABEL[signal.source]} · {signal.sourceReference}</span>
        {unitName && <span>{unitName}</span>}
      </div>

      <span className="muted">{signal.summary}</span>

      <div className="record-meta">
        <span>Affected roles: {roles.length > 0 ? roles.join(", ") : "none recorded"}</span>
        <span>Affected skills: {skills.length > 0 ? skills.join(", ") : "none recorded"}</span>
      </div>

      {signal.status === "linked" && <div className="record-meta">
        <span>Linked to</span>
        {study
          ? <Link className="text-button" href={`/studies/${study.id}`}>{study.title}</Link>
          : <span>a study that is no longer readable in your scope</span>}
      </div>}

      {signal.status === "dismissed" && <span className="muted">
        Dismissed because: {signal.dismissedReason ?? "no reason is recorded against this signal"}
      </span>}

      {(triagedBy !== undefined || signal.triagedAt !== null) && <div className="record-meta">
        <span>Decided by {triagedBy?.displayName ?? "a user outside your scope"}{signal.triagedAt ? ` on ${signal.triagedAt.slice(0, 10)}` : ""}</span>
      </div>}

      {triage}
    </div>

    <div className="record-side">
      <small>{effectiveSummary(signal.effectiveAt, days)}</small>
      <small>Detected {signal.detectedAt.slice(0, 10)}</small>
    </div>
  </article>;
}
