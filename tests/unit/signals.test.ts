import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-signals-"));
process.env.IK_DATA_DIR = isolatedDataDir;

const modules = Promise.all([
  import("../../src/lib/server/store"),
  import("../../src/app/api/signals/[id]/triage/route"),
  import("../../src/lib/server/auth"),
  import("../../src/lib/server/domain-service"),
]);

type Database = import("../../src/lib/server/domain").Database;
type Signal = import("../../src/lib/server/domain").Signal;

/** A throwaway copy of the seeded database, so no test observes another's writes. */
async function scenario(): Promise<Database> {
  const [store] = await modules;
  return structuredClone(await store.readDatabase());
}

async function sessionFor(email: string): Promise<{ cookie: string; csrfToken: string }> {
  const [, , auth] = await modules;
  const result = await auth.login(email, "Demo!2026", crypto.randomUUID());
  return { cookie: `${auth.SESSION_COOKIE}=${result.session.id}`, csrfToken: result.session.csrfToken };
}

async function principalFor(email: string) {
  const [, , auth] = await modules;
  const { cookie } = await sessionFor(email);
  return auth.principalFromRequest(new Request("http://localhost/api/signals", { headers: { cookie } }));
}

/**
 * Drives the route handler itself, so the body rules and CSRF check are covered
 * alongside the domain rules.
 *
 * Only refusals are exercised at this level: a refusal writes nothing, so these
 * cases cannot leak state into the seeded copy every other test clones.
 */
async function postTriage(signalId: string, body: unknown, session: { cookie: string; csrfToken: string }, withCsrf = true) {
  const [, triage] = await modules;
  const headers: Record<string, string> = { "content-type": "application/json", cookie: session.cookie };
  if (withCsrf) headers["x-csrf-token"] = session.csrfToken;
  const request = new Request(`http://localhost/api/signals/${signalId}/triage`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await triage.POST(request, { params: Promise.resolve({ id: signalId }) });
  return { status: response.status, body: (await response.json()) as { error?: string; fields?: Record<string, string> } };
}

function signalIn(state: Database, id: string): Signal {
  const signal = state.signals.find((candidate) => candidate.id === id);
  assert.ok(signal, `expected seeded signal ${id}`);
  return signal;
}

/** Captures the refusal rather than the value, so the rule itself can be asserted. */
function refusal(run: () => unknown): { message: string; fields: Record<string, string> } {
  try {
    run();
  } catch (error) {
    return { message: (error as Error).message, fields: (error as { fields?: Record<string, string> }).fields ?? {} };
  }
  assert.fail("expected the triage decision to be refused");
}

/** A signal is untouched when a decision is refused - no half-applied triage. */
function assertUntriaged(signal: Signal): void {
  assert.equal(signal.status, "new");
  assert.equal(signal.linkedStudyId, null);
  assert.equal(signal.dismissedReason, null);
  assert.equal(signal.triagedByUserId, null);
  assert.equal(signal.triagedAt, null);
}

test("linking a signal records the study, the decision-maker and the moment", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const principal = await principalFor("analyst@northstar.example");

  const signal = triage.applyTriage(state, principal, "sig_ess14", { outcome: "link", linkedStudyId: "tna_field_2026" }, "2026-09-01T10:00:00.000Z");

  assert.equal(signal.status, "linked");
  assert.equal(signal.linkedStudyId, "tna_field_2026");
  assert.equal(signal.triagedByUserId, principal.user.id);
  assert.equal(signal.triagedAt, "2026-09-01T10:00:00.000Z");
  // A linked signal carries no dismissal reason: the two outcomes are exclusive.
  assert.equal(signal.dismissedReason, null);
  assert.equal(signalIn(state, "sig_ess14").status, "linked");
});

test("a dismissal without a stated reason is refused and leaves the signal untouched", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const principal = await principalFor("analyst@northstar.example");

  // Empty, blank and whitespace-only are all "no reason". Accepting any of them
  // would let a change be dropped with nothing on the record explaining why -
  // indistinguishable from nobody having looked at it.
  for (const dismissedReason of ["", " ", "\n\t  "]) {
    const { fields } = refusal(() => triage.applyTriage(state, principal, "sig_ess14", { outcome: "dismiss", dismissedReason }));
    assert.match(fields.dismissedReason ?? "", /must state a reason/i);
  }

  assertUntriaged(signalIn(state, "sig_ess14"));
});

