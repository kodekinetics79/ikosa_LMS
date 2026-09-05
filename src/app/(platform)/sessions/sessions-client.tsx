"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { OrgUnit, PlatformRole } from "@/lib/server/domain";
import styles from "./sessions.module.css";

type ApiProblem = { error?: string; fields?: Record<string, string> };

type SessionStatus = "scheduled" | "live" | "completed" | "cancelled";
type AttendanceStatus = "registered" | "attended" | "partial" | "absent" | "excused";

/** One row of `GET /api/live-sessions`. */
type SessionSummary = {
  id: string;
  orgUnitId: string;
  courseId: string | null;
  moduleId: string | null;
  title: string;
  description: string;
  instructorUserId: string | null;
  instructorName: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  provider: string;
  joinUrl: string;
  capacity: number | null;
  status: SessionStatus;
  registeredCount: number;
  attendedCount: number;
};

/** One roster row of `GET /api/live-sessions?sessionId=`. */
type RosterRow = {
  subjectUserId: string;
  displayName: string;
  email: string;
  status: AttendanceStatus;
  minutesAttended: number;
  note: string;
  recordedAt: string | null;
};

type SessionDetail = { session: SessionSummary; roster: RosterRow[] };

/** The fields of `GET /api/admin/users` this screen uses. That route is tenant-admin only. */
type DirectoryUser = { id: string; displayName: string; email: string; active: boolean };

/** An in-progress edit of one roster row, held as strings because that is what the inputs produce. */
type AttendanceDraft = { status: AttendanceStatus; minutesAttended: string; note: string };

const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["registered", "attended", "partial", "absent", "excused"];
const DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

function errorMessage(payload: ApiProblem, fallback: string): string {
  if (payload.error) return payload.error;
  if (payload.fields) return Object.values(payload.fields)[0] ?? fallback;
  return fallback;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The zone this row can actually be rendered in.
 *
 * `time_zone` is a free-text column with no IANA validation behind it, and
 * `Intl.DateTimeFormat` throws a RangeError on a name it does not know. Left
 * unguarded, one malformed row takes the render down and the whole list goes
 * blank; falling back to UTC and saying so on the card keeps every other
 * session readable.
 */
function usableZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}

function formatIn(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(at);
}

/** "GMT+3", "BST" — the short name for the zone at that instant, so DST is reflected rather than assumed. */
function zoneAbbreviation(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

/** The reader's own zone, or "" where the runtime will not say. */
function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** How far `timeZone` is ahead of UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  // `hour12: false` still renders midnight as "24" on some engines, which would
  // push the reading a day forward; the modulo normalises it back to 0.
  const wallClock = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
  return wallClock - instant;
}

/**
 * Turn a `datetime-local` value into the instant it names *in the session's own
 * zone*.
 *
 * A `datetime-local` input yields a bare wall clock with no offset, and
 * `new Date(value)` resolves it in the *browser's* zone. A coordinator in London
 * scheduling 09:00 Asia/Riyadh would therefore store 09:00 London — the class is
 * filed six hours late and the cohort it was scheduled for misses it. Resolving
 * the offset at the candidate instant fixes that; doing it twice settles the
 * case where the first guess lands on the other side of a DST transition and so
 * reports the wrong offset for the real instant.
 *
 * Returns "" when the value is not a date the browser produced.
 */
function wallClockToIso(local: string, timeZone: string): string {
  if (!local) return "";
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  const asIfUtc = Date.parse(`${withSeconds}Z`);
  if (!Number.isFinite(asIfUtc)) return "";
  const firstGuess = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  const instant = asIfUtc - zoneOffsetMs(firstGuess, timeZone);
  return new Date(instant).toISOString();
}

function badgeClass(status: SessionStatus): string {
  if (status === "live") return `${styles.badge} ${styles.badgeLive}`;
  if (status === "completed") return `${styles.badge} ${styles.badgeDone}`;
  if (status === "cancelled") return `${styles.badge} ${styles.badgeCancelled}`;
  return styles.badge;
}

