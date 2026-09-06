/**
 * Authentication against the live PostgreSQL schema.
 *
 * `src/lib/server/auth.ts` now serves two datastores behind one unchanged
 * public API. `tests/unit/platform-security.test.ts` and the other 55 unit
 * tests cover the JSON path; this file covers the PostgreSQL one, and the two
 * are mutually exclusive by construction — `DATABASE_URL` decides which
 * datastore is authoritative, and both are never consulted for one request.
 *
 * RUNNING IT
 *
 *   DATABASE_URL=postgresql://…  node --import tsx --test tests/unit/auth-postgres.test.ts
 *
 * SKIPPING
 *
 * Every test skips — never fails — when `DATABASE_URL` is unset, when the `pg`
 * driver is absent, or when the migrations have not been applied. It is part of
 * the `npm test` glob, so it must stay silent for every engineer who has no
 * database in front of them. Same contract as
 * `tests/integration/postgres-repository.test.mjs`.
 *
 * WHY IT DOES NOT CONNECT AS THE ROLE IN `DATABASE_URL`
 *
 * `createPostgresPersistence` refuses, fatally, to run as a role with BYPASSRLS
 * or table ownership (ADR-001), and the provisioned Neon connection string is
 * the database owner. So `DATABASE_URL` is the ADMIN connection, used only to
 * manage fixtures, and the application under test is pointed at the runtime
 * role — resolved the way `scripts/provision-postgres.mjs` resolves it:
 *
 *   1. `IK_RUNTIME_DATABASE_URL`
 *   2. the file named by `IK_RUNTIME_URL_FILE` (default `/tmp/ik-runtime-url`)
 *   3. failing both, a throwaway role provisioned here with migration 002 §7's
 *      grant matrix, the same device `postgres-repository.test.mjs` uses.
 *
 * Either way the application runs RLS-constrained, as a deployment does, rather
 * than through a privileged shortcut.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * `src/lib/server/persistence.ts` opens with `import "server-only"`, whose main
 * entry throws on purpose outside a React Server Component graph. Next.js maps
 * it to the package's own empty module through the `react-server` export
 * condition; a bare `node --test` has no such condition, so the same mapping is
 * installed here. Nothing else is intercepted.
 */
const localRequire = createRequire(path.join(process.cwd(), "package.json"));
const serverOnlyEmpty = pathToFileURL(path.join(path.dirname(localRequire.resolve("server-only")), "empty.js")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: serverOnlyEmpty, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/** No test writes to the developer's real `.data/ik-osa-dev.json`. */
process.env.IK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ik-osa-auth-pg-"));
/** Fixed, so the derived CSRF token is stable across the calls in one test run. */
process.env.AUTH_SECRET = "auth-postgres-test-secret-not-the-published-default";

const ADMIN_URL = process.env.DATABASE_URL ?? "";
const RUNTIME_URL_FILE = process.env.IK_RUNTIME_URL_FILE ?? "/tmp/ik-runtime-url";
const PROBE_ROLE = "ik_osa_auth_probe";
const PROBE_PASSWORD = `probe_${randomUUID().replace(/-/g, "")}`;
const PASSWORD = "Probe!2026-correct-horse";

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const redact = (url: string): string => url.replace(/\/\/[^@]*@/, "//***@");

type Pool = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
};

type Fixture = {
  tenant: string;
  slug: string;
  orgUnit: string;
  user: string;
  email: string;
};

type Auth = typeof import("../../src/lib/server/auth");

let skipReason = "";
let admin: Pool | undefined;
let fixture: Fixture | undefined;
let auth: Auth | undefined;
/** The session minted by the first test and reused by the ones that follow it. */
let issued: { token: string; csrfToken: string } | undefined;
/** The ledger is append-only and the fixture is reused, so every audit assertion is relative to this. */
let baselineSequence = "0";
let runtimeRole = "";

function cookieRequest(token: string, url = "http://localhost/api/auth/session"): Request {
  return new Request(url, { headers: { cookie: `${auth!.SESSION_COOKIE}=${encodeURIComponent(token)}` } });
}