test("a dismissal with a reason keeps the reason, trimmed, against the signal", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const principal = await principalFor("analyst@northstar.example");

  const signal = triage.applyTriage(
    state,
    principal,
    "sig_ess14",
    { outcome: "dismiss", dismissedReason: "  Superseded by ESS-14 revision 3.2, already covered by the 2026 study.  " },
    "2026-09-01T11:00:00.000Z",
  );

  assert.equal(signal.status, "dismissed");
  assert.equal(signal.dismissedReason, "Superseded by ESS-14 revision 3.2, already covered by the 2026 study.");
  assert.equal(signal.linkedStudyId, null);
  assert.equal(signal.triagedByUserId, principal.user.id);
  assert.equal(signal.triagedAt, "2026-09-01T11:00:00.000Z");
});

test("a signal that has already been triaged cannot be triaged again", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const principal = await principalFor("analyst@northstar.example");

  // Seeded as already linked to the 2026 study.
  const alreadyLinked = signalIn(state, "sig_capa17");
  assert.equal(alreadyLinked.status, "linked");
  const first = refusal(() => triage.applyTriage(state, principal, "sig_capa17", { outcome: "dismiss", dismissedReason: "Changed my mind." }));
  assert.match(first.fields.id ?? "", /already triaged/i);
  // The original decision survives intact rather than being overwritten.
  assert.equal(alreadyLinked.status, "linked");
  assert.equal(alreadyLinked.linkedStudyId, "tna_field_2026");
  assert.equal(alreadyLinked.dismissedReason, null);

  // Seeded as already dismissed, with its reason on the record.
  const alreadyDismissed = signalIn(state, "sig_dismissed");
  const reasonBefore = alreadyDismissed.dismissedReason;
  const second = refusal(() => triage.applyTriage(state, principal, "sig_dismissed", { outcome: "link", linkedStudyId: "tna_field_2026" }));
  assert.match(second.fields.id ?? "", /already triaged/i);
  assert.equal(alreadyDismissed.status, "dismissed");
  assert.equal(alreadyDismissed.dismissedReason, reasonBefore);

  // And a signal triaged in this very session cannot be re-triaged either.
  triage.applyTriage(state, principal, "sig_ess14", { outcome: "link", linkedStudyId: "tna_field_2026" });
  const third = refusal(() => triage.applyTriage(state, principal, "sig_ess14", { outcome: "dismiss", dismissedReason: "Actually not relevant." }));
  assert.match(third.fields.id ?? "", /already triaged/i);
  assert.equal(signalIn(state, "sig_ess14").status, "linked");
});

test("a signal belonging to another tenant cannot be triaged", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const northstar = await principalFor("analyst@northstar.example");
  const gulf = await principalFor("admin@gulf.example");

  const gulfSignal = signalIn(state, "sig_gulf");
  assert.equal(gulfSignal.tenantId, "ten_gulf");

  const denied = refusal(() => triage.applyTriage(state, northstar, "sig_gulf", { outcome: "dismiss", dismissedReason: "Not our regulator." }));
  assert.match(denied.fields.id ?? "", /not found in tenant/i);
  assertUntriaged(gulfSignal);

  // And the boundary holds in the other direction.
  const reverse = refusal(() => triage.applyTriage(state, gulf, "sig_ess14", { outcome: "dismiss", dismissedReason: "Not our regulator." }));
  assert.match(reverse.fields.id ?? "", /not found in tenant/i);
  assertUntriaged(signalIn(state, "sig_ess14"));
});

test("a signal cannot be linked to a study from another tenant or to no study at all", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const principal = await principalFor("analyst@northstar.example");

  const foreignStudy = { ...state.tnaStudies[0], id: "tna_gulf_only", tenantId: "ten_gulf", orgUnitId: "org_ge" };
  state.tnaStudies.push(foreignStudy);

  const crossTenant = refusal(() => triage.applyTriage(state, principal, "sig_ess14", { outcome: "link", linkedStudyId: "tna_gulf_only" }));
  assert.match(crossTenant.fields.linkedStudyId ?? "", /not found in tenant/i);

  const missing = refusal(() => triage.applyTriage(state, principal, "sig_ess14", { outcome: "link", linkedStudyId: "tna_does_not_exist" }));
  assert.match(missing.fields.linkedStudyId ?? "", /not found in tenant/i);

  assertUntriaged(signalIn(state, "sig_ess14"));
});

