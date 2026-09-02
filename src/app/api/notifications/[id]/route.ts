import { appendAuditWithin } from "@/lib/server/audit";
import { assertCsrf, AuthError, principalFromRequest } from "@/lib/server/auth";
import { assertScoped } from "@/lib/server/domain-service";
import { json, objectBody, problem, requestId, ValidationError } from "@/lib/server/http";
import { canChangeReadState, notificationsOf, setReadState } from "@/lib/server/notifications";
import { mutateDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marks one notification read or unread.
 *
 * Three gates, in order, and each one refuses something the others do not:
 *
 *   1. `assertCsrf` - the request has to come from this application, not from a
 *      page the recipient merely happened to visit.
 *   2. `assertScoped` - the tenant boundary and the delegated organizational
 *      scope, evaluated on the row itself rather than on the route.
 *   3. `canChangeReadState` - the caller must BE the recipient. This is stricter
 *      than the scoping above deliberately: a manager or administrator can read
 *      rows belonging to their people, and if that also let them clear those
 *      rows, a reminder could vanish from the list of the only person able to
 *      act on it. Read state is personal.
 *
 * The read flag, the row lookup and the ledger entry all run inside one
 * mutation, so a change to the record and its audit event land together.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const { id } = await context.params;

    const body = await objectBody(request);
    if (typeof body.read !== "boolean") {
      throw new ValidationError("Validation failed", { read: "Must be true or false" });
    }
    const read = body.read;

    const notification = await mutateDatabase((state) => {
      const row = notificationsOf(state).find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
      if (!row) throw new ValidationError("Validation failed", { id: "Notification not found in tenant" });

      assertScoped(state, principal, "notification:update", row);
      if (!canChangeReadState(row, principal.user.id)) {
        throw new AuthError(403, "Only the recipient may change the read state of a notification");
      }

      setReadState(row, read);
      appendAuditWithin(state, {
        tenantId: principal.tenantId, actorUserId: principal.user.id, action: "notification.update",
        resourceType: "notification", resourceId: row.id, outcome: "success", requestId: rid,
        metadata: { read, kind: row.kind, dedupeKey: row.dedupeKey },
      });
      return row;
    });

    return json({ notification, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
