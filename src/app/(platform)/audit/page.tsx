import { redirect } from "next/navigation";
import { Icons } from "@/components/icons";
import { Badge, PageHeader } from "@/components/ui";
import { verifyAuditChain } from "@/lib/server/audit";
import { AuthError, authorize, principalFromCookies } from "@/lib/server/auth";
import type { AuditEvent } from "@/lib/server/domain";
import { readDatabase } from "@/lib/server/store";

/**
 * The audit room may only state what this render actually computed.
 *
 * Every integrity claim on this page comes from `verifyAuditChain` called
 * below, against the same tenant slice whose events are listed. Nothing here is
 * illustrative: if a value cannot be derived from the ledger it is not shown.
 */

const LEDGER_WINDOW = 25;

const DESCRIPTION =
  "Every row is an entry from this tenant's append-only ledger, shown with the hash chain that binds it to the entry before it.";

const outcomeTone: Record<AuditEvent["outcome"], "success" | "info" | "danger"> = {
  success: "success",
  allowed: "info",
  denied: "danger",
  failure: "danger",
};

const reasonSummary = {
  hash_mismatch: "Hash mismatch",
  broken_link: "Broken link",
} as const;

const reasonDetail = {
  hash_mismatch:
    "An event no longer recomputes to the HMAC stored beside it, so that record has been altered since it was written. Treat the ledger as compromised from that event onward.",
  broken_link:
    "An event's previous hash does not match the hash of the event before it, so a record has been removed, reordered or inserted. Treat the ledger as compromised from that event onward.",
} as const;

/** ISO-8601 in UTC. A wall-clock label with no zone would be unverifiable. */
function stamp(value: string): string {
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? value : `${moment.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 14)}…`;
}