/**
 * When a session runs, in its own zone, with that zone named beside it.
 *
 * The zone is not decoration. A distributed cohort reading "14:00" with no
 * label has no way to tell whose 14:00 it is, and the reader's local rendering
 * is shown underneath — labelled as theirs — only when it actually differs, so
 * the two readings can never be confused for one another.
 */
function SessionWhen({ session, viewerZone }: { session: SessionSummary; viewerZone: string }) {
  const zone = usableZone(session.timeZone);
  const abbreviation = zoneAbbreviation(session.startsAt, zone);
  const showLocal = viewerZone !== "" && viewerZone !== zone;
  // A span, not a paragraph: this renders inside the card's <button>, whose
  // content model admits phrasing content only.
  return (
    <span className={styles.when}>
      <strong>{formatIn(session.startsAt, zone, DATE_FORMAT)}</strong>
      <span>{formatIn(session.startsAt, zone, TIME_FORMAT)} – {formatIn(session.endsAt, zone, TIME_FORMAT)}</span>
      <em className={styles.zone}>{abbreviation ? `${abbreviation} · ` : ""}{zone}</em>
      {zone !== session.timeZone ? (
        <em className={styles.zoneWarn}>Stored zone &ldquo;{session.timeZone}&rdquo; is not a zone this browser knows; shown in UTC.</em>
      ) : null}
      {showLocal ? (
        <em className={styles.localTime}>
          {formatIn(session.startsAt, viewerZone, DATE_FORMAT)}, {formatIn(session.startsAt, viewerZone, TIME_FORMAT)} in your time ({viewerZone})
        </em>
      ) : null}
    </span>
  );
}

