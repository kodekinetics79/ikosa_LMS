import { principalFromRequest } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { json, problem, requestId } from "@/lib/server/http";
import { compareNotifications, notificationsOf } from "@/lib/server/notifications";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller's own reminder list.
 *
 * Scoping runs through `visibleRows`, which applies the tenant boundary, the
 * delegated organizational scope and - because a Notification carries
 * `subjectUserId` - the learner self-scope, all without this handler restating
 * any of it. On top of that the list is narrowed to the signed-in user, because
 * this endpoint answers "what is being chased from ME", not "what is being
 * chased in my team": a manager reading their own list should not have it
 * padded with reminders they cannot action.
 *
 * Resolved notifications are excluded by default. A resolved row is history -
 * the condition behind it has gone - and mixing history into a to-do list is
 * how a chase list becomes background noise. `?resolved=true` returns exactly
 * that history, which is also the proof that resolution preserves rows rather
 * than deleting them.
 */
export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get("unread") === "true";
    const resolvedOnly = url.searchParams.get("resolved") === "true";

    const db = await readDatabase();
    const mine = visibleRows(db, principal, "notification:read", notificationsOf(db))
      .filter((row) => row.subjectUserId === principal.user.id);

    const items = mine
      .filter((row) => (resolvedOnly ? row.resolvedAt !== null : row.resolvedAt === null))
      .filter((row) => (unreadOnly ? row.readAt === null : true))
      .sort(compareNotifications);

    const open = mine.filter((row) => row.resolvedAt === null);

    return json({
      items,
      counts: {
        open: open.length,
        unread: open.filter((row) => row.readAt === null).length,
        resolved: mine.length - open.length,
      },
      filters: { unread: unreadOnly, resolved: resolvedOnly },
      // Stated so a client never reads an empty list as "nothing is wrong".
      // Nothing in this build runs the sweep on a schedule.
      derivedBy: "POST /api/notifications/sweep (no scheduler runs it automatically)",
      asOf: new Date().toISOString(),
    });
  } catch (error) { return problem(error, rid); }
}
