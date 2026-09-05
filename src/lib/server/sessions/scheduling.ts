import "server-only";

/**
 * Scheduled sessions, and the attendance record they produce.
 *
 * WHAT THIS IS AND IS NOT
 *
 * Migration 009 admits exactly one value for `provider` — 'manual'. Nothing in
 * this module creates a meeting, issues a token, or reads a provider's
 * attendance report, because there is no provider integration to read from.
 * `join_url` is a link a human pasted, and attendance is what a named person
 * says happened. That is why every observation carries `recorded_by`: an
 * "attended" nobody signed is not evidence of anything, and the schema CHECK
 * refuses to store one. Describing this as "live classes" would be a claim the
 * code cannot support.
 *
 * AUTHORITY, IN ONE PLACE
 *
 * Two different questions are asked of the org tree and both are needed:
 * `roots` (`ou.path <@ ANY(roots)`) is what the caller administers, and
 * `viewer` (`ou.path @> viewer`) is what is delivered down to the caller. A
 * scheduler works in the first; a learner reads the calendar through the
 * second.
 */

import type { Principal } from "../auth";
import { conflict, forbidden, notFound, outOfRange } from "../errors";
import type { PoolClient } from "../db/driver";
import { toStorageId } from "../db/ids";
import {
  appendAssessmentAudit, iso, isoOrNull, num, numOrNull, readTx, scopePaths, writeTx,
} from "../assessment/runtime";

export const SESSION_STATUSES = ["scheduled", "live", "completed", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ATTENDANCE_STATUSES = ["registered", "attended", "partial", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export type LiveSession = {
  id: string;
  orgUnitId: string;
  courseId: string | null;
  courseTitle: string | null;
  moduleId: string | null;
  title: string;
  description: string;
  instructorUserId: string | null;
  instructorName: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  /**
   * Always 'manual'. Kept in the payload so a client never has to assume it,
   * and so the day an integration exists the change is visible in the data
   * rather than implied by a UI label.
   */
  provider: "manual";
  joinUrl: string;
  capacity: number | null;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSummary = LiveSession & {
  /**
   * Everyone on the roster, whatever their attendance state — not just rows
   * still sitting at status 'registered'. A strict count of that status falls
   * to zero as attendance is recorded, which would make it useless as the
   * denominator every caller wants it for.
   */
  registeredCount: number;
  /** Rows a recorder marked 'attended'. 'partial' is a different observation and is not folded in here. */
  attendedCount: number;
};

export type RosterEntry = {
  subjectUserId: string;
  displayName: string;
  email: string;
  status: AttendanceStatus;
  joinedAt: string | null;
  leftAt: string | null;
  minutesAttended: number;
  note: string;
  recordedBy: string | null;
  recordedByName: string | null;
  recordedAt: string | null;
};

export type SessionRosterView = {
  session: SessionSummary;
  roster: RosterEntry[];
  /** The scheduled length in whole minutes, rounded up — the cap `recordAttendance` applies. */
  scheduledMinutes: number;
};

export type CreateSessionInput = {
  orgUnitId: string;
  courseId?: string | null;
  moduleId?: string | null;
  title: string;
  description?: string;
  instructorUserId?: string | null;
  startsAt: string;
  endsAt: string;
  timeZone?: string;
  joinUrl?: string;
  capacity?: number | null;
};

export type SessionPatch = {
  title?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  timeZone?: string;
  instructorUserId?: string | null;
  capacity?: number | null;
  joinUrl?: string;
  status?: SessionStatus;
};

export type AttendanceEntry = {
  subjectUserId: string;
  status: AttendanceStatus;
  minutesAttended?: number;
  note?: string;
};

export type ListSessionOptions = {
  from?: string | null;
  to?: string | null;
  courseId?: string | null;
};

/* ---------------------------------------------------------------------------
 * Permission.
 *
 * Deliberately NOT `canAuthorAssessments`, which happens to hold the same two
 * roles today. Scheduling and assessment authoring are separate authorities
 * that will diverge — sessions are the surface an instructor role lands on
 * first — and sharing one predicate would mean granting that role the power to
 * write exam questions as a side effect.
 * ------------------------------------------------------------------------- */

const canScheduleSessions = (principal: Principal): boolean =>
  principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst");

function requireScheduler(principal: Principal): void {
  if (!canScheduleSessions(principal)) throw forbidden("Session scheduling permission required");
}

/* ---------------------------------------------------------------------------
 * Input validation, before anything reaches a constraint.
 * ------------------------------------------------------------------------- */

/**
 * Every identifier crossing this boundary, in the form the uuid columns store.
 *
 * Ids arrive in either representation — a uuid, or one of the legacy
 * `usr_…`/`crs_…` handles migration 001 mapped deterministically onto uuids —
 * and handing a raw handle to a `::uuid` cast raises 22P02, which `problem()`
 * serves as an opaque 500. The caller would be told the server broke when in
 * fact their id simply needed translating.
 */
function storageId(value: unknown, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw outOfRange(`${label} is required`);
  return toStorageId(trimmed);
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw outOfRange(`${label} must be an ISO 8601 date and time`);
  return parsed;
}

/**
 * The stored zone decides how a session reads for a distributed cohort. A zone
 * the runtime cannot resolve renders as the server's own, which silently moves
 * the class for everyone who is not in that zone.
 */
function assertTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw outOfRange(`"${zone}" is not an IANA time zone name (for example "Europe/London")`);
  }
  return zone;
}

/**
 * The join link is rendered as an anchor for everyone on the roster, so a
 * `javascript:` or `data:` URL stored here would run in their session.
 */
function assertJoinUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw outOfRange("The join link must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw outOfRange("The join link must use http or https");
  }
  return trimmed;
}