/** Mirrors migration 002 §7, so the role under test holds the documented grants and no more. */
async function provisionProbeRole(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
          EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', '${PROBE_ROLE}', '${PROBE_PASSWORD}');
        ELSE
          EXECUTE format('ALTER ROLE %I LOGIN NOBYPASSRLS PASSWORD %L', '${PROBE_ROLE}', '${PROBE_PASSWORD}');
        END IF;
      ELSE
        IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', '${PROBE_ROLE}', '${PROBE_PASSWORD}');
        ELSE
          EXECUTE format('CREATE ROLE %I LOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', '${PROBE_ROLE}', '${PROBE_PASSWORD}');
        END IF;
      END IF;
    END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA osa TO ${PROBE_ROLE}`);
  await pool.query(`GRANT SELECT ON osa.tenants TO ${PROBE_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT ON osa.audit_events TO ${PROBE_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, DELETE ON osa.sessions TO ${PROBE_ROLE}`);
  await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO ${PROBE_ROLE}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION osa.resolve_session(bytea) TO ${PROBE_ROLE}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION osa.current_tenant_id() TO ${PROBE_ROLE}`);
  for (const table of ["org_units", "users", "user_roles", "job_roles", "skills", "requirements",
    "tna_studies", "tna_target_roles", "evidence", "gap_cases", "interventions", "courses",
    "course_modules", "enrollments", "module_completions", "signals", "signal_job_roles",
    "signal_skills", "notifications"]) {
    await pool.query(`GRANT SELECT, INSERT, UPDATE ON osa.${table} TO ${PROBE_ROLE}`);
  }
}

function probeConnectionString(): string {
  const url = new URL(ADMIN_URL);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

/**
 * The runtime role the application will actually connect as. Prefers the one the
 * operator provisioned — testing the real role beats testing a lookalike — and
 * falls back to minting a throwaway so a developer with only an admin URL can
 * still run this file.
 */
async function runtimeConnectionString(pool: Pool): Promise<{ url: string; role: string }> {
  const configured = process.env.IK_RUNTIME_DATABASE_URL?.trim() || readRuntimeUrlFile();
  if (configured) return { url: configured, role: new URL(configured).username };
  await provisionProbeRole(pool);
  return { url: probeConnectionString(), role: PROBE_ROLE };
}

function readRuntimeUrlFile(): string {
  try {
    return readFileSync(RUNTIME_URL_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * One tenant, one org unit, one user with a real scrypt credential — the SAME
 * one on every run.
 *
 * The identifiers are derived with the repository's own `uuidV5`, so the fixture
 * is created once and adopted thereafter. That matters: `osa.audit_events` is
 * append-only and `osa.tenants` is referenced by it, so a tenant this file
 * created can never be deleted again. A per-run fixture would therefore leave a
 * permanent tenant behind on every single run of the suite; this leaves exactly
 * one, ever. It is a test fixture, not seed data, and it is deliberately not the
 * provisioning script's job being done here.
 */
const FIXTURE_SLUG = "auth-probe-fixture";

async function seedFixture(pool: Pool): Promise<Fixture> {
  const { hashPassword } = await import("../../src/lib/server/security");
  const { uuidV5 } = await import("../../src/lib/server/db/ids");
  const created: Fixture = {
    tenant: uuidV5("auth-postgres-test:tenant"),
    slug: FIXTURE_SLUG,
    orgUnit: uuidV5("auth-postgres-test:org-unit"),
    user: uuidV5("auth-postgres-test:user"),
    email: `analyst@${FIXTURE_SLUG}.example`,
  };

  await pool.query(
    `INSERT INTO osa.tenants (id, slug, name, home_region, locale) VALUES ($1,$2,$3,'us-east','en-US')
     ON CONFLICT (id) DO NOTHING`,
    [created.tenant, created.slug, "Auth probe workspace"]);
  // Forced RLS applies to any non-superuser, so the seeding connection needs a
  // tenant context of its own for the WITH CHECK clauses to pass.
  await pool.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)",
    [created.tenant, created.user]);
  await pool.query(
    `INSERT INTO osa.org_units (id, tenant_id, parent_id, code, name, path) VALUES ($1,$2,NULL,'ROOT','Probe root',$3::ltree)
     ON CONFLICT (id) DO NOTHING`,
    [created.orgUnit, created.tenant, created.orgUnit]);
  await pool.query(
    `INSERT INTO osa.users (id, tenant_id, org_unit_id, email, display_name, password_hash, delegated_org_paths)
     VALUES ($1,$2,$3,$4,'Probe Analyst',$5,ARRAY[$6::ltree])
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
    [created.user, created.tenant, created.orgUnit, created.email, hashPassword(PASSWORD), created.orgUnit]);
  await pool.query(
    `INSERT INTO osa.user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'tna_analyst')
     ON CONFLICT DO NOTHING`,
    [created.tenant, created.user]);
  // Any session left by an interrupted earlier run.
  await pool.query("DELETE FROM osa.sessions WHERE tenant_id = $1", [created.tenant]);
  await pool.query("SELECT set_config('app.tenant_id', '', false), set_config('app.user_id', '', false)");
  return created;
}

before(async () => {
  if (!ADMIN_URL) {
    skipReason = "DATABASE_URL is not set; PostgreSQL is not the system of record for this run";
    return;
  }
  try {
    const pg = await import("pg");
    const module_ = (typeof (pg as { Pool?: unknown }).Pool === "function" ? pg : (pg as { default: unknown }).default) as { Pool: new (c: Record<string, unknown>) => Pool };
    admin = new module_.Pool({ connectionString: ADMIN_URL, max: 2, connectionTimeoutMillis: 15000 });
    const { rows } = await admin.query(`
      SELECT to_regclass('osa.sessions')  IS NOT NULL AS has_001,
             to_regclass('osa.courses')   IS NOT NULL AS has_002,
             to_regproc('osa.resolve_session') IS NOT NULL AS has_resolver`);
    if (!rows[0].has_001 || !rows[0].has_002 || !rows[0].has_resolver) {
      skipReason = `the osa schema is incomplete at ${redact(ADMIN_URL)}; apply database/postgres/001 and 002`;
      return;
    }
    const runtime = await runtimeConnectionString(admin);
    runtimeRole = runtime.role;
    fixture = await seedFixture(admin);
    const head = await admin.query("SELECT coalesce(max(sequence), 0)::text AS head FROM osa.audit_events WHERE tenant_id = $1", [fixture.tenant]);
    baselineSequence = String(head.rows[0].head);
    // From here the application under test talks to the database as the
    // non-owning runtime role, exactly as a deployment would.
    process.env.DATABASE_URL = runtime.url;
    auth = await import("../../src/lib/server/auth");
  } catch (error) {
    skipReason = `no usable PostgreSQL at ${redact(ADMIN_URL)} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
});

after(async () => {
  // The pool inside persistence.ts is process-wide and cached; without closing
  // it the test process would not exit.
  const seam = await import("../../src/lib/server/persistence").catch(() => null);
  await (await seam?.persistence().catch(() => null))?.close().catch(() => {});

  if (admin && fixture) {
    // Sessions are the only rows this file is entitled to remove, and the only
    // ones it needs to: the tenant, org unit and user are the reusable fixture,
    // and `osa.audit_events` is append-only by design, which is exactly why the
    // fixture is stable rather than minted per run.
    await admin.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)",
      [fixture.tenant, fixture.user]).catch(() => {});
    await admin.query("DELETE FROM osa.sessions WHERE tenant_id = $1", [fixture.tenant]).catch(() => {});
    await admin.query("SELECT set_config('app.tenant_id', '', false), set_config('app.user_id', '', false)").catch(() => {});
  }
  await admin?.end().catch(() => {});
});

