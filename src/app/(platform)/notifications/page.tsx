import Link from "next/link";
import { revalidatePath } from "next/cache";
import { PageHeader } from "@/components/ui";
import { appendAuditWithin } from "@/lib/server/audit";
import { authorize, principalFromCookies } from "@/lib/server/auth";
import type { Notification } from "@/lib/server/domain";
import { assertScoped, visibleRows } from "@/lib/server/domain-service";
import {
  canChangeReadState,
  compareNotifications,
  ENROLLMENT_DUE_HORIZON_DAYS,
  EVIDENCE_EXPIRY_HORIZON_DAYS,
  NOTIFICATION_KIND_LABEL,
  notificationsOf,
  setReadState,
  SIGNAL_TRIAGE_HORIZON_DAYS,
  sweepNotifications,
} from "@/lib/server/notifications";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export const metadata = { title: "Notifications" };

/**
 * The recipient's chase list.
 *
 * Everything here is a derived Notification from the tenant's own datastore,
 * addressed to the signed-in user. There is no "you're all caught up" flourish:
 * an empty list is stated for what it actually is - either no condition applied
 * when the sweep last ran, or the sweep has not been run - because nothing in
 * this build runs it on a schedule.
 *
 * Urgency is carried in words on every row. The coloured bar beside each item is
 * decorative and hidden from assistive technology; a reader who cannot see it
 * loses nothing.
 */

const SEVERITY_LABEL: Record<Notification["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * Where the row's underlying record lives. Evidence and signals are registers
 * rather than per-record screens in this build, so the label says so instead of
 * promising a deep link the route cannot honour.
 */
function recordLink(notification: Notification): { href: string; label: string } | null {
  switch (notification.resourceType) {
    case "enrollment": return { href: `/learning/${notification.resourceId}`, label: "Open the course" };
    case "intervention": return { href: `/interventions/${notification.resourceId}`, label: "Open the intervention" };
    case "evidence": return { href: "/evidence", label: "Open the evidence register" };
    case "signal": return { href: "/signals", label: "Open the signal inbox" };
    default: return null;
  }
}

/**
 * Changes the read state of one notification.
 *
 * A Server Function is reachable by direct POST, so authorization is re-resolved
 * from the session cookie here and the ownership rule is re-applied on the row -
 * exactly as `PATCH /api/notifications/[id]` does. Neither surface trusts the
 * other, and both refuse a caller who is not the recipient.
 */
async function updateReadState(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id") ?? "");
  const read = formData.get("read") === "true";
  const principal = await principalFromCookies();
  const requestId = crypto.randomUUID();

  await mutateDatabase((state) => {
    const row = notificationsOf(state).find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
    if (!row) return;
    assertScoped(state, principal, "notification:update", row);
    if (!canChangeReadState(row, principal.user.id)) {
      throw new Error("Only the recipient may change the read state of a notification");
    }
    setReadState(row, read);
    appendAuditWithin(state, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "notification.update",
      resourceType: "notification", resourceId: row.id, outcome: "success", requestId,
      metadata: { read, kind: row.kind, dedupeKey: row.dedupeKey, surface: "notifications_page" },
    });
  });

  revalidatePath("/notifications");
}

/**
 * Runs the sweep for the caller's own tenant.
 *
 * The screen carries this control because there is no scheduler: without it the
 * only way to refresh the list would be to call the API by hand, and a list
 * nobody can refresh is a list nobody should trust.
 */
async function runSweep(): Promise<void> {
  "use server";
  const principal = await principalFromCookies();
  authorize(principal, "platform:read", { tenantId: principal.tenantId });
  const requestId = crypto.randomUUID();
  const ranAt = new Date();

  await mutateDatabase((state) => {
    const outcome = sweepNotifications(state, ranAt, { tenantId: principal.tenantId });
    appendAuditWithin(state, {
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "notification.sweep",
      resourceType: "notification", resourceId: null, outcome: "success", requestId,
      metadata: {
        raised: outcome.raised, resolved: outcome.resolved, refreshed: outcome.refreshed,
        open: outcome.open, unroutable: outcome.unroutable, surface: "notifications_page",
      },
    });
  });

  revalidatePath("/notifications");
}