function assertCapacity(capacity: number | null | undefined): number | null {
  if (capacity === null || capacity === undefined) return null;
  // The column is CHECK (capacity > 0); refusing here gives a reason rather
  // than a constraint violation surfaced as a 500.
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 100000) {
    throw outOfRange("Capacity must be a whole number between 1 and 100000");
  }
  return capacity;
}

/** The schema enforces this too. Refusing first means the author gets a sentence, not a constraint name. */
function assertWindow(startsAt: number, endsAt: number): void {
  if (endsAt <= startsAt) throw outOfRange("The session must end after it starts");
}

const scheduledMinutesOf = (row: Record<string, unknown>): number =>
  Math.max(1, Math.ceil((new Date(iso(row.ends_at)).getTime() - new Date(iso(row.starts_at)).getTime()) / 60000));

/* ---------------------------------------------------------------------------
 * Row mapping.
 * ------------------------------------------------------------------------- */

function toSession(row: Record<string, unknown>): LiveSession {
  return {
    id: String(row.id),
    orgUnitId: String(row.org_unit_id),
    courseId: row.course_id ? String(row.course_id) : null,
    courseTitle: row.course_title ? String(row.course_title) : null,
    moduleId: row.module_id ? String(row.module_id) : null,
    title: String(row.title),
    description: String(row.description ?? ""),
    instructorUserId: row.instructor_user_id ? String(row.instructor_user_id) : null,
    instructorName: row.instructor_name ? String(row.instructor_name) : null,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    timeZone: String(row.time_zone),
    provider: "manual",
    joinUrl: String(row.join_url ?? ""),
    capacity: numOrNull(row.capacity),
    status: String(row.status) as SessionStatus,
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const toSummary = (row: Record<string, unknown>): SessionSummary => ({
  ...toSession(row),
  registeredCount: num(row.registered_count ?? 0),
  attendedCount: num(row.attended_count ?? 0),
});

/**
 * The counts are aggregated in one lateral pass over
 * `session_attendance_subject`, not by returning roster rows for the caller to
 * count. A calendar of forty sessions would otherwise pull every attendance row
 * in the tenant across the wire to render two numbers per card.
 */
const SESSION_SELECT = `
  SELECT s.id, s.org_unit_id, s.course_id, s.module_id, s.title, s.description,
         s.instructor_user_id, s.starts_at, s.ends_at, s.time_zone, s.join_url,
         s.capacity, s.status, s.created_by, s.created_at, s.updated_at,
         c.title AS course_title, iu.display_name AS instructor_name,
         att.registered_count, att.attended_count
    FROM osa.live_sessions s
    JOIN osa.org_units ou ON ou.tenant_id = s.tenant_id AND ou.id = s.org_unit_id
    LEFT JOIN osa.courses c ON c.tenant_id = s.tenant_id AND c.id = s.course_id
    LEFT JOIN osa.users iu ON iu.tenant_id = s.tenant_id AND iu.id = s.instructor_user_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS registered_count,
             count(*) FILTER (WHERE a.status = 'attended')::int AS attended_count
        FROM osa.session_attendance a
       WHERE a.tenant_id = s.tenant_id AND a.session_id = s.id
    ) att ON true`;

/** One session with its aggregate counts, re-read after a write so the caller
 *  gets the course title and instructor name rather than bare ids. */
async function readSummary(client: PoolClient, sessionId: string): Promise<SessionSummary> {
  const { rows } = await client.query(`${SESSION_SELECT} WHERE s.id = $1::uuid`, [sessionId]);
  return toSummary(rows[0]);
}

/**
 * `roots` and `viewer` as query parameters, with the empty case turned into
 * NULL rather than an empty ltree.
 *
 * `''::ltree` is an ancestor of every path, so `ou.path @> ''` is TRUE for the
 * whole tenant. A principal with no delegated paths would therefore be shown
 * every session in the tenant by a plain `@>` test. NULL compares to nothing,
 * which is the correct default for a caller whose scope is unknown.
 */
function scopeParams(principal: Principal): { roots: string[]; viewer: string | null } {
  const { roots, viewer } = scopePaths(principal);
  return { roots, viewer: viewer || null };
}

/* ---------------------------------------------------------------------------
 * Reads.
 * ------------------------------------------------------------------------- */

/**
 * The sessions this caller may see.
 *
 * A scheduler sees everything at or below their delegated roots, in any state,
 * because a cancelled session is part of what they administer. Anyone else sees
 * only what is delivered to them and never a cancelled one — a class that is
 * not happening should not sit on a learner's calendar.
 *
 * The instructor of a session sees it regardless of either test. Instructors
 * are frequently attached to a session owned above their own organization, and
 * without this the person running the class could not find it.
 *
 * `from`/`to` select on OVERLAP, not on `starts_at` alone: a session that began
 * before the window and is still running is exactly what a "today" or "now"
 * view has to show.
 */
export async function listSessions(
  principal: Principal, opts: ListSessionOptions = {},
): Promise<SessionSummary[]> {
  const from = opts.from ? new Date(instant(opts.from, "The 'from' time")).toISOString() : null;
  const to = opts.to ? new Date(instant(opts.to, "The 'to' time")).toISOString() : null;
  if (from && to && Date.parse(to) < Date.parse(from)) throw outOfRange("The 'to' time must not be before the 'from' time");
  const courseId = opts.courseId ? storageId(opts.courseId, "Course") : null;

  return readTx(principal, async (client) => {
    const { roots, viewer } = scopeParams(principal);
    const { rows } = await client.query(
      `${SESSION_SELECT}
        WHERE ( ($3::boolean AND ou.path <@ ANY($1::ltree[]))
                OR s.instructor_user_id = $4::uuid
                OR (ou.path @> $2::ltree AND s.status <> 'cancelled') )
          AND ($5::timestamptz IS NULL OR s.ends_at >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR s.starts_at <= $6::timestamptz)
          AND ($7::uuid IS NULL OR s.course_id = $7::uuid)
        ORDER BY s.starts_at, s.title`,
      [roots, viewer, canScheduleSessions(principal), principalUserId(principal), from, to, courseId],
    );
    return rows.map(toSummary);
  });
}

/** The principal's own user id in the form the uuid columns store. */
function principalUserId(principal: Principal): string {
  return toStorageId(principal.user.id);
}

/**
 * Loads a session for someone who may RECORD against it: a scheduler with the
 * session inside their delegated roots, or the instructor named on it.
 *
 * 404 rather than 403 throughout: confirming that a session id exists would
 * disclose another organization's schedule to a caller with no authority over
 * it.
 */
async function loadSessionForRecorder(
  client: PoolClient, principal: Principal, sessionId: string, forUpdate: boolean,
): Promise<Record<string, unknown>> {
  const { roots } = scopeParams(principal);
  const { rows } = await client.query(
    `SELECT s.*, ou.path::text AS org_path
       FROM osa.live_sessions s
       JOIN osa.org_units ou ON ou.tenant_id = s.tenant_id AND ou.id = s.org_unit_id
      WHERE s.id = $1::uuid
        AND ( ($3::boolean AND ou.path <@ ANY($2::ltree[]))
              OR s.instructor_user_id = $4::uuid )
      ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    [sessionId, roots, canScheduleSessions(principal), principalUserId(principal)],
  );
  if (!rows[0]) throw notFound("Session not found, or you may not record attendance for it");
  return rows[0];
}

/** Loads a session the caller ADMINISTERS. Editing is a scheduler's act, not an instructor's. */
async function loadSessionForScheduler(
  client: PoolClient, principal: Principal, sessionId: string,
): Promise<Record<string, unknown>> {
  const { roots } = scopeParams(principal);
  const { rows } = await client.query(
    `SELECT s.* FROM osa.live_sessions s
       JOIN osa.org_units ou ON ou.tenant_id = s.tenant_id AND ou.id = s.org_unit_id
      WHERE s.id = $1::uuid AND ou.path <@ ANY($2::ltree[])
      FOR UPDATE OF s`,
    [sessionId, roots],
  );
  if (!rows[0]) throw notFound("Session not found in your scope");
  return rows[0];
}

/**
 * The session plus everyone on its roster and what was recorded about them.
 * Gated on the same authority as recording: the roster names people and states
 * whether they turned up, which is not a public property of the session.
 */
export async function sessionRoster(principal: Principal, sessionId: string): Promise<SessionRosterView> {
  const id = storageId(sessionId, "Session");
  return readTx(principal, async (client) => {
    const session = await loadSessionForRecorder(client, principal, id, false);
    const { rows: entries } = await client.query(
      `SELECT a.subject_user_id, a.status, a.joined_at, a.left_at, a.minutes_attended, a.note,
              a.recorded_by, a.recorded_at, u.display_name, u.email::text AS email,
              r.display_name AS recorded_by_name
         FROM osa.session_attendance a
         JOIN osa.users u ON u.tenant_id = a.tenant_id AND u.id = a.subject_user_id
         LEFT JOIN osa.users r ON r.tenant_id = a.tenant_id AND r.id = a.recorded_by
        WHERE a.session_id = $1::uuid
        ORDER BY u.display_name`,
      [id],
    );
    return {
      session: await readSummary(client, id),
      roster: entries.map((row) => ({
        subjectUserId: String(row.subject_user_id),
        displayName: String(row.display_name),
        email: String(row.email),
        status: String(row.status) as AttendanceStatus,
        joinedAt: isoOrNull(row.joined_at),
        leftAt: isoOrNull(row.left_at),
        minutesAttended: num(row.minutes_attended),
        note: String(row.note ?? ""),
        recordedBy: row.recorded_by ? String(row.recorded_by) : null,
        recordedByName: row.recorded_by_name ? String(row.recorded_by_name) : null,
        recordedAt: isoOrNull(row.recorded_at),
      })),
      scheduledMinutes: scheduledMinutesOf(session),
    };
  });
}

/* ---------------------------------------------------------------------------
 * Writes.
 * ------------------------------------------------------------------------- */

/**
 * Every id must resolve to a user this caller administers, or the whole call is
 * refused.
 *
 * Registering the subset that happens to be in scope and reporting success
 * would leave the caller believing they enrolled people they did not — nobody
 * checks a roster they were told was written. `sessionId` widens the test to
 * people already on that roster: an instructor may correct the attendance of
 * someone registered by a scheduler above them, which is the normal case.
 */
async function assertUsersWritable(
  client: PoolClient, principal: Principal, userIds: readonly string[], sessionId: string | null,
): Promise<void> {
  const { roots } = scopeParams(principal);
  const { rows } = await client.query<{ id: string }>(
    `SELECT u.id::text AS id
       FROM osa.users u
       JOIN osa.org_units ou ON ou.tenant_id = u.tenant_id AND ou.id = u.org_unit_id
      WHERE u.id = ANY($1::uuid[])
        AND u.active
        AND ( ou.path <@ ANY($2::ltree[])
              OR ( $3::uuid IS NOT NULL
                   AND EXISTS (SELECT 1 FROM osa.session_attendance a
                                WHERE a.tenant_id = u.tenant_id AND a.session_id = $3::uuid
                                  AND a.subject_user_id = u.id) ) )`,
    [userIds, roots, sessionId],
  );
  const found = new Set(rows.map((row) => row.id));
  const rejected = userIds.filter((id) => !found.has(id));
  if (rejected.length > 0) {
    throw forbidden(
      `${rejected.length} of ${userIds.length} ${rejected.length === 1 ? "person is" : "people are"} outside your scope, inactive, or unknown. Nobody was recorded.`,
    );
  }
}

/** Normalizes and de-duplicates a batch of user ids, refusing the whole call on a malformed one. */
function normalizeUserIds(userIds: readonly string[], label: string): string[] {
  if (!Array.isArray(userIds) || userIds.length === 0) throw outOfRange(`${label} must name at least one person`);
  if (userIds.length > 500) throw outOfRange(`${label} is limited to 500 people per call`);
  return [...new Set(userIds.map((value) => storageId(value, "Each person's user id")))];
}

/**
 * Schedules a session.
 *
 * `provider` is never taken from the caller: 'manual' is the only value the
 * schema admits, and accepting the field would invite a client to send 'zoom'
 * and believe a meeting had been created.
 *
 * A course owned ABOVE the scheduler is accepted, using the same visibility
 * rule delivery uses. Courses are authored centrally and run locally; a
 * roots-only test would make it impossible to schedule a session for the
 * courses most tenants actually run.
 */
export async function createSession(
  principal: Principal, input: CreateSessionInput, requestId: string,
): Promise<SessionSummary> {
  requireScheduler(principal);

  const title = String(input.title ?? "").trim();
  if (!title) throw outOfRange("A session needs a title");
  if (title.length > 300) throw outOfRange("The title must be 300 characters or fewer");
  const startsAt = instant(input.startsAt, "The start time");
  const endsAt = instant(input.endsAt, "The end time");
  assertWindow(startsAt, endsAt);
  const timeZone = assertTimeZone(String(input.timeZone ?? "UTC").trim() || "UTC");
  const joinUrl = assertJoinUrl(String(input.joinUrl ?? ""));
  const capacity = assertCapacity(input.capacity);
  const orgUnitId = storageId(input.orgUnitId, "Organization");
  const courseId = input.courseId ? storageId(input.courseId, "Course") : null;
  const moduleId = input.moduleId ? storageId(input.moduleId, "Module") : null;
  if (moduleId && !courseId) throw outOfRange("A module can only be attached alongside its course");

  return writeTx(principal, async (client) => {
    const { roots, viewer } = scopeParams(principal);

    const { rows: org } = await client.query(
      `SELECT ou.id FROM osa.org_units ou WHERE ou.id = $1::uuid AND ou.path <@ ANY($2::ltree[])`,
      [orgUnitId, roots],
    );
    if (!org[0]) throw notFound("Organization not found in your scope");

    if (courseId) {
      const { rows: course } = await client.query(
        `SELECT c.id FROM osa.courses c
           JOIN osa.org_units ou ON ou.tenant_id = c.tenant_id AND ou.id = c.org_unit_id
          WHERE c.id = $1::uuid AND (ou.path <@ ANY($2::ltree[]) OR ou.path @> $3::ltree)`,
        [courseId, roots, viewer],
      );
      if (!course[0]) throw notFound("Course not found in your scope");
    }
    if (moduleId && courseId) {
      // The schema's FK only proves the module exists in this tenant, and its
      // CHECK only proves a module was not attached without a course. Neither
      // proves the module belongs to THIS course, so a session could otherwise
      // claim to deliver module 3 of an unrelated course.
      const { rows: mod } = await client.query(
        `SELECT m.id FROM osa.course_modules m WHERE m.id = $1::uuid AND m.course_id = $2::uuid`,
        [moduleId, courseId],
      );
      if (!mod[0]) throw notFound("That module is not part of this course");
    }

    const instructorUserId = input.instructorUserId ? storageId(input.instructorUserId, "Instructor") : null;
    if (instructorUserId) await assertUsersWritable(client, principal, [instructorUserId], null);

    const { rows } = await client.query(
      `INSERT INTO osa.live_sessions
         (tenant_id, org_unit_id, course_id, module_id, title, description, instructor_user_id,
          starts_at, ends_at, time_zone, provider, join_url, capacity, status, created_by)
       SELECT ou.tenant_id, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
              $7::timestamptz, $8::timestamptz, $9, 'manual', $10, $11::integer, 'scheduled', $12::uuid
         FROM osa.org_units ou WHERE ou.id = $1::uuid
       RETURNING *`,
      [
        orgUnitId, courseId, moduleId, title, String(input.description ?? "").trim().slice(0, 5000),
        instructorUserId, new Date(startsAt).toISOString(), new Date(endsAt).toISOString(),
        timeZone, joinUrl, capacity, principalUserId(principal),
      ],
    );
    const created = rows[0];
    await appendAssessmentAudit(client, principal, requestId, "session.create", "live_session", String(created.id), {
      title, orgUnitId, courseId, moduleId, startsAt: iso(created.starts_at), endsAt: iso(created.ends_at),
      timeZone, capacity, instructorUserId,
    });
    return readSummary(client, String(created.id));
  });
}

/**
 * Corrects a session.
 *
 * A completed session is refused outright: its attendance rows are a record of
 * what happened, and moving the times or the instructor underneath them would
 * rewrite the circumstances of an observation somebody signed.
 */
export async function updateSession(
  principal: Principal, sessionId: string, patch: SessionPatch, requestId: string,
): Promise<SessionSummary> {
  requireScheduler(principal);
  const id = storageId(sessionId, "Session");

  return writeTx(principal, async (client) => {
    const current = await loadSessionForScheduler(client, principal, id);
    if (String(current.status) === "completed") {
      throw conflict("This session is completed and its attendance is a record. It can no longer be edited.");
    }

    const startsAt = patch.startsAt !== undefined
      ? instant(patch.startsAt, "The start time")
      : new Date(iso(current.starts_at)).getTime();
    const endsAt = patch.endsAt !== undefined
      ? instant(patch.endsAt, "The end time")
      : new Date(iso(current.ends_at)).getTime();
    assertWindow(startsAt, endsAt);

    const title = patch.title !== undefined ? patch.title.trim() : String(current.title);
    if (!title) throw outOfRange("A session needs a title");
    if (title.length > 300) throw outOfRange("The title must be 300 characters or fewer");

    const status = patch.status ?? (String(current.status) as SessionStatus);
    if (!SESSION_STATUSES.includes(status)) throw outOfRange(`Status must be one of: ${SESSION_STATUSES.join(", ")}`);
    if (status === "completed" && String(current.status) === "cancelled") {
      // A cancelled session did not happen. Completing it would mint an
      // attendance record for a class nobody held.
      throw conflict("A cancelled session cannot be completed. Reschedule it first.");
    }

    const capacity = patch.capacity !== undefined ? assertCapacity(patch.capacity) : numOrNull(current.capacity);
    if (patch.capacity !== undefined && capacity !== null) {
      const { rows: onRoster } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM osa.session_attendance WHERE session_id = $1::uuid",
        [id],
      );
      // Lowering capacity below the roster would leave the session permanently
      // over-subscribed with no way to say who should not be there.
      if (num(onRoster[0].count) > capacity) {
        throw conflict(`${onRoster[0].count} people are already registered. Remove people before lowering capacity to ${capacity}.`);
      }
    }

    let instructorUserId = current.instructor_user_id ? String(current.instructor_user_id) : null;
    if (patch.instructorUserId !== undefined) {
      instructorUserId = patch.instructorUserId ? storageId(patch.instructorUserId, "Instructor") : null;
      if (instructorUserId) await assertUsersWritable(client, principal, [instructorUserId], null);
    }

    const { rows } = await client.query(
      `UPDATE osa.live_sessions
          SET title = $2, description = $3, starts_at = $4::timestamptz, ends_at = $5::timestamptz,
              time_zone = $6, instructor_user_id = $7::uuid, capacity = $8::integer,
              join_url = $9, status = $10, updated_at = now()
        WHERE id = $1::uuid
        RETURNING *`,
      [
        id, title,
        patch.description !== undefined ? patch.description.trim().slice(0, 5000) : String(current.description ?? ""),
        new Date(startsAt).toISOString(), new Date(endsAt).toISOString(),
        patch.timeZone !== undefined ? assertTimeZone(patch.timeZone.trim() || "UTC") : String(current.time_zone),
        instructorUserId, capacity,
        patch.joinUrl !== undefined ? assertJoinUrl(patch.joinUrl) : String(current.join_url ?? ""),
        status,
      ],
    );
    const updated = rows[0];
    await appendAssessmentAudit(client, principal, requestId, "session.update", "live_session", id, {
      from: String(current.status), status, title,
      startsAt: iso(updated.starts_at), endsAt: iso(updated.ends_at),
      instructorUserId, capacity,
    });
    return readSummary(client, id);
  });
}

export type RegisterResult = { sessionId: string; registered: number; alreadyRegistered: number };

/**
 * Puts people on the roster at status 'registered'.
 *
 * ON CONFLICT DO NOTHING, so re-sending a list is harmless and — more to the
 * point — never overwrites an attendance observation with a fresh registration.
 * A retried request must not erase the fact that somebody was marked absent.
 */
export async function registerLearners(
  principal: Principal, sessionId: string, userIds: readonly string[], requestId: string,
): Promise<RegisterResult> {
  requireScheduler(principal);
  const id = storageId(sessionId, "Session");
  const ids = normalizeUserIds(userIds, "The registration list");

  return writeTx(principal, async (client) => {
    const session = await loadSessionForScheduler(client, principal, id);
    const status = String(session.status);
    if (status === "cancelled") throw conflict("This session is cancelled, so nobody can be registered for it");
    if (status === "completed") throw conflict("This session is completed. Record attendance instead of registering people.");

    await assertUsersWritable(client, principal, ids, null);

    const capacity = numOrNull(session.capacity);
    if (capacity !== null) {
      const { rows: counts } = await client.query<{ on_roster: number; already: number }>(
        `SELECT count(*)::int AS on_roster,
                count(*) FILTER (WHERE a.subject_user_id = ANY($2::uuid[]))::int AS already
           FROM osa.session_attendance a WHERE a.session_id = $1::uuid`,
        [id, ids],
      );
      const arriving = ids.length - num(counts[0].already);
      // The capacity column is otherwise a number nothing honours, which is the
      // same as not having one.
      if (num(counts[0].on_roster) + arriving > capacity) {
        throw conflict(`Capacity is ${capacity} and ${counts[0].on_roster} are registered. Registering ${arriving} more would exceed it.`);
      }
    }

    const { rows: inserted } = await client.query<{ subject_user_id: string }>(
      `INSERT INTO osa.session_attendance (tenant_id, session_id, subject_user_id, status)
       SELECT $1::uuid, $2::uuid, u, 'registered' FROM unnest($3::uuid[]) AS u
       ON CONFLICT (tenant_id, session_id, subject_user_id) DO NOTHING
       RETURNING subject_user_id`,
      [String(session.tenant_id), id, ids],
    );

    await appendAssessmentAudit(client, principal, requestId, "session.register", "live_session", id, {
      requested: ids.length, registered: inserted.length, alreadyRegistered: ids.length - inserted.length,
    });
    return { sessionId: id, registered: inserted.length, alreadyRegistered: ids.length - inserted.length };
  });
}

export type AttendanceResult = {
  sessionId: string;
  recorded: number;
  /** How many minute values were reduced to the session's scheduled length. */
  capped: number;
  cappedAtMinutes: number;
};

/**
 * Records what actually happened, per person.
 *
 * `recorded_by` and `recorded_at` are set from the validated session and the
 * authenticated principal, never from the request body. The schema CHECK
 * refuses any non-'registered' row without a recorder, and that signature is
 * the whole difference between an attendance record and a sign-up list.
 */
export async function recordAttendance(
  principal: Principal, sessionId: string, entries: readonly AttendanceEntry[], requestId: string,
): Promise<AttendanceResult> {
  const id = storageId(sessionId, "Session");
  if (!Array.isArray(entries) || entries.length === 0) throw outOfRange("Send at least one attendance entry");
  if (entries.length > 500) throw outOfRange("Attendance is limited to 500 entries per call");

  const subjectIds = normalizeUserIds(entries.map((entry) => entry?.subjectUserId), "The attendance list");
  if (subjectIds.length !== entries.length) {
    // A single INSERT ... ON CONFLICT DO UPDATE that touches the same key twice
    // raises 21000 "cannot affect row a second time", which would reach the
    // caller as an opaque 500 for what is really two conflicting entries.
    throw conflict("The same person appears more than once in this batch. Send one entry per person.");
  }

  return writeTx(principal, async (client) => {
    const session = await loadSessionForRecorder(client, principal, id, true);
    if (String(session.status) === "cancelled") {
      throw conflict("This session is cancelled, so there is no attendance to record");
    }
    await assertUsersWritable(client, principal, subjectIds, id);

    const cap = scheduledMinutesOf(session);
    let capped = 0;
    const statuses: string[] = [];
    const minutes: number[] = [];
    const notes: string[] = [];
    for (const entry of entries) {
      const status = String(entry.status ?? "") as AttendanceStatus;
      if (!ATTENDANCE_STATUSES.includes(status)) {
        throw outOfRange(`Attendance status must be one of: ${ATTENDANCE_STATUSES.join(", ")}`);
      }
      const requested = entry.minutesAttended ?? 0;
      if (!Number.isFinite(requested) || requested < 0) throw outOfRange("Minutes attended cannot be negative");
      // 600 minutes on a 60-minute session is a typo, not a fact, and it would
      // flow straight into any duration-based completion rule reading this.
      const value = Math.min(Math.round(requested), cap);
      if (value < Math.round(requested)) capped += 1;
      statuses.push(status);
      minutes.push(value);
      notes.push(String(entry.note ?? "").trim().slice(0, 2000));
    }

    await client.query(
      `INSERT INTO osa.session_attendance
         (tenant_id, session_id, subject_user_id, status, minutes_attended, note, recorded_by, recorded_at)
       SELECT $1::uuid, $2::uuid, e.subject, e.status, e.minutes, e.note, $6::uuid, now()
         FROM unnest($3::uuid[], $4::text[], $5::int[], $7::text[]) AS e(subject, status, minutes, note)
       ON CONFLICT (tenant_id, session_id, subject_user_id) DO UPDATE
         SET status = EXCLUDED.status,
             minutes_attended = EXCLUDED.minutes_attended,
             note = EXCLUDED.note,
             recorded_by = EXCLUDED.recorded_by,
             recorded_at = EXCLUDED.recorded_at`,
      [String(session.tenant_id), id, subjectIds, statuses, minutes, principalUserId(principal), notes],
    );

    await appendAssessmentAudit(client, principal, requestId, "session.attendance", "live_session", id, {
      entries: entries.length, capped, cappedAtMinutes: cap,
      attended: statuses.filter((status) => status === "attended").length,
      absent: statuses.filter((status) => status === "absent").length,
    });
    return { sessionId: id, recorded: entries.length, capped, cappedAtMinutes: cap };
  });
}