test("a role without signal:triage may read the queue but not decide on it", async () => {
  const [, triage, , domainService] = await modules;
  const state = await scenario();
  const manager = await principalFor("manager@northstar.example");

  // sig_audit9 sits in the manager's own organizational unit, so the refusal is
  // the missing action rather than the delegated scope.
  const target = signalIn(state, "sig_audit9");
  assert.equal(target.orgUnitId, "org_ns_south");
  assert.ok(domainService.visibleRows(state, manager, "signal:read", state.signals).some((row) => row.id === "sig_audit9"));

  const denied = refusal(() => triage.applyTriage(state, manager, "sig_audit9", { outcome: "dismiss", dismissedReason: "Handled locally." }));
  assert.match(denied.message, /not permitted/i);
  assertUntriaged(target);
});

test("a signal outside the caller's delegated organizational scope cannot be triaged", async () => {
  const [, triage] = await modules;
  const state = await scenario();
  const analyst = await principalFor("analyst@northstar.example");

  // The analyst is delegated /org_ns/org_ns_ops, so a signal raised at the
  // tenant root is inside their tenant but above their scope.
  state.signals.push({ ...signalIn(state, "sig_ess14"), id: "sig_root", orgUnitId: "org_ns", status: "new" });

  const denied = refusal(() => triage.applyTriage(state, analyst, "sig_root", { outcome: "link", linkedStudyId: "tna_field_2026" }));
  assert.match(denied.message, /outside delegated/i);
  assert.equal(signalIn(state, "sig_root").status, "new");
});

test("the inbox is scoped to the caller's tenant and delegated organizational paths", async () => {
  const [, , , domainService] = await modules;
  const state = await scenario();
  const analyst = await principalFor("analyst@northstar.example");
  const manager = await principalFor("manager@northstar.example");
  const learner = await principalFor("technician@northstar.example");

  const forAnalyst = domainService.visibleRows(state, analyst, "signal:read", state.signals);
  assert.ok(forAnalyst.every((row) => row.tenantId === "ten_northstar"));
  assert.equal(forAnalyst.some((row) => row.id === "sig_gulf"), false);
  // Dismissed signals stay visible: an auditor has to see what was declined.
  assert.ok(forAnalyst.some((row) => row.id === "sig_dismissed" && row.status === "dismissed"));

  // The manager is delegated South Region only, so Field Operations signals are
  // absent rather than redacted.
  const forManager = domainService.visibleRows(state, manager, "signal:read", state.signals);
  assert.ok(forManager.some((row) => row.id === "sig_audit9"));
  assert.equal(forManager.some((row) => row.id === "sig_ess14"), false);

  // A learner holds no signal:read at all.
  assert.equal(domainService.visibleRows(state, learner, "signal:read", state.signals).length, 0);
});

test("the endpoint requires exactly one outcome, and a CSRF token to record it", async () => {
  const [store] = await modules;
  const session = await sessionFor("analyst@northstar.example");
  const before = structuredClone((await store.readDatabase()).signals.find((row) => row.id === "sig_ess14"));

  const missingOutcome = await postTriage("sig_ess14", { dismissedReason: "drop it" }, session);
  assert.equal(missingOutcome.status, 400);
  assert.match(missingOutcome.body.fields?.outcome ?? "", /link, dismiss/);

  // Neither outcome may carry the other's payload: "exactly one" is enforced,
  // not resolved by precedence, so an ambiguous request can never drop a signal.
  const bothPayloads = await postTriage("sig_ess14", { outcome: "dismiss", dismissedReason: "x", linkedStudyId: "tna_field_2026" }, session);
  assert.equal(bothPayloads.status, 400);
  assert.match(bothPayloads.body.fields?.linkedStudyId ?? "", /cannot also be linked/i);

  const strayReason = await postTriage("sig_ess14", { outcome: "link", linkedStudyId: "tna_field_2026", dismissedReason: "x" }, session);
  assert.equal(strayReason.status, 400);
  assert.match(strayReason.body.fields?.dismissedReason ?? "", /cannot also carry a dismissal reason/i);

  const noReason = await postTriage("sig_ess14", { outcome: "dismiss" }, session);
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.fields?.dismissedReason ?? "", /must state a reason/i);

  const noCsrf = await postTriage("sig_ess14", { outcome: "link", linkedStudyId: "tna_field_2026" }, session, false);
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.body.error ?? "", /CSRF/i);

  // Every one of those was refused, so the stored signal is byte-for-byte unchanged.
  assert.deepEqual((await store.readDatabase()).signals.find((row) => row.id === "sig_ess14"), before);
});