export function SessionsClient({
  roles,
  organizations,
  csrfToken,
}: {
  roles: PlatformRole[];
  organizations: OrgUnit[];
  csrfToken: string;
}) {
  const canSchedule = roles.some((role) => role === "tenant_admin" || role === "tna_analyst");
  const isTenantAdmin = roles.includes("tenant_admin");
  const rootOrg = organizations[0];

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The server's clock from the list response. Splitting upcoming from past on
   *  the reader's clock would move the boundary for anyone with a wrong one. */
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  /** The session whose roster fetch failed, so a failure is told apart from a fetch still running. */
  const [failedDetailId, setFailedDetailId] = useState("");
  /** Bumped to re-run the roster fetch after a write, so the panel shows what the server stored. */
  const [rosterVersion, setRosterVersion] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, AttendanceDraft>>({});

  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [showScheduler, setShowScheduler] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [registerIds, setRegisterIds] = useState<string[]>([]);
  /* Resolved once at initialisation. Nothing derived from it is rendered before
     the client-side fetch returns, so the server's own zone never reaches the
     markup the browser then has to agree with. */
  const [viewerZone] = useState(readerZone);

  const [form, setForm] = useState(() => ({
    orgUnitId: rootOrg?.id ?? "",
    title: "",
    description: "",
    timeZone: readerZone() || "UTC",
    startsAt: "",
    endsAt: "",
    instructorUserId: "",
    capacity: "",
    joinUrl: "",
  }));

  const zoneOptions = useMemo(() => {
    // `Intl.supportedValuesOf` is absent on older runtimes; without it the picker
    // still offers UTC and the reader's own zone rather than nothing at all.
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    let zones: string[] = [];
    try {
      zones = typeof supported === "function" ? supported.call(Intl, "timeZone") : [];
    } catch {
      zones = [];
    }
    return [...new Set([viewerZone, "UTC", ...zones].filter(Boolean))];
  }, [viewerZone]);

  /** Reads the list. Deliberately free of state writes so the first load can be
   *  driven from an effect without a cascading render. */
  const fetchSessions = useCallback(async (): Promise<{ items: SessionSummary[]; asOf: string }> => {
    const response = await fetch("/api/live-sessions", { headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({})) as { items?: SessionSummary[]; asOf?: string } & ApiProblem;
    if (!response.ok) throw new Error(errorMessage(payload, "Unable to load sessions"));
    // The server's clock is what upcoming and past are split on. Falling back to
    // this browser's clock is only for a response that omits it entirely.
    return { items: payload.items ?? [], asOf: payload.asOf ?? new Date().toISOString() };
  }, []);

  /** Re-reads the list after a write, so what is on screen is what was stored. */
  const loadSessions = useCallback(async () => {
    const result = await fetchSessions();
    setSessions(result.items);
    setAsOf(result.asOf);
  }, [fetchSessions]);

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((result) => { if (!cancelled) { setSessions(result.items); setAsOf(result.asOf); } })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load sessions"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchSessions]);

  /* The people directory is tenant-admin only. Where it cannot be read, the two
     controls that depend on it — the instructor picker and registration — are
     not rendered at all, rather than rendered into a 403. */
  useEffect(() => {
    if (!isTenantAdmin) return;
    let cancelled = false;
    fetch("/api/admin/users", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({})) as { items?: DirectoryUser[] };
        if (!cancelled) setDirectory((payload.items ?? []).filter((user) => user.active));
      })
      .catch(() => { /* An absent directory hides those controls; it is not a page failure. */ });
    return () => { cancelled = true; };
  }, [isTenantAdmin]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/live-sessions?sessionId=${encodeURIComponent(selectedId)}`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as Partial<SessionDetail> & ApiProblem;
        if (!response.ok || !payload.session) throw new Error(errorMessage(payload, "Unable to load this roster"));
        if (cancelled) return;
        setDetail({ session: payload.session, roster: payload.roster ?? [] });
        setDrafts({});
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFailedDetailId(selectedId);
        setError(cause instanceof Error ? cause.message : "Unable to load this roster");
      });
    return () => { cancelled = true; };
  }, [selectedId, rosterVersion]);

  /**
   * The roster on screen, or null.
   *
   * Derived rather than cleared in the effect: a roster held from a previous
   * selection is simply not the current one, so it can never be rendered under
   * the newly selected session's heading while its own fetch is still in
   * flight. A reload of the same session keeps what is on screen rather than
   * flashing it empty.
   */
  const activeDetail = detail && detail.session.id === selectedId ? detail : null;
  const detailLoading = selectedId !== "" && activeDetail === null && failedDetailId !== selectedId;

  /**
   * Upcoming and past are split on the clock, not on status.
   *
   * A cancelled class that has not happened yet belongs with the sessions a
   * person is planning around — hiding it in "past" is how somebody travels to
   * a session that was called off. Its badge carries the cancellation.
   */
  const { upcoming, past } = useMemo(() => {
    // `asOf` arrives in the same response as the sessions, so it is always set
    // by the time there is anything to split. Reading the clock here instead
    // would move the boundary on every re-render.
    const now = Date.parse(asOf);
    const ahead: SessionSummary[] = [];
    const behind: SessionSummary[] = [];
    for (const session of sessions) {
      const ends = Date.parse(session.endsAt);
      if (Number.isFinite(now) && Number.isFinite(ends) && ends < now) behind.push(session); else ahead.push(session);
    }
    ahead.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
    behind.sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt));
    return { upcoming: ahead, past: behind };
  }, [sessions, asOf]);

  const draftFor = useCallback((row: RosterRow): AttendanceDraft => (
    drafts[row.subjectUserId] ?? { status: row.status, minutesAttended: String(row.minutesAttended), note: row.note }
  ), [drafts]);

  const changedRows = useMemo(() => {
    if (!activeDetail) return [] as RosterRow[];
    return activeDetail.roster.filter((row) => {
      const draft = drafts[row.subjectUserId];
      if (!draft) return false;
      return draft.status !== row.status
        || draft.note !== row.note
        || Number(draft.minutesAttended === "" ? "0" : draft.minutesAttended) !== row.minutesAttended;
    });
  }, [activeDetail, drafts]);

  function updateDraft(row: RosterRow, patch: Partial<AttendanceDraft>) {
    setDrafts((current) => ({
      ...current,
      [row.subjectUserId]: { ...(current[row.subjectUserId] ?? { status: row.status, minutesAttended: String(row.minutesAttended), note: row.note }), ...patch },
    }));
  }

  /**
   * Why this draft session cannot be sent yet, phrased for the person filling it
   * in. Each line mirrors a CHECK constraint in migration 009; without it the
   * only feedback is a constraint violation surfacing as an opaque failure.
   */
  const schedulerIssue = useMemo(() => {
    if (!form.orgUnitId) return "Choose the organization this session belongs to.";
    if (!form.title.trim()) return "Give the session a title.";
    if (!form.timeZone) return "Choose the time zone the session is held in.";
    const startsAt = wallClockToIso(form.startsAt, form.timeZone);
    const endsAt = wallClockToIso(form.endsAt, form.timeZone);
    if (!startsAt) return "Set when the session starts.";
    if (!endsAt) return "Set when the session ends.";
    // CHECK (ends_at > starts_at).
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return "The session must end after it starts.";
    if (form.capacity.trim()) {
      // CHECK (capacity IS NULL OR capacity > 0).
      const capacity = Number(form.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) return "Capacity must be a whole number of seats, or left blank.";
    }
    if (form.joinUrl.trim()) {
      // A join link is rendered as a plain external anchor. Anything that is not
      // an absolute http(s) URL produces a link that goes nowhere.
      try {
        const url = new URL(form.joinUrl.trim());
        if (url.protocol !== "https:" && url.protocol !== "http:") return "The joining link must be an http or https address.";
      } catch {
        return "The joining link must be a full address, starting with https://";
      }
    }
    return "";
  }, [form]);

  async function createSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Repeated even though the submit button is disabled, because a form can
    // still be submitted with the Enter key.
    if (schedulerIssue) { setError(schedulerIssue); return; }
    setBusy("create"); setError("");
    try {
      const response = await fetch("/api/live-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          orgUnitId: form.orgUnitId,
          title: form.title.trim(),
          description: form.description.trim(),
          startsAt: wallClockToIso(form.startsAt, form.timeZone),
          endsAt: wallClockToIso(form.endsAt, form.timeZone),
          timeZone: form.timeZone,
          instructorUserId: form.instructorUserId || undefined,
          capacity: form.capacity.trim() ? Number(form.capacity) : undefined,
          joinUrl: form.joinUrl.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { id?: string } & ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to schedule this session"));
      await loadSessions();
      if (typeof payload.id === "string" && payload.id) setSelectedId(payload.id);
      setForm((current) => ({ ...current, title: "", description: "", startsAt: "", endsAt: "", capacity: "", joinUrl: "", instructorUserId: "" }));
      setShowScheduler(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to schedule this session");
    } finally { setBusy(""); }
  }

  async function changeSession(action: "cancel" | "complete", session: SessionSummary) {
    if (action === "cancel" && !window.confirm(`Cancel ${session.title}? Everyone registered keeps their record, but the session is called off.`)) return;
    setBusy(action); setError("");
    try {
      const response = await fetch("/api/live-sessions", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action, sessionId: session.id }),
      });
      const payload = await response.json().catch(() => ({})) as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, `Unable to ${action} this session`));
      await loadSessions();
      setRosterVersion((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${action} this session`);
    } finally { setBusy(""); }
  }

  async function registerPeople() {
    if (!activeDetail || registerIds.length === 0) return;
    setBusy("register"); setError("");
    try {
      const response = await fetch("/api/session-attendance", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "register", sessionId: activeDetail.session.id, userIds: registerIds }),
      });
      const payload = await response.json().catch(() => ({})) as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to register those people"));
      setRegisterIds([]);
      setShowRegister(false);
      setRosterVersion((current) => current + 1);
      await loadSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to register those people");
    } finally { setBusy(""); }
  }

  /**
   * Every edited row goes in one "record" call.
   *
   * A per-row save would leave a half-recorded register behind whenever one row
   * failed, and there would be no way to tell from the screen which half.
   */
  async function saveAttendance() {
    if (!activeDetail) return;
    const entries: Array<{ subjectUserId: string; status: AttendanceStatus; minutesAttended: number; note: string }> = [];
    for (const row of changedRows) {
      const draft = draftFor(row);
      const minutes = Number(draft.minutesAttended.trim() === "" ? "0" : draft.minutesAttended);
      // minutes_attended is `integer NOT NULL CHECK (minutes_attended >= 0)`.
      if (!Number.isInteger(minutes) || minutes < 0) {
        setError(`Minutes for ${row.displayName} must be a whole number, zero or more.`);
        return;
      }
      entries.push({ subjectUserId: row.subjectUserId, status: draft.status, minutesAttended: minutes, note: draft.note });
    }
    if (entries.length === 0) return;
    setBusy("record"); setError("");
    try {
      const response = await fetch("/api/session-attendance", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "record", sessionId: activeDetail.session.id, entries }),
      });
      const payload = await response.json().catch(() => ({})) as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to save attendance"));
      // The roster is re-read rather than patched locally: what is on screen
      // afterwards is what the server stored, including who it recorded it as.
      setDrafts({});
      setRosterVersion((current) => current + 1);
      await loadSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save attendance");
    } finally { setBusy(""); }
  }

  const registerable = useMemo(() => {
    const already = new Set((activeDetail?.roster ?? []).map((row) => row.subjectUserId));
    return directory.filter((user) => !already.has(user.id));
  }, [directory, activeDetail]);

  const attendedTotal = sessions.reduce((total, session) => total + session.attendedCount, 0);
  const registeredTotal = sessions.reduce((total, session) => total + session.registeredCount, 0);

  function renderCard(session: SessionSummary) {
    const selected = session.id === selectedId;
    const isPast = past.some((item) => item.id === session.id);
    return (
      <article
        key={session.id}
        className={`${styles.sessionCard} ${selected ? styles.sessionCardActive : ""} ${isPast ? styles.sessionCardPast : ""}`}
      >
        <button
          type="button"
          className={styles.cardButton}
          aria-pressed={selected}
          onClick={() => setSelectedId(selected ? "" : session.id)}
        >
          <span className={styles.cardHead}>
            <span className={styles.cardTitle}>{session.title}</span>
            <span className={badgeClass(session.status)}>{titleCase(session.status)}</span>
          </span>
          <SessionWhen session={session} viewerZone={viewerZone} />
          {session.description ? <span className={styles.cardBlurb}>{session.description}</span> : null}
          <span className={styles.cardFoot}>
            <span><strong>{session.registeredCount}</strong> registered</span>
            <span><strong>{session.attendedCount}</strong> marked attended</span>
            {session.capacity !== null ? <span><strong>{session.capacity}</strong> seats</span> : null}
            {session.instructorName ? <span>Led by <strong>{session.instructorName}</strong></span> : <span>No instructor assigned</span>}
          </span>
        </button>
        {/* Sits beside the select button, never inside it: an anchor nested in a
            button is not a usable control. It is offered only when a link was
            actually stored, and it is a plain external link — the platform does
            not host the call, create the meeting or issue a token for it. */}
        {session.joinUrl && session.status !== "cancelled" ? (
          <p className={styles.joinRow}>
            <a className={styles.joinLink} href={session.joinUrl} target="_blank" rel="noreferrer noopener">
              Open the joining link ↗
            </a>
          </p>
        ) : null}
      </article>
    );
  }

  const selectedSession = activeDetail?.session ?? null;
  const selectedZone = selectedSession ? usableZone(selectedSession.timeZone) : "UTC";

  return <div className={styles.page}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}>Live sessions</span>
        <h1>Scheduled sessions and who was there.</h1>
        <p>Every session is shown in the time zone it is held in. Attendance is recorded by a person against the register — the platform does not run the call and cannot observe who joined it.</p>
      </div>
      {canSchedule ? <div className={styles.heroActions}>
        <button className={styles.primaryButton} type="button" onClick={() => setShowScheduler(true)}>Schedule a session</button>
      </div> : null}
    </section>

    {error ? <div className={styles.error} role="alert">{error}<button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button></div> : null}

    <p className={styles.honesty}>
      <strong>No video integration.</strong>
      A session records when it is held and, where one was supplied, the address people join at. Nothing here creates a meeting, issues a token or imports an attendance report from a provider — every attendance status on this screen was typed by a named person.
    </p>

    <section className={styles.metrics} aria-label="Session summary">
      <article><span>Upcoming</span><strong>{upcoming.length}</strong><small>not yet finished</small></article>
      <article><span>Held</span><strong>{past.length}</strong><small>already finished</small></article>
      <article><span>Registrations</span><strong>{registeredTotal}</strong><small>across visible sessions</small></article>
      <article><span>Marked attended</span><strong>{attendedTotal}</strong><small>recorded by a person</small></article>
    </section>

    <div className={styles.layout}>
      <section className={styles.column} aria-label="Sessions">
        <header className={styles.columnHead}>
          <h2>Sessions</h2>
          <small>{loading ? "Loading…" : `${sessions.length} in your scope`}</small>
        </header>

        {loading ? <p className={styles.loading}>Loading sessions…</p> : sessions.length === 0 ? (
          <div className={styles.empty}>
            <strong>No sessions have been scheduled.</strong>
            {canSchedule ? "Schedule the first briefing, workshop or class for your organization." : "When someone schedules a session for your organization, it will appear here."}
          </div>
        ) : <>
          <p className={styles.groupLabel}>Upcoming<i /></p>
          {upcoming.length === 0
            ? <div className={styles.empty}><strong>Nothing is scheduled ahead.</strong>Every session in your scope has already finished.</div>
            : <div className={styles.sessionList}>{upcoming.map(renderCard)}</div>}
          <p className={styles.groupLabel}>Already held<i /></p>
          {past.length === 0
            ? <div className={styles.empty}><strong>No session has finished yet.</strong>Attendance can be recorded once a session has been held.</div>
            : <div className={styles.sessionList}>{past.map(renderCard)}</div>}
        </>}
      </section>

      <section className={styles.column} aria-label="Attendance register">
        <header className={styles.columnHead}>
          <h2>{selectedSession ? selectedSession.title : "Attendance register"}</h2>
          {selectedSession ? <small>{activeDetail?.roster.length ?? 0} on the register</small> : <small>Nothing selected</small>}
        </header>

        {!selectedId ? (
          <div className={styles.empty}>
            <strong>Select a session.</strong>
            Its register, and who has been marked as attending, opens here.
          </div>
        ) : detailLoading ? <p className={styles.loading}>Loading the register…</p> : !activeDetail ? (
          <div className={styles.empty}><strong>That register could not be loaded.</strong>Select the session again, or choose another one.</div>
        ) : <>
          <div className={styles.panelMeta}>
            <div><span>When</span><strong>{formatIn(activeDetail.session.startsAt, selectedZone, DATE_FORMAT)}</strong><small>{formatIn(activeDetail.session.startsAt, selectedZone, TIME_FORMAT)} – {formatIn(activeDetail.session.endsAt, selectedZone, TIME_FORMAT)} {selectedZone}</small></div>
            <div><span>Status</span><strong>{titleCase(activeDetail.session.status)}</strong></div>
            <div><span>Instructor</span><strong>{activeDetail.session.instructorName ?? "Not assigned"}</strong></div>
          </div>

          {canSchedule ? <div className={styles.panelActions}>
            {/* Registration needs a list of people to choose from, and the only
                directory endpoint is tenant-admin only. Where it did not load,
                the control is not offered rather than offered into a refusal. */}
            {registerable.length > 0 ? <button className={styles.ghostButton} type="button" onClick={() => { setRegisterIds([]); setShowRegister(true); }}>Register people</button> : null}
            {activeDetail.session.status !== "completed" && activeDetail.session.status !== "cancelled"
              ? <button className={styles.ghostButton} type="button" disabled={busy === "complete"} onClick={() => changeSession("complete", activeDetail.session)}>{busy === "complete" ? "Saving…" : "Mark completed"}</button>
              : null}
            {activeDetail.session.status !== "cancelled"
              ? <button className={styles.ghostButton} type="button" disabled={busy === "cancel"} onClick={() => changeSession("cancel", activeDetail.session)}>{busy === "cancel" ? "Cancelling…" : "Cancel session"}</button>
              : null}
          </div> : null}

          {activeDetail.roster.length === 0 ? (
            <div className={styles.empty}>
              <strong>Nobody is on this register.</strong>
              {canSchedule && registerable.length > 0
                ? "Register the people expected to attend, then record what actually happened after the session."
                : "Attendance can only be recorded for people who have been registered for this session."}
            </div>
          ) : <>
            <div className={styles.roster}>
              {activeDetail.roster.map((row) => {
                const draft = draftFor(row);
                const changed = changedRows.some((candidate) => candidate.subjectUserId === row.subjectUserId);
                return <article className={`${styles.rosterRow} ${changed ? styles.rosterRowChanged : ""}`} key={row.subjectUserId}>
                  <div className={styles.person}>
                    <strong>{row.displayName}</strong>
                    <small>{row.email}</small>
                    <em>{row.recordedAt ? `Recorded ${formatIn(row.recordedAt, selectedZone, { ...DATE_FORMAT, ...TIME_FORMAT })}` : "Not yet recorded"}</em>
                  </div>
                  {canSchedule ? <>
                    <select
                      value={draft.status}
                      aria-label={`Attendance status for ${row.displayName}`}
                      onChange={(event) => updateDraft(row, { status: event.target.value as AttendanceStatus })}
                    >
                      {ATTENDANCE_STATUSES.map((status) => <option value={status} key={status}>{titleCase(status)}</option>)}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.minutesAttended}
                      aria-label={`Minutes attended by ${row.displayName}`}
                      onChange={(event) => updateDraft(row, { minutesAttended: event.target.value })}
                    />
                    <input
                      type="text"
                      value={draft.note}
                      placeholder="Note (optional)"
                      aria-label={`Note about ${row.displayName}`}
                      onChange={(event) => updateDraft(row, { note: event.target.value })}
                    />
                  </> : <>
                    <span className={styles.readOnlyCell}><b>{titleCase(row.status)}</b></span>
                    <span className={styles.readOnlyCell}>{row.minutesAttended} min</span>
                    <span className={styles.readOnlyCell}>{row.note || "—"}</span>
                  </>}
                </article>;
              })}
            </div>
            {canSchedule ? <div className={styles.saveBar}>
              <span>{changedRows.length === 0 ? "No changes to save." : `${changedRows.length} ${changedRows.length === 1 ? "person" : "people"} changed.`}</span>
              <button className={styles.primaryButton} type="button" disabled={changedRows.length === 0 || busy === "record"} onClick={saveAttendance}>
                {busy === "record" ? "Saving…" : "Save attendance"}
              </button>
            </div> : <p className={styles.honesty}><strong>Read only.</strong>Attendance for this session is recorded by whoever organises it.</p>}
          </>}
        </>}
      </section>
    </div>

    {showScheduler ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowScheduler(false); }}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="schedule-session-title">
        <header>
          <div>
            <h2 id="schedule-session-title">Schedule a session</h2>
            <p>The start and end times are read in the time zone you choose below, not in yours — so a session held in another region is stored at the instant it is actually held.</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => setShowScheduler(false)}>×</button>
        </header>
        <form onSubmit={createSession}>
          <div className={styles.formGrid}>
            <label>Organization
              <select value={form.orgUnitId} onChange={(event) => setForm((current) => ({ ...current, orgUnitId: event.target.value }))} required>
                <option value="">Select organization</option>
                {organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}
              </select>
            </label>
            <label>Time zone <span>where it is held</span>
              <select value={form.timeZone} onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))} required>
                {zoneOptions.map((zone) => <option value={zone} key={zone}>{zone}</option>)}
              </select>
            </label>
            <label className={styles.full}>Title
              <input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Confined space entry briefing" maxLength={200} required />
            </label>
            <label className={styles.full}>Description
              <textarea rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="What this session covers and who it is for." />
            </label>
            <label>Starts <span>{form.timeZone}</span>
              <input type="datetime-local" value={form.startsAt} onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))} required />
            </label>
            <label>Ends <span>{form.timeZone}</span>
              <input type="datetime-local" value={form.endsAt} onChange={(event) => setForm((current) => ({ ...current, endsAt: event.target.value }))} required />
            </label>
            {/* The instructor picker appears only where the people directory
                loaded. A free-text user id would be a control nobody can use. */}
            {directory.length > 0 ? <label>Instructor <span>optional</span>
              <select value={form.instructorUserId} onChange={(event) => setForm((current) => ({ ...current, instructorUserId: event.target.value }))}>
                <option value="">Not assigned yet</option>
                {directory.map((user) => <option value={user.id} key={user.id}>{user.displayName}</option>)}
              </select>
            </label> : null}
            <label>Capacity <span>optional</span>
              <input type="number" min="1" step="1" value={form.capacity} onChange={(event) => setForm((current) => ({ ...current, capacity: event.target.value }))} placeholder="Leave blank for no limit" />
            </label>
            <label className={styles.full}>Joining link <span>optional</span>
              <input type="url" value={form.joinUrl} onChange={(event) => setForm((current) => ({ ...current, joinUrl: event.target.value }))} placeholder="https://…" />
            </label>
            <p className={styles.fieldNote}>
              The joining link is stored and shown as a plain external link. This platform does not create the meeting, and it cannot tell who joined it — attendance is recorded on the register afterwards by a person.
            </p>
          </div>
          <footer>
            {schedulerIssue ? <p className={styles.formIssue} role="status">{schedulerIssue}</p> : null}
            <button className={styles.secondaryButton} type="button" onClick={() => setShowScheduler(false)}>Cancel</button>
            <button className={styles.primaryButton} type="submit" disabled={busy === "create" || schedulerIssue !== ""}>{busy === "create" ? "Scheduling…" : "Schedule session"}</button>
          </footer>
        </form>
      </section>
    </div> : null}

    {showRegister && activeDetail ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowRegister(false); }}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="register-people-title">
        <header>
          <div>
            <h2 id="register-people-title">Register people</h2>
            <p>Registering someone records that they are expected at {activeDetail.session.title}. It is not a record that they attended — that is recorded on the register afterwards.</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => setShowRegister(false)}>×</button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); void registerPeople(); }}>
          <div className={styles.peopleList}>
            {registerable.map((user) => {
              const checked = registerIds.includes(user.id);
              return <label className={`${styles.personCheck} ${checked ? styles.personCheckOn : ""}`} key={user.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setRegisterIds((current) => checked ? current.filter((id) => id !== user.id) : [...current, user.id])}
                />
                <span>{user.displayName}</span>
                <small>{user.email}</small>
              </label>;
            })}
          </div>
          <footer>
            <button className={styles.secondaryButton} type="button" onClick={() => setShowRegister(false)}>Cancel</button>
            <button className={styles.primaryButton} type="submit" disabled={registerIds.length === 0 || busy === "register"}>
              {busy === "register" ? "Registering…" : `Register ${registerIds.length || ""}`.trim()}
            </button>
          </footer>
        </form>
      </section>
    </div> : null}
  </div>;
}