/* ---------------------------------------------------------------------------
 * The tests
 * ------------------------------------------------------------------------- */

test("login succeeds against PostgreSQL and writes one hashed session row", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const result = await auth!.login(fixture!.email, PASSWORD, randomUUID(), fixture!.slug);

  assert.equal(result.user.email, fixture!.email);
  assert.equal(result.user.id, fixture!.user);
  assert.equal(result.session.tenantId, fixture!.tenant);
  assert.equal("passwordHash" in result.user, false);
  assert.ok(result.session.csrfToken.length > 20);

  const { rows } = await admin!.query(
    "SELECT tenant_id, user_id, csrf_hash, expires_at FROM osa.sessions WHERE id_hash = $1",
    [sha256(result.session.id)]);
  assert.equal(rows.length, 1, "the raw cookie value is not stored; its SHA-256 is the primary key");
  assert.equal(String(rows[0].tenant_id), fixture!.tenant);
  assert.equal(String(rows[0].user_id), fixture!.user);
  // The scheme in one assertion: what the browser is given hashes to what the
  // row holds, and the row holds nothing else.
  assert.deepEqual(Buffer.from(rows[0].csrf_hash as Uint8Array), sha256(result.session.csrfToken));

  const audit = await admin!.query(
    `SELECT actor_user_id FROM osa.audit_events
      WHERE tenant_id = $1 AND sequence > $2::bigint AND action = 'auth.login' AND outcome = 'success'`,
    [fixture!.tenant, baselineSequence]);
  assert.equal(audit.rows.length, 1, "one successful sign-in, one ledger entry");
  assert.equal(String(audit.rows[0].actor_user_id), fixture!.user);

  issued = { token: result.session.id, csrfToken: result.session.csrfToken };
});

