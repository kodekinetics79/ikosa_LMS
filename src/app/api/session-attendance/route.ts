import { assertCsrf, principalFromRequest } from "@/lib/server/auth";
import {
  recordAttendance, registerLearners,
  type AttendanceEntry, type AttendanceStatus,
} from "@/lib/server/sessions/scheduling";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is expected at a session, and who actually turned up.
 *
 * Nothing here reads a provider's attendance report, because there is no
 * provider. Every observation is a statement by the authenticated caller, and
 * the store writes their id into `recorded_by` — the request body cannot supply
 * one. Registration and recording are separate verbs on purpose: a registration
 * is an expectation, and only the second is evidence.
 *
 * No role gate in this route. Registration is restricted to schedulers inside
 * `registerLearners`, while recording is open to a scheduler OR the instructor
 * named on the session — and an instructor holds no distinguishing platform
 * role, so only the session row can answer that question.
 */

function idList(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("Validation failed", { [field]: "Name at least one person" });
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ValidationError("Validation failed", { [field]: `Entry ${index + 1} is not an identifier` });
    }
    return item.trim();
  });
}

function attendanceEntries(body: Record<string, unknown>): AttendanceEntry[] {
  const value = body.entries;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("Validation failed", { entries: "Send at least one attendance entry" });
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidationError("Validation failed", { entries: `Entry ${index + 1} is not an object` });
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.subjectUserId !== "string" || !entry.subjectUserId.trim()) {
      throw new ValidationError("Validation failed", { entries: `Entry ${index + 1} is missing subjectUserId` });
    }
    if (typeof entry.status !== "string") {
      throw new ValidationError("Validation failed", { entries: `Entry ${index + 1} is missing status` });
    }
    const minutes = entry.minutesAttended;
    return {
      subjectUserId: entry.subjectUserId.trim(),
      // The vocabulary itself is checked in the store against the same list the
      // CHECK constraint holds, so this route cannot drift from the schema.
      status: entry.status.trim() as AttendanceStatus,
      minutesAttended: minutes === undefined || minutes === null ? undefined : Number(minutes),
      note: typeof entry.note === "string" ? entry.note : "",
    };
  });
}

/** Register people for a session. Idempotent: re-sending a list adds nobody twice. */
export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    if (action !== "register") throw new ValidationError("Validation failed", { action: "Must be: register" });
    const result = await registerLearners(
      principal,
      requiredString(body, "sessionId", 100),
      idList(body, "userIds"),
      rid,
    );
    return json(result);
  } catch (error) { return problem(error, rid); }
}

/** Record what happened. The caller's id becomes `recorded_by`; the body cannot set it. */
export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    if (action !== "record") throw new ValidationError("Validation failed", { action: "Must be: record" });
    const result = await recordAttendance(
      principal,
      requiredString(body, "sessionId", 100),
      attendanceEntries(body),
      rid,
    );
    return json(result);
  } catch (error) { return problem(error, rid); }
}
