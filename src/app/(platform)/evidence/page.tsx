import { Icons } from "@/components/icons";
import { Badge, PageHeader } from "@/components/ui";
import { EvidenceReview } from "@/components/evidence-review";
import { AuthError, principalFromCookies } from "@/lib/server/auth";
import type { Evidence } from "@/lib/server/domain";
import { assertScoped, visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Evidence workspace" };

/**
 * The evidence register.
 *
 * Every row and every count on this screen is an Evidence record from the
 * tenant's own datastore, passed through the same scoping the API enforces.
 * Nothing is illustrative: a coverage percentage this store cannot support is
 * absent rather than estimated.
 *
 * The organizing principle is expiry. `expiresAt` decides whether a record
 * still evidences anything, and gap recalculation already ignores expired
 * evidence, so the register must never let an expired record sit in a list of
 * current capability. Expired, expiring and current are separated into their
 * own tables rather than distinguished by a colour on one list.
 */

const EXPIRING_SOON_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const TYPE_LABEL: Record<Evidence["type"], string> = {
  assessment: "Assessment",
  observation: "Observation",
  work_product: "Work product",
  credential: "Credential",
};

const STATUS_LABEL: Record<Evidence["status"], string> = {
  pending: "Awaiting verification",
  verified: "Verified",
  revoked: "Revoked",
};

const STATUS_TONE: Record<Evidence["status"], "warning" | "success" | "danger"> = {
  pending: "warning",
  verified: "success",
  revoked: "danger",
};

/** Awaiting a decision first, then whatever expires soonest. Stated on screen. */
const STATUS_RANK: Record<Evidence["status"], number> = { pending: 0, verified: 1, revoked: 2 };

type ExpiryState = "expired" | "expiring" | "current" | "none";

type Expiry = {
  state: ExpiryState;
  /** Whole days to the expiry date; negative once it has passed. Null when none is recorded. */
  days: number | null;
  date: string | null;
  label: string;
};

function classifyExpiry(expiresAt: string | null, now: number): Expiry {
  if (!expiresAt) return { state: "none", days: null, date: null, label: "No expiry recorded" };
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return { state: "none", days: null, date: null, label: "No usable expiry date" };

  const date = expiresAt.slice(0, 10);
  const days = Math.round((at - now) / DAY_MS);

  // Classified on the exact timestamp, not on the rounded day count, so a
  // record that has just lapsed is never displayed as still current.
  if (at <= now) {
    return { state: "expired", days, date, label: days === 0 ? "Expired today" : `Expired ${Math.abs(days)} days ago` };
  }
  if (at - now <= EXPIRING_SOON_DAYS * DAY_MS) {
    return { state: "expiring", days, date, label: days <= 0 ? "Expires today" : `Expires in ${days} days` };
  }
  return { state: "current", days, date, label: `Expires in ${days} days` };
}

const EXPIRY_TONE: Record<ExpiryState, "danger" | "warning" | "success" | "neutral"> = {
  expired: "danger",
  expiring: "warning",
  current: "success",
  none: "neutral",
};

const EXPIRY_BADGE: Record<ExpiryState, string> = {
  expired: "Expired",
  expiring: "Expiring soon",
  current: "Current",
  none: "No expiry",
};

type Row = {
  evidence: Evidence;
  expiry: Expiry;
  subjectName: string;
  unitName: string;
  skillName: string;
  skillCode: string;
  assessorName: string | null;
  canDecide: boolean;
  /** Set when this viewer is blocked from deciding for a stated reason. */
  blockedReason: string | null;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export default async function EvidenceWorkspace() {
  const principal = await principalFromCookies();
  const database = await readDatabase();
  const now = Date.now();

  // Same scoping the API applies: tenant boundary, delegated organizational
  // paths and learner self-scope. What is not readable is not counted.
  const readable = visibleRows(database, principal, "evidence:read", database.evidence);

  const tenantName = database.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? "this workspace";
  const userName = (userId: string) =>
    database.users.find((user) => user.id === userId && user.tenantId === principal.tenantId)?.displayName ?? "Unknown person";
  const unitName = (orgUnitId: string) =>
    database.orgUnits.find((unit) => unit.id === orgUnitId && unit.tenantId === principal.tenantId)?.name ?? "Unknown unit";

  const rows: Row[] = readable.map((evidence) => {
    const skill = database.skills.find((candidate) => candidate.id === evidence.skillId && candidate.tenantId === principal.tenantId);
    // Verification is offered per row, evaluated exactly as the route will:
    // the assessor-only action, the delegated scope, then separation of duties.
    let canDecide = false;
    let blockedReason: string | null = null;
    try {
      assertScoped(database, principal, "evidence:verify", evidence);
      if (evidence.subjectUserId === principal.user.id) {
        blockedReason = "Separation of duties: you cannot decide evidence about yourself";
      } else if (evidence.status === "revoked") {
        blockedReason = "Revoked records are final";
      } else {
        canDecide = true;
      }
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    return {
      evidence,
      expiry: classifyExpiry(evidence.expiresAt, now),
      subjectName: userName(evidence.subjectUserId),
      unitName: unitName(evidence.orgUnitId),
      skillName: skill?.name ?? "Skill no longer in the catalogue",
      skillCode: skill?.code ?? evidence.skillId,
      assessorName: evidence.assessorUserId ? userName(evidence.assessorUserId) : null,
      canDecide,
      blockedReason,
    };
  });

  // Ordered so the record needing a decision leads, then the soonest deadline.
  const ordered = [...rows].sort(
    (a, b) =>
      STATUS_RANK[a.evidence.status] - STATUS_RANK[b.evidence.status] ||
      (a.expiry.days ?? Number.MAX_SAFE_INTEGER) - (b.expiry.days ?? Number.MAX_SAFE_INTEGER) ||
      b.evidence.observedAt.localeCompare(a.evidence.observedAt) ||
      a.evidence.id.localeCompare(b.evidence.id),
  );

  // A revoked record makes no capability claim, so it is never filed under an
  // expiry state - listing it beside current evidence would imply it still counts.
  const live = ordered.filter((row) => row.evidence.status !== "revoked");
  const expired = live.filter((row) => row.expiry.state === "expired");
  const expiring = live.filter((row) => row.expiry.state === "expiring");
  const current = live.filter((row) => row.expiry.state === "current" || row.expiry.state === "none");
  const revoked = ordered.filter((row) => row.evidence.status === "revoked");

  const pending = rows.filter((row) => row.evidence.status === "pending");
  const verified = rows.filter((row) => row.evidence.status === "verified");
  const machineAttested = rows.filter((row) => row.evidence.assessorUserId === null);
  const withoutExpiry = current.filter((row) => row.expiry.state === "none");
  const nextExpiry = [...expiring].sort((a, b) => (a.expiry.days ?? 0) - (b.expiry.days ?? 0))[0];

  // Whether this session holds `evidence:verify` at all. The decision column is
  // omitted entirely for everyone else rather than shown full of dashes.
  const canVerifyAny = rows.some((row) => row.canDecide);
  const roleSummary = principal.roles.length > 0 ? principal.roles.join(", ") : "no platform roles";

  const table = (heading: string, eyebrow: string, list: Row[], emptyText: string, note?: string) => (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{heading}</h2>
        </div>
        <span>{plural(list.length, "record", "records")}</span>
      </div>
      {note && <p className="inline-note">{note}</p>}
      {list.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          <div className="table-scroll" role="region" aria-label={heading} tabIndex={0}>
            <table className="data-table evidence-table">
              <caption className="sr-only">{heading}</caption>
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col">Skill</th>
                  <th scope="col">Method and level</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Observed</th>
                  <th scope="col">Expiry</th>
                  <th scope="col">Assessor</th>
                  <th scope="col">Source reference</th>
                  <th scope="col">Status</th>
                  {canVerifyAny && <th scope="col">Verification</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <tr key={row.evidence.id}>
                    <td>
                      <strong>{row.subjectName}</strong>
                      <small>{row.unitName}</small>
                    </td>
                    <td>
                      <div>{row.skillName}</div>
                      <div className="muted">{row.skillCode}</div>
                    </td>
                    <td>
                      <div>{TYPE_LABEL[row.evidence.type]}</div>
                      <div className="muted">Level {row.evidence.proficiencyLevel}</div>
                    </td>
                    <td>{Math.round(row.evidence.strength * 100)}%</td>
                    <td>{row.evidence.observedAt.slice(0, 10)}</td>
                    <td>
                      <Badge tone={EXPIRY_TONE[row.expiry.state]}>{EXPIRY_BADGE[row.expiry.state]}</Badge>
                      <div>{row.expiry.label}</div>
                      {row.expiry.date && <div className="muted">{row.expiry.date}</div>}
                    </td>
                    <td>
                      {row.assessorName ? (
                        row.assessorName
                      ) : (
                        // Machine-attested by a course assessment, with no person
                        // vouching for it. Stated plainly rather than left blank.
                        <span>Assessed by system &mdash; {row.evidence.sourceReference}</span>
                      )}
                    </td>
                    <td>{row.evidence.sourceReference}</td>
                    <td>
                      <Badge tone={STATUS_TONE[row.evidence.status]}>{STATUS_LABEL[row.evidence.status]}</Badge>
                    </td>
                    {canVerifyAny && (
                      <td>
                        {row.canDecide ? (
                          <EvidenceReview
                            evidenceId={row.evidence.id}
                            subjectName={row.subjectName}
                            skillName={row.skillName}
                            status={row.evidence.status}
                            csrfToken={principal.session.csrfToken}
                          />
                        ) : (
                          <span className="muted">{row.blockedReason ?? "Not yours to decide"}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">
            <span>
              Ordered by attention: awaiting verification first, then soonest expiry. Proficiency is on the requirement&rsquo;s
              own 0&ndash;5 scale and confidence is the recorded strength of the record.
            </span>
            <span>{plural(list.length, "record", "records")}</span>
          </div>
        </>
      )}
    </section>
  );

  return (
    <div className="page fade-in">
      <PageHeader
        eyebrow={`Assurance · ${tenantName}`}
        title="Evidence workspace"
        description="Every record you are authorized to see, separated by whether it still evidences current capability, and what is waiting on an independent decision."
      />

      <section className="metrics-grid evidence-metrics" aria-label="Evidence register summary">
        <div className={`metric${expired.length > 0 ? " metric--danger" : ""}`}>
          <span>Expired</span>
          <strong>{expired.length}</strong>
          <small>
            {expired.length === 0
              ? "No record in your scope has passed its expiry date"
              : "Past the expiry date. These no longer evidence current capability."}
          </small>
        </div>
        <div className={`metric${expiring.length > 0 ? " metric--warning" : ""}`}>
          <span>Expiring within {EXPIRING_SOON_DAYS} days</span>
          <strong>{expiring.length}</strong>
          <small>
            {nextExpiry
              ? `Earliest ${nextExpiry.expiry.date} · ${nextExpiry.expiry.label.toLowerCase()}`
              : `Nothing falls due in the next ${EXPIRING_SOON_DAYS} days`}
          </small>
        </div>
        <div className={`metric${pending.length > 0 ? " metric--warning" : ""}`}>
          <span>Awaiting verification</span>
          <strong>{pending.length}</strong>
          <small>
            {pending.length === 0
              ? "Every readable record has been decided"
              : "Claimed but not yet confirmed by an independent assessor"}
          </small>
        </div>
        <div className="metric">
          <span>Current</span>
          <strong>{current.length}</strong>
          <small>
            {withoutExpiry.length > 0
              ? `${plural(withoutExpiry.length, "record carries", "records carry")} no expiry date, so they never fall due`
              : "Every current record carries an expiry date"}
          </small>
        </div>
      </section>

      <div className="stat-strip">
        <div>
          <span>Readable in your scope</span>
          <strong>{rows.length}</strong>
        </div>
        <div>
          <span>Verified</span>
          <strong>{verified.length}</strong>
        </div>
        <div>
          <span>Awaiting verification</span>
          <strong>{pending.length}</strong>
        </div>
        <div>
          <span>Revoked</span>
          <strong>{revoked.length}</strong>
        </div>
        <div>
          <span>Machine-attested</span>
          <strong>{machineAttested.length}</strong>
        </div>
        <div>
          <span>Attested by a named assessor</span>
          <strong>{rows.length - machineAttested.length}</strong>
        </div>
      </div>

      <p className="inline-note">
        {canVerifyAny
          ? `This session holds ${roleSummary} and can decide evidence through the assessor action evidence:verify. Under ADR-001 separation of duties, evidence about you is read-only for you and must be decided by a different assessor. Every decision, including a refused one, is written to the audit ledger.`
          : `Verification requires the evidence:verify action, held only by the assessor role. This session holds ${roleSummary}, so the register is read-only here.`}
      </p>

      {rows.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Register</p>
              <h2>No evidence is readable in your scope</h2>
            </div>
          </div>
          <p className="muted">
            Evidence appears here once it is recorded against a person in your delegated organizational scope, or emitted by a
            course completion.
          </p>
        </section>
      ) : (
        <>
          {table(
            "Expired",
            "Needs attention first",
            expired,
            "No readable record has passed its expiry date.",
            "These records are past their expiry date. They are excluded when gap cases are recalculated, so they no longer count towards evidenced capability and must not be read as current proof.",
          )}
          {table(
            `Expiring within ${EXPIRING_SOON_DAYS} days`,
            "Falls due next",
            expiring,
            `No readable record expires in the next ${EXPIRING_SOON_DAYS} days.`,
            "Still valid today. Each will stop counting towards evidenced capability on the date shown unless it is renewed.",
          )}
          {table(
            "Current",
            "Evidences capability today",
            current,
            "No readable record is currently valid.",
            "Valid today. Records showing no expiry date never fall due, so nothing will prompt their renewal.",
          )}
          {revoked.length > 0 &&
            table(
              "Revoked",
              "Withdrawn",
              revoked,
              "No readable record has been revoked.",
              "These records were withdrawn by an assessor and make no capability claim, whatever their expiry date says. The reason given is recorded in the audit ledger.",
            )}
        </>
      )}

      <section className="panel evidence-ledger">
        <div>
          <Icons.shield />
          <span>
            <p className="eyebrow">How this register is built</p>
            <h2>Every figure above is a record, not an estimate</h2>
            <p>
              {plural(rows.length, "evidence record is", "evidence records are")} readable in your delegated scope, of which{" "}
              {machineAttested.length} were machine-attested by a course assessment and carry no named assessor. Expiry state is
              computed from each record&rsquo;s own <code>expiresAt</code> at the moment this page rendered; a record with no
              expiry date is shown as such rather than assumed to be permanent. Nothing here is forecast, sampled or carried over
              from a previous period.
            </p>
          </span>
        </div>
        <a className="button secondary" href="/api/evidence">Register JSON</a>
      </section>
    </div>
  );
}