test("a wrong password is refused, mints no session, and is audited", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const before_ = await admin!.query("SELECT count(*)::int AS n FROM osa.sessions WHERE tenant_id = $1", [fixture!.tenant]);

  await assert.rejects(
    auth!.login(fixture!.email, "not-the-password", randomUUID(), fixture!.slug),
    (error: unknown) => error instanceof auth!.AuthError && error.status === 401 && error.message === "Invalid credentials");

  const after_ = await admin!.query("SELECT count(*)::int AS n FROM osa.sessions WHERE tenant_id = $1", [fixture!.tenant]);
  assert.equal(after_.rows[0].n, before_.rows[0].n, "a failed sign-in must not create a session");

  const audit = await admin!.query(
    `SELECT metadata, actor_user_id FROM osa.audit_events
      WHERE tenant_id = $1 AND action = 'auth.login' AND outcome = 'failure'
      ORDER BY sequence DESC LIMIT 1`, [fixture!.tenant]);
  assert.equal((audit.rows[0].metadata as { reason: string }).reason, "invalid_credentials");
  assert.equal(String(audit.rows[0].actor_user_id), fixture!.user);
});

test("an unknown account fails in the identical shape and is still audited", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const unknown = `nobody-${randomUUID().slice(0, 8)}@auth-probe.example`;

  const failure = await auth!.login(unknown, PASSWORD, randomUUID(), fixture!.slug).then(() => null, (error: unknown) => error);
  assert.ok(failure instanceof auth!.AuthError);
  // Identical status and message to the wrong-password case: the endpoint is
  // not an account-existence oracle.
  assert.equal((failure as InstanceType<Auth["AuthError"]>).status, 401);
  assert.equal((failure as Error).message, "Invalid credentials");

  const audit = await admin!.query(
    `SELECT metadata, actor_user_id FROM osa.audit_events
      WHERE tenant_id = $1 AND action = 'auth.login' AND outcome = 'failure'
      ORDER BY sequence DESC LIMIT 1`, [fixture!.tenant]);
  assert.equal((audit.rows[0].metadata as { reason: string }).reason, "unknown_account");
  assert.equal(audit.rows[0].actor_user_id, null, "there is no actor to attribute an unknown account to");
});

test("the session cookie resolves to the right principal, CSRF token included", async (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.ok(issued, "depends on the login test above");
  const principal = await auth!.principalFromRequest(cookieRequest(issued!.token));

  assert.equal(principal.tenantId, fixture!.tenant);
  assert.equal(principal.user.id, fixture!.user);
  assert.equal(principal.user.email, fixture!.email);
  assert.deepEqual(principal.roles, ["tna_analyst"]);
  assert.deepEqual(principal.delegatedOrgPaths, [`/${fixture!.orgUnit}`]);
  assert.equal("passwordHash" in principal.user, false);
  assert.equal(principal.session.id, issued!.token);
  // The property the pages depend on: the raw CSRF token is unrecoverable from
  // `csrf_hash`, yet it is still on the Principal on a later request.
  assert.equal(principal.session.csrfToken, issued!.csrfToken);
  assert.ok(Date.parse(principal.session.expiresAt) > Date.now());
});

