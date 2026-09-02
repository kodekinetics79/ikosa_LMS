import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { Database, Evidence, Notification } from "../../src/lib/server/domain";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-notifications-"));
process.env.IK_DATA_DIR = isolatedDataDir;

const modules = Promise.all([
  import("../../src/lib/server/store"),
  import("../../src/lib/server/notifications"),
  import("../../src/lib/server/domain-service"),
  import("../../src/lib/server/auth"),
]);

type Notifications = typeof import("../../src/lib/server/notifications");

/** Fixed clock. Every assertion about urgency is relative to this instant, never to the wall clock. */
const NOW = new Date("2026-09-01T12:00:00.000Z");

/** Runs a scenario against a throwaway copy of the seeded database. */
async function scenario<T>(run: (state: Database, notifications: Notifications) => T): Promise<T> {
  const [store, notifications] = await modules;
  const state = structuredClone(await store.readDatabase());
  return run(state, notifications);
}

function evidenceRecord(overrides: Partial<Evidence> & Pick<Evidence, "id" | "expiresAt">): Evidence {
  return {
    tenantId: "ten_northstar",
    orgUnitId: "org_ns_south",
    subjectUserId: "usr_learner",
    skillId: "skill_loto",
    type: "assessment",
    proficiencyLevel: 4,
    strength: 0.9,
    observedAt: "2026-01-01T00:00:00.000Z",
    assessorUserId: "usr_manager",
    sourceReference: "TEST",
    status: "verified",
    ...overrides,
  };
}

function of(state: Database, kind: Notification["kind"]): Notification[] {
  return state.notifications.filter((row) => row.kind === kind);
}

function openRows(state: Database): Notification[] {
  return state.notifications.filter((row) => row.resolvedAt === null);
}

/* -------------------------------------------------------------------------
 * Idempotency. The single most important property of the engine.
 * ----------------------------------------------------------------------- */

test("running the sweep twice raises nothing the second time and duplicates no row", async () => {
  const { first, second, keys, ids } = await scenario((state, notifications) => {
    const first = notifications.sweepNotifications(state, NOW);
    const idsAfterFirst = state.notifications.map((row) => row.id).sort();
    const second = notifications.sweepNotifications(state, NOW);
    return {
      first,
      second,
      keys: state.notifications.map((row) => `${row.tenantId} ${row.dedupeKey}`),
      ids: { afterFirst: idsAfterFirst, afterSecond: state.notifications.map((row) => row.id).sort() },
    };
  });

  assert.ok(first.raised > 0, "the seeded database must contain conditions worth chasing");
  assert.equal(second.raised, 0, "a repeat sweep must raise nothing");
  assert.equal(second.resolved, 0, "a repeat sweep must resolve nothing");
  assert.equal(second.refreshed, first.raised, "every condition should be recognised as already open");
  assert.equal(new Set(keys).size, keys.length, "dedupeKey must be unique per tenant across all rows");
  // Same rows, same identities: the second run did not replace anything.
  assert.deepEqual(ids.afterSecond, ids.afterFirst);
});

test("sweeping repeatedly with a moving clock still yields one row per condition", async () => {
  const total = await scenario((state, notifications) => {
    for (let minute = 0; minute < 10; minute += 1) {
      notifications.sweepNotifications(state, new Date(NOW.getTime() + minute * 60_000));
    }
    return state.notifications.length;
  });

  const single = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    return state.notifications.length;
  });

  assert.equal(total, single, "sweeping ten times must produce exactly what sweeping once produces");
});

test("a sweep never un-reads a notification the recipient has already read", async () => {
  const { readAt, after } = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    const row = openRows(state)[0];
    notifications.setReadState(row, true, NOW);
    const readAt = row.readAt;
    notifications.sweepNotifications(state, new Date(NOW.getTime() + 60_000));
    return { readAt, after: state.notifications.find((candidate) => candidate.id === row.id)?.readAt };
  });

  assert.ok(readAt);
  assert.equal(after, readAt, "refreshing an open notification must preserve its read state");
});

