import { appendAuditWithin } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { json, problem, requestId } from "@/lib/server/http";
import {
  ENROLLMENT_DUE_HORIZON_DAYS,
  EVIDENCE_EXPIRY_HORIZON_DAYS,
  SIGNAL_TRIAGE_HORIZON_DAYS,
  sweepNotifications,
} from "@/lib/server/notifications";
import { mutateDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the reminder sweep.
 *
 * THERE IS NO SCHEDULER IN THIS BUILD. Nothing calls this on a timer, no cron
 * job exists, and the notification list is therefore only as current as the last
 * time a person ran this endpoint. That is stated in the response body as well
 * as here, because a chasing system that quietly stopped chasing would look
 * exactly like a chasing system with nothing to chase.
 *
 * It is an operational action rather than a domain one, so it requires
 * `platform:read` and CSRF, and it is confined to the caller's own tenant: an
 * operator in one workspace must not raise, refresh or resolve rows in another.
 *
 * The sweep and its ledger entry share one mutation. Recording the run
 * afterwards would leave a window in which reminders changed with nothing in
 * the audit trail saying who caused it.
 */
export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    authorize(principal, "platform:read", { tenantId: principal.tenantId });

    const ranAt = new Date();
    const result = await mutateDatabase((state) => {
      const outcome = sweepNotifications(state, ranAt, { tenantId: principal.tenantId });
      appendAuditWithin(state, {
        tenantId: principal.tenantId, actorUserId: principal.user.id, action: "notification.sweep",
        resourceType: "notification", resourceId: null, outcome: "success", requestId: rid,
        metadata: {
          raised: outcome.raised,
          resolved: outcome.resolved,
          refreshed: outcome.refreshed,
          open: outcome.open,
          unroutable: outcome.unroutable,
        },
      });
      return outcome;
    });

    return json({
      raised: result.raised,
      resolved: result.resolved,
      refreshed: result.refreshed,
      open: result.open,
      unroutable: result.unroutable,
      tenantId: principal.tenantId,
      horizonDays: {
        evidenceExpiry: EVIDENCE_EXPIRY_HORIZON_DAYS,
        enrollmentDue: ENROLLMENT_DUE_HORIZON_DAYS,
        signalTriage: SIGNAL_TRIAGE_HORIZON_DAYS,
      },
      scheduler: "none",
      note: "No scheduler runs this sweep. Notifications are only as current as the last time this endpoint was called, and running it again is safe - identical state produces no new rows.",
      ranAt: ranAt.toISOString(),
    });
  } catch (error) { return problem(error, rid); }
}