test("CSRF verification accepts the issued token and rejects any other", async (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.ok(issued, "depends on the login test above");
  const principal = await auth!.principalFromRequest(cookieRequest(issued!.token));

  const valid = new Request("http://localhost/api/evidence", { method: "POST", headers: { "x-csrf-token": issued!.csrfToken } });
  assert.doesNotThrow(() => auth!.assertCsrf(valid, principal));

  for (const wrong of ["", "not-the-token", auth!.serializeSessionCookie(principal.session, valid)]) {
    const invalid = new Request("http://localhost/api/evidence", { method: "POST", headers: { "x-csrf-token": wrong } });
    assert.throws(() => auth!.assertCsrf(invalid, principal), /Invalid CSRF token/);
  }
  const missing = new Request("http://localhost/api/evidence", { method: "POST" });
  assert.throws(() => auth!.assertCsrf(missing, principal), /Invalid CSRF token/);

  // A token derived from a DIFFERENT session must not verify against this one:
  // the derivation is per-session, not a single application-wide secret.
  const other = await auth!.login(fixture!.email, PASSWORD, randomUUID(), fixture!.slug);
  assert.notEqual(other.session.csrfToken, issued!.csrfToken);
  const crossed = new Request("http://localhost/api/evidence", { method: "POST", headers: { "x-csrf-token": other.session.csrfToken } });
  assert.throws(() => auth!.assertCsrf(crossed, principal), /Invalid CSRF token/);
  await auth!.logout(cookieRequest(other.session.id), randomUUID());
});

test("logout deletes the row and the cookie stops resolving", async (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.ok(issued, "depends on the login test above");

  await auth!.logout(cookieRequest(issued!.token), randomUUID());

  const { rows } = await admin!.query("SELECT 1 FROM osa.sessions WHERE id_hash = $1", [sha256(issued!.token)]);
  assert.equal(rows.length, 0, "logout deletes the session row; the schema has no revoked_at concept in the app");

  await assert.rejects(
    auth!.resolvePrincipal(issued!.token),
    (error: unknown) => error instanceof auth!.AuthError && error.status === 401 && error.message === "Session expired");

  const audit = await admin!.query(
    `SELECT actor_user_id FROM osa.audit_events
      WHERE tenant_id = $1 AND sequence > $2::bigint AND action = 'auth.logout' AND outcome = 'success'`,
    [fixture!.tenant, baselineSequence]);
  assert.ok(audit.rows.length >= 1);
  assert.equal(String(audit.rows[0].actor_user_id), fixture!.user);
});

test("login refuses when no workspace is named, and accepts the configured default", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const previous = process.env.DEFAULT_TENANT_SLUG;
  delete process.env.DEFAULT_TENANT_SLUG;
  try {
    // Tenant-first login: the user lookup never runs without a tenant context,
    // so a request that names no workspace is refused rather than answered by
    // searching across tenants.
    await assert.rejects(
      auth!.login(fixture!.email, PASSWORD, randomUUID()),
      (error: unknown) => error instanceof auth!.AuthError && error.message === "Tenant selection required");

    // The login form does not send a slug. `DEFAULT_TENANT_SLUG` is what keeps
    // it working without reopening the cross-tenant lookup.
    process.env.DEFAULT_TENANT_SLUG = fixture!.slug;
    const result = await auth!.login(fixture!.email, PASSWORD, randomUUID());
    assert.equal(result.user.id, fixture!.user);
    await auth!.logout(cookieRequest(result.session.id), randomUUID());
  } finally {
    if (previous === undefined) delete process.env.DEFAULT_TENANT_SLUG;
    else process.env.DEFAULT_TENANT_SLUG = previous;
  }
});

test("an unknown workspace is refused without disclosing that it is the workspace", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await assert.rejects(
    auth!.login(fixture!.email, PASSWORD, randomUUID(), `no-such-workspace-${randomUUID().slice(0, 8)}`),
    (error: unknown) => error instanceof auth!.AuthError && error.status === 401 && error.message === "Invalid credentials");
});

test("the application connects as a role that cannot bypass row-level security", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const seam = await import("../../src/lib/server/persistence");
  const report = await (await seam.requirePersistence()).assertRuntimeRoleIsSafe();
  assert.equal(report.role, runtimeRole);
  assert.equal(report.bypassRls, false);
  assert.equal(report.superuser, false);
  assert.equal(report.ownedTables, 0);
});