/* -------------------------------------------------------------------------
 * Resolution: the condition goes away, the record does not.
 * ----------------------------------------------------------------------- */

test("a completed enrollment stops being chased and its notification is resolved rather than deleted", async () => {
  const { before, result, row, count } = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    const before = of(state, "enrollment_due").filter((item) => item.resourceId === "enr_sam_diag");
    assert.equal(before.length, 1, "the seeded enrollment due on 2026-09-20 should be chased");

    const enrollment = state.enrollments.find((candidate) => candidate.id === "enr_sam_diag");
    assert.ok(enrollment);
    enrollment.status = "completed";
    enrollment.completedAt = NOW.toISOString();

    const later = new Date(NOW.getTime() + 60_000);
    const result = notifications.sweepNotifications(state, later);
    return {
      before: before[0],
      result,
      row: state.notifications.find((candidate) => candidate.id === before[0].id),
      count: state.notifications.length,
    };
  });

  assert.equal(result.resolved, 1);
  assert.ok(row, "the notification must still exist - resolution is not deletion");
  assert.equal(row.id, before.id);
  assert.equal(row.resolvedAt, new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal(row.title, before.title, "the resolved row keeps what it originally said");
  assert.ok(count > 0);
});

test("a renewed expiry resolves the old reminder and raises a fresh one for the new date", async () => {
  const { resolvedKey, openKey, resolvedCount } = await scenario((state, notifications) => {
    const evidence = evidenceRecord({ id: "ev_renewable", expiresAt: "2026-10-01T00:00:00.000Z" });
    state.evidence.push(evidence);

    notifications.sweepNotifications(state, NOW);
    const original = of(state, "evidence_expiring").find((row) => row.resourceId === "ev_renewable");
    assert.ok(original, "evidence expiring within the horizon must be chased");

    evidence.expiresAt = "2028-10-01T00:00:00.000Z";
    notifications.sweepNotifications(state, new Date(NOW.getTime() + 60_000));

    const rows = state.notifications.filter((row) => row.resourceId === "ev_renewable");
    return {
      resolvedKey: rows.find((row) => row.resolvedAt !== null)?.dedupeKey,
      openKey: rows.find((row) => row.resolvedAt === null)?.dedupeKey,
      resolvedCount: rows.filter((row) => row.resolvedAt !== null).length,
    };
  });

  // The expiry instant is part of the identity, so moving it retires the old
  // chase instead of quietly re-pointing it at a different deadline.
  assert.equal(resolvedKey, "evidence_expiring:ev_renewable:2026-10-01T00:00:00.000Z");
  assert.equal(openKey, undefined, "the new expiry is beyond the horizon, so nothing is outstanding");
  assert.equal(resolvedCount, 1);
});

test("a condition that recurs raises a fresh unread row instead of reviving the resolved one", async () => {
  const { rows, sameKey } = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    const enrollment = state.enrollments.find((candidate) => candidate.id === "enr_sam_diag");
    assert.ok(enrollment);

    const first = of(state, "enrollment_due").find((row) => row.resourceId === "enr_sam_diag");
    assert.ok(first);
    notifications.setReadState(first, true, NOW);

    // Completed, chased no more...
    enrollment.status = "completed";
    notifications.sweepNotifications(state, new Date(NOW.getTime() + 60_000));

    // ...then reopened, exactly as a withdrawn-and-reinstated assignment would be.
    enrollment.status = "in_progress";
    notifications.sweepNotifications(state, new Date(NOW.getTime() + 120_000));

    const rows = state.notifications.filter((row) => row.resourceId === "enr_sam_diag" && row.kind === "enrollment_due");
    return { rows, sameKey: new Set(rows.map((row) => row.dedupeKey)).size };
  });

  assert.equal(rows.length, 2, "the recurrence is a second episode, not an edit of the first");
  assert.equal(sameKey, 1, "both episodes share the dedupeKey that names the condition");
  const [resolved, reopened] = [rows.find((row) => row.resolvedAt !== null), rows.find((row) => row.resolvedAt === null)];
  assert.ok(resolved, "the first episode stays on file, resolved");
  assert.ok(reopened, "the recurrence is outstanding again");
  assert.notEqual(reopened.id, resolved.id);
  assert.equal(reopened.readAt, null, "a recurrence must be unread - having read the last one proves nothing");
  assert.ok(resolved.readAt, "the resolved episode keeps the fact that it was read");
});

