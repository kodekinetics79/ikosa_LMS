import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import {
  createSession, listSessions, sessionRoster, updateSession,
  type SessionPatch,
} from "@/lib/server/sessions/scheduling";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled sessions.
 *
 * There is no video provider behind any of this. A session records WHEN a class
 * happens, WHERE the link points and WHO is expected; nothing here creates a
 * meeting or asks a provider who joined. `provider` is fixed at 'manual' by the
 * schema and is deliberately not accepted from the request body, so no client
 * can store a value implying an integration that does not exist.
 */

/** Cheap first gate. `createSession`/`updateSession` re-check and also enforce org scope. */
function requireScheduler(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "tna_analyst")) {
    throw new AuthError(403, "Session scheduling permission required");
  }
}

function optionalText(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError("Validation failed", { [field]: "Must be text" });
  if (value.length > max) throw new ValidationError("Validation failed", { [field]: `Must be ${max} characters or fewer` });
  return value;
}

/**
 * `undefined` means "leave alone" and `null` means "clear it". Collapsing the
 * two would make it impossible to unassign an instructor: every PATCH that
 * omitted the field would silently re-send the current value, and every PATCH
 * that cleared it would look like an omission.
 */
function optionalId(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("Validation failed", { [field]: "Must be an identifier" });
  return value.trim();
}

function optionalNumber(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new ValidationError("Validation failed", { [field]: "Must be a whole number" });
  return parsed;
}

/**
 * The calendar, or one session's roster.
 *
 * No role gate: `listSessions` answers a different question for a scheduler
 * (everything they administer) than for everyone else (only what is delivered
 * to them, and never a cancelled class). `?sessionId=` returns the roster,
 * which names people and is gated inside `sessionRoster` on the authority to
 * record attendance.
 */
export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("sessionId");
    if (sessionId) return json(await sessionRoster(principal, sessionId));
    const items = await listSessions(principal, {
      from: params.get("from"),
      to: params.get("to"),
      courseId: params.get("courseId"),
    });
    return json({ items, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireScheduler(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const session = await createSession(principal, {
      orgUnitId: requiredString(body, "orgUnitId", 100),
      courseId: optionalId(body, "courseId") ?? null,
      moduleId: optionalId(body, "moduleId") ?? null,
      title: requiredString(body, "title", 300),
      description: optionalText(body, "description", 5000) ?? "",
      instructorUserId: optionalId(body, "instructorUserId") ?? null,
      startsAt: requiredString(body, "startsAt", 60),
      endsAt: requiredString(body, "endsAt", 60),
      timeZone: optionalText(body, "timeZone", 100) ?? "UTC",
      // Validated in the store against the adapters that actually exist, so a
      // client sending "zoom" is refused rather than left believing a meeting
      // was created.
      provider: optionalText(body, "provider", 20) ?? "manual",
      joinUrl: optionalText(body, "joinUrl", 2000) ?? "",
      capacity: optionalNumber(body, "capacity") ?? null,
    }, rid);
    return json(session, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

/**
 * Correct a session, or move it out of 'scheduled'.
 *
 * 'cancel' and 'complete' are separate actions rather than a free-text status
 * because they are the two transitions a UI offers as buttons, and naming them
 * keeps a mistyped status from silently doing nothing. Everything else about a
 * session is edited through 'update'.
 */
export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireScheduler(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    const sessionId = requiredString(body, "sessionId", 100);

    let patch: SessionPatch;
    if (action === "cancel") patch = { status: "cancelled" };
    else if (action === "complete") patch = { status: "completed" };
    else if (action === "update") {
      patch = {
        title: optionalText(body, "title", 300),
        description: optionalText(body, "description", 5000),
        startsAt: optionalText(body, "startsAt", 60),
        endsAt: optionalText(body, "endsAt", 60),
        timeZone: optionalText(body, "timeZone", 100),
        instructorUserId: optionalId(body, "instructorUserId"),
        capacity: optionalNumber(body, "capacity"),
        joinUrl: optionalText(body, "joinUrl", 2000),
        status: body.status === undefined ? undefined : (requiredString(body, "status", 20) as SessionPatch["status"]),
      };
    } else {
      throw new ValidationError("Validation failed", { action: "Must be one of: update, cancel, complete" });
    }

    return json(await updateSession(principal, sessionId, patch, rid));
  } catch (error) { return problem(error, rid); }
}