export default async function Notifications() {
  const principal = await principalFromCookies();
  const db = await readDatabase();

  // Same scoping the API applies - tenant, delegated organizational path and
  // learner self-scope - then narrowed to the signed-in user, because this
  // screen answers "what is being chased from me".
  const mine = visibleRows(db, principal, "notification:read", notificationsOf(db))
    .filter((row) => row.subjectUserId === principal.user.id);

  const open = mine.filter((row) => row.resolvedAt === null).sort(compareNotifications);
  const unread = open.filter((row) => row.readAt === null);
  const read = open.filter((row) => row.readAt !== null);
  const settled = mine
    .filter((row) => row.resolvedAt !== null)
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));
  const pressing = open.filter((row) => row.severity === "critical" || row.severity === "high").length;

  const tenantName = db.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? "this workspace";

  return (
    <div className="page fade-in">
      <PageHeader
        eyebrow={`${tenantName} · reminders`}
        title="Notifications"
        description="Evidence about to lapse, courses falling due, interventions running late and change signals nobody has triaged - derived from the records themselves rather than raised by hand."
        actions={
          <form action={runSweep}>
            <button type="submit" className="button secondary">Run the reminder sweep</button>
          </form>
        }
      />

      <div className="stat-strip">
        <div><span>Unread</span><strong>{unread.length}</strong></div>
        <div><span>Outstanding</span><strong>{open.length}</strong></div>
        <div><span>Critical or high urgency</span><strong>{pressing}</strong></div>
        <div><span>Resolved and kept as history</span><strong>{settled.length}</strong></div>
      </div>

      {open.length === 0 ? (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Chase list</p>
              <h2>Nothing is outstanding for you</h2>
            </div>
          </div>
          <p className="muted">
            No reminder addressed to {principal.user.displayName} is outstanding in {tenantName}.
          </p>
          <p className="inline-note">
            This does not by itself mean nothing needs chasing. Reminders are derived from current records by a sweep,
            and no scheduler runs that sweep in this build - so an empty list means either that no condition applied
            when the sweep was last run, or that it has not been run since the records changed. Use
            &ldquo;Run the reminder sweep&rdquo; above, or POST to /api/notifications/sweep, to bring it up to date.
          </p>
        </section>
      ) : null}

      {unread.length > 0 && (
        <NotificationPanel
          eyebrow="Needs your attention"
          heading="Unread"
          note={`Ordered by urgency, then by the soonest deadline. Evidence is chased ${EVIDENCE_EXPIRY_HORIZON_DAYS} days before it lapses, courses ${ENROLLMENT_DUE_HORIZON_DAYS} days before they fall due, and untriaged signals ${SIGNAL_TRIAGE_HORIZON_DAYS} days before the change takes effect.`}
          rows={unread}
          unread
        />
      )}

      {read.length > 0 && (
        <NotificationPanel
          eyebrow="Still outstanding"
          heading="Read"
          note="You have seen these, but the condition behind each one still holds. They disappear from this list only when the underlying record changes and the sweep resolves them."
          rows={read}
          unread={false}
        />
      )}

      {settled.length > 0 && (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Closed out</p>
              <h2>No longer applies</h2>
            </div>
            <span className="count-badge">{settled.length}</span>
          </div>
          <p className="inline-note">
            The condition behind each of these has gone - the evidence was renewed, the course was completed, the signal
            was triaged. They are marked resolved rather than deleted, so the record of having chased them survives.
          </p>
          <div className="record-list">
            {settled.slice(0, 5).map((row) => (
              <div key={row.id} className="record-row">
                <span className={`severity-mark severity-mark--${row.severity}`} aria-hidden="true" />
                <div className="record-main">
                  <strong>{row.title}</strong>
                  <span className="record-meta">
                    <span>{NOTIFICATION_KIND_LABEL[row.kind]}</span>
                    <span>Resolved {(row.resolvedAt ?? "").slice(0, 10)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
          {settled.length > 5 && (
            <div className="panel-foot">
              <p>Showing the 5 most recently resolved of {settled.length}.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function NotificationPanel({ eyebrow, heading, note, rows, unread }: {
  eyebrow: string;
  heading: string;
  note: string;
  rows: Notification[];
  unread: boolean;
}) {
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="panel-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{heading}</h2>
        </div>
        <span className="count-badge">{rows.length}</span>
      </div>
      <p className="inline-note">{note}</p>
      <div className="notification-list">
        {rows.map((row) => {
          const link = recordLink(row);
          return (
            <article key={row.id} className={`notification ${unread ? "notification--unread" : ""}`}>
              <span className={`severity-mark severity-mark--${row.severity}`} aria-hidden="true" />
              <div className="record-main">
                <strong>{row.title}</strong>
                <span className="record-meta">
                  <span>{SEVERITY_LABEL[row.severity]} urgency</span>
                  <span>{NOTIFICATION_KIND_LABEL[row.kind]}</span>
                  {row.dueAt && <span>Dated {row.dueAt.slice(0, 10)}</span>}
                  <span>Raised {row.createdAt.slice(0, 10)}</span>
                </span>
                <p>{row.body}</p>
              </div>
              <div className="notification-actions">
                {link && <Link className="text-button" href={link.href}>{link.label}</Link>}
                <form action={updateReadState}>
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="read" value={unread ? "true" : "false"} />
                  <button
                    type="submit"
                    className="text-button"
                    aria-label={`Mark "${row.title}" as ${unread ? "read" : "unread"}`}
                  >
                    {unread ? "Mark as read" : "Mark as unread"}
                  </button>
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