/* -------------------------------------------------------------------------
 * Classification boundaries.
 * ----------------------------------------------------------------------- */

test("evidence is expired at its expiry instant and expiring one millisecond earlier", async () => {
  const kinds = await scenario((state, notifications) => {
    state.evidence.push(
      evidenceRecord({ id: "ev_exactly_now", expiresAt: NOW.toISOString() }),
      evidenceRecord({ id: "ev_just_after", expiresAt: new Date(NOW.getTime() + 1).toISOString() }),
      evidenceRecord({ id: "ev_just_before", expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
    );
    notifications.sweepNotifications(state, NOW);
    return Object.fromEntries(
      state.notifications
        .filter((row) => row.resourceType === "evidence")
        .map((row) => [row.resourceId, row.kind]),
    );
  });

  // At the instant of expiry the claim has already lapsed. "Expires today" is
  // not a state anybody can act on, and treating it as still valid is how an
  // unqualified person stays on a safety-critical roster for a day.
  assert.equal(kinds.ev_exactly_now, "evidence_expired");
  assert.equal(kinds.ev_just_before, "evidence_expired");
  assert.equal(kinds.ev_just_after, "evidence_expiring");
});

test("the 90-day evidence horizon is inclusive at the boundary and silent beyond it", async () => {
  const { onHorizon, pastHorizon } = await scenario((state, notifications) => {
    const horizon = NOW.getTime() + 90 * 86_400_000;
    state.evidence.push(
      evidenceRecord({ id: "ev_on_horizon", expiresAt: new Date(horizon).toISOString() }),
      evidenceRecord({ id: "ev_past_horizon", expiresAt: new Date(horizon + 1).toISOString() }),
    );
    notifications.sweepNotifications(state, NOW);
    const ids = state.notifications.map((row) => row.resourceId);
    return { onHorizon: ids.includes("ev_on_horizon"), pastHorizon: ids.includes("ev_past_horizon") };
  });

  assert.equal(onHorizon, true);
  assert.equal(pastHorizon, false);
});

test("a course is not overdue on the day it is due, and is overdue the day after", async () => {
  const { onDueDate, dayAfter } = await scenario((state, notifications) => {
    const enrollment = state.enrollments.find((candidate) => candidate.id === "enr_sam_diag");
    assert.ok(enrollment);
    enrollment.dueDate = "2026-09-20";

    // Late on the due date itself: the day is not over, so the deadline is not breached.
    notifications.sweepNotifications(state, new Date("2026-09-20T23:00:00.000Z"));
    const onDueDate = state.notifications.find((row) => row.resourceId === "enr_sam_diag" && row.resolvedAt === null)?.kind;

    notifications.sweepNotifications(state, new Date("2026-09-21T00:30:00.000Z"));
    const dayAfter = state.notifications.find((row) => row.resourceId === "enr_sam_diag" && row.resolvedAt === null)?.kind;
    return { onDueDate, dayAfter };
  });

  assert.equal(onDueDate, "enrollment_due");
  assert.equal(dayAfter, "enrollment_overdue");
});

test("evidence that is not verified is never chased", async () => {
  const chased = await scenario((state, notifications) => {
    state.evidence.push(
      evidenceRecord({ id: "ev_pending", expiresAt: "2026-09-10T00:00:00.000Z", status: "pending" }),
      evidenceRecord({ id: "ev_revoked", expiresAt: "2026-08-10T00:00:00.000Z", status: "revoked" }),
    );
    notifications.sweepNotifications(state, NOW);
    return state.notifications.map((row) => row.resourceId);
  });

  // Pending evidence claims nothing yet; revoked evidence already claims
  // nothing. Neither has a competence claim left to lose.
  assert.equal(chased.includes("ev_pending"), false);
  assert.equal(chased.includes("ev_revoked"), false);
});

/* -------------------------------------------------------------------------
 * Routing: who gets told.
 * ----------------------------------------------------------------------- */

test("each kind is addressed to the person who can actually act on it", async () => {
  const rows = await scenario((state, notifications) => {
    state.evidence.push(evidenceRecord({ id: "ev_soon", expiresAt: "2026-09-20T00:00:00.000Z" }));
    notifications.sweepNotifications(state, NOW);
    return state.notifications.map((row) => ({ kind: row.kind, resourceId: row.resourceId, to: row.subjectUserId, org: row.orgUnitId }));
  });

  // Evidence and enrollments go to their subject.
  assert.equal(rows.find((row) => row.resourceId === "ev_soon")?.to, "usr_learner");
  assert.equal(rows.find((row) => row.resourceId === "enr_sam_diag")?.to, "usr_learner");
  // An overdue intervention goes to its OWNER, not to the person whose gap it
  // closes - the subject cannot do anything about somebody else's action.
  assert.equal(rows.find((row) => row.resourceId === "int_diag")?.to, "usr_analyst");
  // An untriaged signal goes to the analyst already accountable for that part
  // of the organization: the owner of the TNA study covering its unit.
  assert.equal(rows.find((row) => row.resourceId === "sig_ess14")?.to, "usr_analyst");
  // Filed at the recipient's own unit, not the source record's.
  assert.equal(rows.find((row) => row.resourceId === "int_diag")?.org, "org_ns_ops");
});

test("a recipient can always see their own notification through the ordinary scoping", async () => {
  const [store, notificationModule, domainService, auth] = await modules;
  const state = structuredClone(await store.readDatabase());
  notificationModule.sweepNotifications(state, NOW);

  const result = await auth.login("analyst@northstar.example", "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/notifications", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  const principal = await auth.principalFromRequest(request);

  const mine = domainService
    .visibleRows(state, principal, "notification:read", state.notifications)
    .filter((row) => row.subjectUserId === principal.user.id);

  // The overdue intervention at org_ns_south is owned by the analyst, whose own
  // unit is org_ns_ops. Filing it at the source record's unit would still be
  // visible here, but filing it at the recipient's unit is what guarantees it.
  assert.ok(mine.some((row) => row.resourceId === "int_diag"), "the owner must see the reminder addressed to them");
  assert.ok(mine.every((row) => row.subjectUserId === principal.user.id));
});

test("a condition with no resolvable recipient is counted, not silently dropped", async () => {
  const { result, raisedFor } = await scenario((state, notifications) => {
    const orphan = state.enrollments.find((candidate) => candidate.id === "enr_sam_diag");
    assert.ok(orphan);
    orphan.subjectUserId = "usr_deleted";
    const result = notifications.sweepNotifications(state, NOW);
    return { result, raisedFor: state.notifications.map((row) => row.resourceId) };
  });

  assert.equal(result.unroutable, 1);
  assert.equal(raisedFor.includes("enr_sam_diag"), false);
});

test("an inactive recipient makes the condition unroutable rather than notifying a disabled account", async () => {
  const result = await scenario((state, notifications) => {
    const learner = state.users.find((candidate) => candidate.id === "usr_learner");
    assert.ok(learner);
    learner.active = false;
    return notifications.sweepNotifications(state, NOW);
  });

  assert.ok(result.unroutable >= 2, "both seeded enrollments belong to the deactivated learner");
});

/* -------------------------------------------------------------------------
 * Tenant isolation.
 * ----------------------------------------------------------------------- */

test("notifications never cross tenants", async () => {
  const rows = await scenario((state, notifications) => {
    // Late enough that Gulf Energy's regulation signal is inside the horizon too.
    notifications.sweepNotifications(state, new Date("2026-10-15T12:00:00.000Z"));
    return state.notifications.map((row) => {
      const recipient = state.users.find((user) => user.id === row.subjectUserId);
      const org = state.orgUnits.find((unit) => unit.id === row.orgUnitId);
      return { tenantId: row.tenantId, recipientTenant: recipient?.tenantId, orgTenant: org?.tenantId, resourceId: row.resourceId };
    });
  });

  assert.ok(rows.some((row) => row.tenantId === "ten_gulf"), "the fixture must actually exercise a second tenant");
  assert.ok(rows.some((row) => row.tenantId === "ten_northstar"));
  for (const row of rows) {
    assert.equal(row.recipientTenant, row.tenantId, `${row.resourceId} was addressed outside its tenant`);
    assert.equal(row.orgTenant, row.tenantId, `${row.resourceId} was filed under another tenant's unit`);
  }
});

test("a tenant-scoped sweep neither raises nor resolves another tenant's rows", async () => {
  const { afterScoped, gulfRow } = await scenario((state, notifications) => {
    const scoped = notifications.sweepNotifications(state, NOW, { tenantId: "ten_northstar" });
    assert.ok(scoped.raised > 0);
    assert.equal(state.notifications.some((row) => row.tenantId === "ten_gulf"), false, "a Northstar sweep must not touch Gulf Energy");

    // Give Gulf a row of its own, then triage the signal behind it away and run
    // a Northstar-scoped sweep. Gulf's row must survive untouched.
    notifications.sweepNotifications(state, new Date("2026-10-15T12:00:00.000Z"));
    const gulfBefore = state.notifications.filter((row) => row.tenantId === "ten_gulf");
    assert.equal(gulfBefore.length, 1);

    const signal = state.signals.find((candidate) => candidate.id === "sig_gulf");
    assert.ok(signal);
    signal.status = "triaged";

    notifications.sweepNotifications(state, new Date("2026-10-15T13:00:00.000Z"), { tenantId: "ten_northstar" });
    return {
      afterScoped: state.notifications.filter((row) => row.tenantId === "ten_gulf").length,
      gulfRow: state.notifications.find((row) => row.tenantId === "ten_gulf"),
    };
  });

  assert.equal(afterScoped, 1);
  assert.equal(gulfRow?.resolvedAt, null, "one tenant's operator must not close another tenant's reminder");
});

test("a triaged signal stops being chased", async () => {
  const { before, after } = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    const before = of(state, "signal_untriaged").filter((row) => row.resolvedAt === null).length;

    for (const signal of state.signals) {
      if (signal.status === "new") signal.status = "triaged";
    }
    notifications.sweepNotifications(state, new Date(NOW.getTime() + 60_000));
    return { before, after: of(state, "signal_untriaged").filter((row) => row.resolvedAt === null).length };
  });

  assert.ok(before > 0);
  assert.equal(after, 0);
});

/* -------------------------------------------------------------------------
 * Read state is personal.
 * ----------------------------------------------------------------------- */

test("a learner cannot mark someone else's notification read", async () => {
  const [store, notificationModule, , auth] = await modules;
  const state = structuredClone(await store.readDatabase());
  notificationModule.sweepNotifications(state, NOW);

  const result = await auth.login("technician@northstar.example", "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/notifications", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  const learner = await auth.principalFromRequest(request);

  const own = state.notifications.find((row) => row.subjectUserId === learner.user.id);
  const foreign = state.notifications.find((row) => row.subjectUserId !== learner.user.id);
  assert.ok(own, "the learner should have reminders of their own");
  assert.ok(foreign, "another person's reminder is needed for this test to mean anything");

  assert.equal(notificationModule.canChangeReadState(own, learner.user.id), true);
  assert.equal(notificationModule.canChangeReadState(foreign, learner.user.id), false);
});

test("a manager who can see a reminder still cannot clear it for someone else", async () => {
  const [store, notificationModule, domainService, auth] = await modules;
  const state = structuredClone(await store.readDatabase());
  notificationModule.sweepNotifications(state, NOW);

  const result = await auth.login("manager@northstar.example", "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/notifications", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  const manager = await auth.principalFromRequest(request);

  const learnerRow = state.notifications.find((row) => row.subjectUserId === "usr_learner");
  assert.ok(learnerRow);

  // The manager legitimately SEES it - the learner is in their delegated scope.
  assert.equal(domainService.visibleRows(state, manager, "notification:read", [learnerRow]).length, 1);
  // Seeing it is not owning it. Clearing somebody else's chase list would hide
  // the reminder from the only person able to act on it.
  assert.equal(notificationModule.canChangeReadState(learnerRow, manager.user.id), false);
});

test("a learner never sees another person's notification at all", async () => {
  const [store, notificationModule, domainService, auth] = await modules;
  const state = structuredClone(await store.readDatabase());
  notificationModule.sweepNotifications(state, NOW);

  const result = await auth.login("technician@northstar.example", "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/notifications", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  const learner = await auth.principalFromRequest(request);

  const visible = domainService.visibleRows(state, learner, "notification:read", state.notifications);
  assert.ok(visible.length > 0);
  assert.ok(visible.every((row) => row.subjectUserId === learner.user.id));
  assert.equal(visible.some((row) => row.resourceId === "int_diag"), false, "the analyst's overdue intervention is not the learner's business");
});

test("marking read twice keeps the first read time, and unreading clears it", async () => {
  const { first, second, cleared } = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    const row = openRows(state)[0];
    notifications.setReadState(row, true, NOW);
    const first = row.readAt;
    notifications.setReadState(row, true, new Date(NOW.getTime() + 3_600_000));
    const second = row.readAt;
    notifications.setReadState(row, false, NOW);
    return { first, second, cleared: row.readAt };
  });

  assert.equal(second, first, "replaying the request must not rewrite when it was read");
  assert.equal(cleared, null);
});

/* -------------------------------------------------------------------------
 * Ordering and shape.
 * ----------------------------------------------------------------------- */

test("the list orders by urgency, then by the soonest deadline", async () => {
  const order = await scenario((state, notifications) => {
    state.evidence.push(evidenceRecord({ id: "ev_lapsed", expiresAt: "2026-08-01T00:00:00.000Z" }));
    notifications.sweepNotifications(state, NOW);
    return openRows(state).sort(notifications.compareNotifications).map((row) => `${row.severity}:${row.dueAt ?? ""}`);
  });

  const rank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  for (let index = 1; index < order.length; index += 1) {
    const [previous] = order[index - 1].split(":") as [keyof typeof rank];
    const [current] = order[index].split(":") as [keyof typeof rank];
    assert.ok(rank[previous] >= rank[current], `severity ordering broke at index ${index}: ${order.join(" | ")}`);
  }
  assert.equal(order[0].startsWith("critical"), true, "lapsed evidence is the most urgent thing on the list");
});

test("every raised notification carries the fields the interface and the audit trail need", async () => {
  const rows = await scenario((state, notifications) => {
    notifications.sweepNotifications(state, NOW);
    return state.notifications;
  });

  for (const row of rows) {
    assert.ok(row.id.startsWith("ntf_"), "identifiers follow the datastore's prefix convention");
    assert.ok(row.title.length > 0 && row.body.length > 0);
    assert.ok(row.dedupeKey.startsWith(`${row.kind}:`), "the key must name the condition it identifies");
    assert.ok(row.dedupeKey.includes(row.resourceId), "the key must name the record the condition came from");
    assert.equal(row.createdAt, NOW.toISOString());
    assert.equal(row.readAt, null);
    assert.equal(row.resolvedAt, null);
    assert.ok(["critical", "high", "medium", "low"].includes(row.severity));
  }
});

test("the sweep tolerates a datastore written before notifications existed", async () => {
  const { raised, rows } = await scenario((state, notifications) => {
    // Exactly the shape of the shared development file: the key is absent
    // entirely, not merely empty.
    delete (state as Partial<Database>).notifications;
    delete (state as Partial<Database>).signals;
    const result = notifications.sweepNotifications(state, NOW);
    return { raised: result.raised, rows: notifications.notificationsOf(state).length };
  });

  assert.ok(raised > 0, "a legacy file must still be swept, not crashed on");
  assert.equal(rows, raised);
});