export default async function Audit() {
  const principal = await principalFromCookies().catch(() => null);
  if (!principal) redirect("/login");

  let denial: string | null = null;
  try {
    authorize(principal, "audit:read", { tenantId: principal.tenantId });
  } catch (error) {
    denial = error instanceof AuthError ? error.message : "Authorization could not be evaluated";
  }

  const guardrail = (
    <section className="guardrail-banner">
      <Icons.shield />
      <div>
        <strong>Auditor mode is read-only</strong>
        <p>
          Nothing in this workspace can change an audit record. The ledger is append-only and each entry is signed into an
          HMAC-SHA256 chain, so an altered, removed or reordered record fails verification rather than disappearing quietly.
        </p>
      </div>
    </section>
  );

  if (denial) {
    return (
      <div className="page fade-in">
        <PageHeader eyebrow="Read-only assurance workspace" title="Audit room" description={DESCRIPTION} />
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Access</p>
              <h2>The audit ledger is not available to this account</h2>
            </div>
          </div>
          <p className="muted">
            Reading the ledger requires the <strong>audit:read</strong> permission, held by the auditor and tenant_admin
            roles. This session holds {principal.roles.length > 0 ? principal.roles.join(", ") : "no platform roles"}.
          </p>
          <p className="muted">
            Authorization result: {denial}. No verification was run, so no integrity status is reported here.
          </p>
        </section>
        {guardrail}
      </div>
    );
  }

  const [database, integrity] = await Promise.all([readDatabase(), verifyAuditChain(principal.tenantId)]);
  const checkedAt = stamp(new Date().toISOString());
  const tenantName = database.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? principal.tenantId;
  const displayNames = new Map(
    database.users.filter((user) => user.tenantId === principal.tenantId).map((user) => [user.id, user.displayName])
  );

  const events = database.auditEvents.filter((event) => event.tenantId === principal.tenantId);
  const recent = events.slice(-LEDGER_WINDOW).reverse();
  const empty = events.length === 0;

  const outcomes = events.reduce<Partial<Record<AuditEvent["outcome"], number>>>((totals, event) => {
    totals[event.outcome] = (totals[event.outcome] ?? 0) + 1;
    return totals;
  }, {});
  const actions = [
    ...events.reduce((totals, event) => totals.set(event.action, (totals.get(event.action) ?? 0) + 1), new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const flagged = (outcomes.denied ?? 0) + (outcomes.failure ?? 0);

  const integrityState = empty ? "No events" : integrity.valid ? "Verified" : "Requires review";
  const integrityTone = empty ? "" : integrity.valid ? " metric--success" : " metric--danger";

  return (
    <div className="page fade-in">
      <PageHeader eyebrow="Read-only assurance workspace" title="Audit room" description={DESCRIPTION} />

      <div className="audit-scope">
        <Icons.shield />
        <div>
          <small>Audit scope</small>
          <strong>
            {tenantName} · chain {integrity.scope} · {events.length} recorded {events.length === 1 ? "event" : "events"} ·
            verified in this page load at {checkedAt}
          </strong>
        </div>
      </div>

      <section className="metrics-grid" aria-label="Ledger summary">
        <div className={`metric${integrityTone}`}>
          <span>Ledger integrity</span>
          <strong>{integrityState}</strong>
          <small>
            {empty
              ? `Nothing to verify · scope ${integrity.scope}`
              : integrity.valid
                ? `${integrity.checked} ${integrity.checked === 1 ? "event" : "events"} checked · scope ${integrity.scope} · every HMAC recomputed and every link matched`
                : `Failed after ${integrity.checked} ${integrity.checked === 1 ? "event" : "events"} · scope ${integrity.scope} · ${integrity.reason ? reasonSummary[integrity.reason].toLowerCase() : "verification failed"} at ${integrity.invalidEventId ?? "an unidentified event"}`}
          </small>
        </div>
        <div className="metric">
          <span>Events in scope</span>
          <strong>{events.length}</strong>
          <small>
            {empty ? "No events recorded yet" : `${recent.length} most recent listed below`}
          </small>
        </div>
        <div className="metric">
          <span>Distinct actions</span>
          <strong>{actions.length}</strong>
          <small>Action types recorded in this tenant&rsquo;s ledger</small>
        </div>
        <div className={`metric${flagged > 0 ? " metric--warning" : ""}`}>
          <span>Denied or failed</span>
          <strong>{flagged}</strong>
          <small>
            {outcomes.success ?? 0} success · {outcomes.allowed ?? 0} allowed
          </small>
        </div>
      </section>

      <div className="audit-layout">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Append-only ledger</p>
              <h2>Recorded events</h2>
            </div>
            <a href="/api/audit">Ledger JSON</a>
          </div>
          {empty ? (
            <p className="muted">No audit events have been recorded for this tenant yet.</p>
          ) : (
            <>
              <div className="table-scroll" role="region" aria-label="Audit event ledger" tabIndex={0}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Occurred (UTC) and event id</th>
                      <th scope="col">Action</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Resource</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Previous hash</th>
                      <th scope="col">Hash</th>
                      <th scope="col">Request id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <strong>{stamp(event.occurredAt)}</strong>
                          <span className="muted">{event.id}</span>
                        </td>
                        <td>{event.action}</td>
                        <td>
                          <Badge tone={outcomeTone[event.outcome]}>{event.outcome}</Badge>
                        </td>
                        <td>
                          <div>{event.resourceType}</div>
                          <div className="muted">{event.resourceId ?? "no resource id"}</div>
                        </td>
                        <td>
                          {event.actorUserId ? (displayNames.get(event.actorUserId) ?? event.actorUserId) : "System"}
                        </td>
                        <td className="muted" title={event.previousHash}>
                          {shortHash(event.previousHash)}
                        </td>
                        <td title={event.hash}>{shortHash(event.hash)}</td>
                        <td className="muted" title={event.requestId}>
                          {shortHash(event.requestId)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                <span>
                  {recent.length} most recent of {events.length}, newest first. Each row&rsquo;s previous hash is the hash of
                  the row beneath it.
                </span>
                <span>Hashes and request ids are truncated for display.</span>
              </div>
            </>
          )}
        </section>

        <aside className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Chain verification</p>
              <h2>What was checked</h2>
            </div>
          </div>
          <dl className="fact-list">
            <div>
              <dt>Result</dt>
              <dd>{empty ? "Nothing to verify" : integrity.valid ? "Valid" : "Invalid"}</dd>
            </div>
            <div>
              <dt>Events checked</dt>
              <dd>{integrity.checked}</dd>
            </div>
            <div>
              <dt>Chain scope</dt>
              <dd>{integrity.scope}</dd>
            </div>
            <div>
              <dt>Signature</dt>
              <dd>HMAC-SHA256</dd>
            </div>
            <div>
              <dt>Checked at</dt>
              <dd>{checkedAt}</dd>
            </div>
            {!integrity.valid && integrity.invalidEventId && (
              <div>
                <dt>First bad event</dt>
                <dd>{integrity.invalidEventId}</dd>
              </div>
            )}
            {!integrity.valid && integrity.reason && (
              <div>
                <dt>Reason</dt>
                <dd>{reasonSummary[integrity.reason]}</dd>
              </div>
            )}
          </dl>
          <p className="muted">
            {empty
              ? "This tenant has no audit events, so there is no chain to verify and no integrity claim to make."
              : integrity.valid
                ? `All ${integrity.checked} ${integrity.checked === 1 ? "event" : "events"} in this tenant's chain recomputed to the HMAC stored with them, and each event's previous hash matched the hash of its predecessor. The check covers the whole tenant chain, not only the rows listed.`
                : (integrity.reason ? reasonDetail[integrity.reason] : "Verification stopped before the chain could be confirmed.")}
          </p>
          <h3>Actions recorded</h3>
          {actions.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <dl className="fact-list">
              {actions.map(([action, count]) => (
                <div key={action}>
                  <dt>{action}</dt>
                  <dd>{count}</dd>
                </div>
              ))}
            </dl>
          )}
        </aside>
      </div>

      {guardrail}
    </div>
  );
}
