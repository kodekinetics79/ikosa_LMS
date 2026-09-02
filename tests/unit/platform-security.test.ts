import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-security-"));
process.env.IK_DATA_DIR = isolatedDataDir;

const modules = Promise.all([
  import("../../src/lib/server/auth"),
  import("../../src/lib/server/store"),
  import("../../src/lib/server/audit"),
]);

async function authenticated(email: string) {
  const [auth] = await modules;
  const result = await auth.login(email, "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/auth/session", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  return { result, principal: await auth.principalFromRequest(request), request };
}

test("development database persists realistic seed data to disk", async () => {
  const [, store] = await modules;
  const database = await store.readDatabase();
  assert.equal(database.tenants.length, 2);
  assert.ok(database.gapCases.some((gap) => gap.priority === "critical"));
  const persisted = JSON.parse(await readFile(path.join(isolatedDataDir, "ik-osa-dev.json"), "utf8"));
  // Compare against the store's own constant, not a literal, so a schema bump
  // does not require editing an unrelated assertion.
  assert.equal(persisted.schemaVersion, store.SCHEMA_VERSION);
});

test("tenant context is derived from the signed-in session", async () => {
  const { principal } = await authenticated("analyst@northstar.example");
  assert.equal(principal.tenantId, "ten_northstar");
  assert.equal(principal.user.email, "analyst@northstar.example");
  assert.equal("passwordHash" in principal.user, false);
});

test("RBAC denies an analyst access to audit records", async () => {
  const [auth] = await modules;
  const { principal } = await authenticated("analyst@northstar.example");
  assert.throws(() => auth.authorize(principal, "audit:read", { tenantId: principal.tenantId }), /not permitted/);
});

test("ABAC denies records from another tenant and delegated org scope", async () => {
  const [auth, store] = await modules;
  const { principal } = await authenticated("manager@northstar.example");
  const database = await store.readDatabase();
  const gulfOrg = database.orgUnits.find((org) => org.id === "org_ge")!;
  const operationsOrg = database.orgUnits.find((org) => org.id === "org_ns_ops")!;
  assert.throws(() => auth.authorize(principal, "gap:read", { tenantId: "ten_gulf", orgUnit: gulfOrg }), /Tenant boundary/);
  assert.throws(() => auth.authorize(principal, "gap:read", { tenantId: principal.tenantId, orgUnit: operationsOrg }), /outside delegated/);
});

test("learner self-scope prevents reading another subject's record", async () => {
  const [auth, store] = await modules;
  const { principal } = await authenticated("technician@northstar.example");
  const database = await store.readDatabase();
  const org = database.orgUnits.find((item) => item.id === "org_ns_south")!;
  assert.doesNotThrow(() => auth.authorize(principal, "gap:read", { tenantId: principal.tenantId, orgUnit: org, subjectUserId: principal.user.id }));
  assert.throws(() => auth.authorize(principal, "gap:read", { tenantId: principal.tenantId, orgUnit: org, subjectUserId: "usr_manager" }), /own records/);
});

test("CSRF token is mandatory for state changes", async () => {
  const [auth] = await modules;
  const { result, principal } = await authenticated("manager@northstar.example");
  const valid = new Request("http://localhost/api/evidence", { method: "POST", headers: { "x-csrf-token": result.session.csrfToken } });
  assert.doesNotThrow(() => auth.assertCsrf(valid, principal));
  const invalid = new Request("http://localhost/api/evidence", { method: "POST" });
  assert.throws(() => auth.assertCsrf(invalid, principal), /Invalid CSRF/);
});

test("audit ledger detects no mutation in its SHA-256 hash chain", async () => {
  const [, , audit] = await modules;
  const result = await audit.verifyAuditChain();
  assert.equal(result.valid, true);
  assert.ok(result.checked >= 4);
});

test("row visibility hides unauthorized records but never hides broken ones", async () => {
  const [, store] = await modules;
  const domainService = await import("../../src/lib/server/domain-service");
  const { principal } = await authenticated("manager@northstar.example");
  const database = await store.readDatabase();

  // An out-of-scope row is an authorization decision: filtered, not thrown.
  const outOfScope = { ...database.evidence[0], id: "ev_out_of_scope", orgUnitId: "org_ns" };
  const visible = domainService.visibleRows(database, principal, "evidence:read", [outOfScope]);
  assert.equal(visible.length, 0);

  // A row pointing at a missing organizational unit is a data-integrity fault.
  // Silently dropping it would remove real gaps and inflate readiness, so it
  // must surface rather than disappear.
  const dangling = { ...database.evidence[0], id: "ev_dangling", orgUnitId: "org_does_not_exist" };
  assert.throws(
    () => domainService.visibleRows(database, principal, "evidence:read", [dangling]),
    /Organizational unit not found/,
  );
});

test("repeated failed sign-ins are throttled", async () => {
  const [auth] = await modules;
  const email = "throttle-probe@northstar.example";
  let throttled = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      await auth.login(email, "not-the-password", crypto.randomUUID(), "northstar");
    } catch (error) {
      if (error instanceof Error && /Too many sign-in attempts/.test(error.message)) { throttled = true; break; }
    }
  }
  assert.equal(throttled, true, "expected the login throttle to engage");
});
