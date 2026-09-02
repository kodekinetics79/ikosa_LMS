/**
 * The RLS proof.
 *
 * ADR-001 makes one load-bearing claim about the PostgreSQL design:
 *
 *     "A missed application predicate is still blocked by database RLS in
 *      production."
 *
 * Nothing had ever tested it. `database/postgres/001_initial.sql` has never
 * been connected to anything, so forced row-level security is, until this file
 * runs, an assertion in a document rather than a property of a system.
 *
 * These tests connect as a NON-OWNING, NON-BYPASSRLS runtime role and issue
 * queries with the tenant predicate DELIBERATELY OMITTED — including fetches by
 * primary key of a row that is known to exist and known to belong to another
 * tenant. Every one must return zero rows. `withoutTenantPredicate()` asserts
 * the omission mechanically, so the proof cannot quietly decay into a test that
 * filters after all.
 *
 * RUNNING IT
 *
 *   docker compose -f compose.infrastructure.yaml up -d postgres
 *   psql "$DATABASE_URL" -f database/postgres/002_learning_and_signals.sql
 *   npm install pg                     # `pg` is NOT a dependency of this repo
 *   node --import tsx --test tests/integration/postgres-repository.test.mjs
 *
 *   # or, without installing pg into this repo:
 *   IK_PG_MODULE=/abs/path/to/node_modules/pg/lib/index.js node --test …
 *
 * `--import tsx` additionally exercises the TypeScript adapter in
 * src/lib/server/db. Under plain `node --test` those tests report as skipped
 * and the SQL-level proof still runs in full.
 *
 * SKIPPING
 *
 * Every test skips — never fails — when the `pg` driver is absent, when no
 * PostgreSQL is reachable, or when migration 002 has not been applied. This
 * file must not break CI for the engineers who have no database in front of
 * them, and it is not wired into `npm test` (unit tests only) or
 * `scripts/run-live-integration.sh` (which names live-api.test.mjs explicitly).
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'postgresql://ik_osa:local-only-change-me@127.0.0.1:5432/ik_osa';
const adminUrl = process.env.DATABASE_URL ?? DEFAULT_URL;

/** The probe role. Deliberately NOT the production runtime role: this test never alters that one. */
const PROBE_ROLE = 'ik_osa_rls_probe';
const PROBE_PASSWORD = `probe_${randomUUID().replace(/-/g, '')}`;

/* -------------------------------------------------------------------------
 * Environment probe. Runs at module load so the skip reason is known before
 * any test is defined.
 * ---------------------------------------------------------------------- */

async function loadPg() {
  const candidates = ['pg'];
  const override = process.env.IK_PG_MODULE?.trim();
  if (override) candidates.push(override.startsWith('/') ? pathToFileURL(override).href : override);
  for (const specifier of candidates) {
    try {
      const loaded = await import(specifier);
      const mod = typeof loaded.Pool === 'function' ? loaded : loaded.default;
      if (mod && typeof mod.Pool === 'function') return mod;
    } catch { /* try the next candidate */ }
  }
  return null;
}

async function probe() {
  const pg = await loadPg();
  if (!pg) {
    return { skip: 'the pg driver is not installed (npm install pg, or set IK_PG_MODULE)' };
  }
  const pool = new pg.Pool({ connectionString: adminUrl, max: 2, connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await pool.query(`
      SELECT to_regclass('osa.evidence')     IS NOT NULL AS has_001,
             to_regclass('osa.enrollments')  IS NOT NULL AS has_002,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS admin_is_superuser`);
    if (!rows[0].has_001) {
      await pool.end();
      return { skip: `schema osa is not present at ${redact(adminUrl)}; apply database/postgres/001_initial.sql` };
    }
    if (!rows[0].has_002) {
      await pool.end();
      return { skip: `migration 002 has not been applied at ${redact(adminUrl)}` };
    }
    return { pg, pool, adminIsSuperuser: rows[0].admin_is_superuser === true, skip: false };
  } catch (error) {
    await pool.end().catch(() => {});
    return { skip: `no PostgreSQL reachable at ${redact(adminUrl)} (${error.code ?? error.message})` };
  }
}

function redact(url) {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

const env = await probe();
const skip = env.skip;
if (skip) console.log(`# postgres-repository: skipped — ${skip}`);

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Asserts that a statement contains no tenant predicate before running it.
 *
 * The entire value of these tests is that the application filter is missing. A
 * comment saying so rots; this does not.
 */
function withoutTenantPredicate(sql) {
  assert.equal(/tenant/i.test(sql), false, `this proof requires a statement with NO tenant predicate, got: ${sql}`);
  return sql;
}

/** Runs `fn` inside a transaction carrying the given tenant context, exactly as the adapter does. */
async function inTenantContext(client, tenantId, userId, fn) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * A complete, realistic tenant graph: org tree, users and roles, skill, job
 * role, requirement, study, evidence, gap, intervention, course with modules,
 * enrollment with a completion, signal with both junctions, and a
 * notification. Inserting it is itself a test that migration 002 accepts the
 * data the application produces.
 */
async function seedTenant(client, label) {
  const ids = {
    tenant: randomUUID(), orgRoot: randomUUID(), orgChild: randomUUID(),
    assessor: randomUUID(), learner: randomUUID(), skill: randomUUID(), jobRole: randomUUID(),
    requirement: randomUUID(), study: randomUUID(), evidence: randomUUID(), gap: randomUUID(),
    intervention: randomUUID(), course: randomUUID(), moduleLesson: randomUUID(),
    moduleAssessment: randomUUID(), enrollment: randomUUID(), completion: randomUUID(),
    signal: randomUUID(), notification: randomUUID(),
  };
  ids.rootPath = ids.orgRoot;
  ids.childPath = `${ids.orgRoot}.${ids.orgChild}`;
  ids.slug = `rls-${label}-${ids.tenant.slice(0, 8)}`;

  await client.query(
    `INSERT INTO osa.tenants (id, slug, name, home_region, locale) VALUES ($1,$2,$3,'us-east','en-US')`,
    [ids.tenant, ids.slug, `RLS probe ${label}`]);

  // Tenant context set for the seeding connection too: if the administrative
  // role is not a superuser, forced RLS applies to it and the WITH CHECK clause
  // rejects every insert without it.
  await client.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [ids.tenant, ids.assessor]);

  await client.query(
    `INSERT INTO osa.org_units (id, tenant_id, parent_id, code, name, path) VALUES
       ($1,$2,NULL,'ROOT','Root unit',$3::ltree),
       ($4,$2,$1,'CHILD','Child unit',$5::ltree)`,
    [ids.orgRoot, ids.tenant, ids.rootPath, ids.orgChild, ids.childPath]);

  await client.query(
    `INSERT INTO osa.users (id, tenant_id, org_unit_id, email, display_name, password_hash, delegated_org_paths) VALUES
       ($1,$2,$3,$4,'Probe Assessor','scrypt$deadbeef$00',ARRAY[$5::ltree]),
       ($6,$2,$7,$8,'Probe Learner','scrypt$deadbeef$00',ARRAY[$9::ltree])`,
    [ids.assessor, ids.tenant, ids.orgRoot, `assessor@${ids.slug}.example`, ids.rootPath,
      ids.learner, ids.orgChild, `learner@${ids.slug}.example`, ids.childPath]);

  await client.query(
    `INSERT INTO osa.user_roles (tenant_id, user_id, role_code) VALUES ($1,$2,'assessor'),($1,$3,'learner')`,
    [ids.tenant, ids.assessor, ids.learner]);

  await client.query(
    `INSERT INTO osa.skills (id, tenant_id, code, name, description) VALUES ($1,$2,'PROBE-SKILL','Probe skill','')`,
    [ids.skill, ids.tenant]);

  await client.query(
    `INSERT INTO osa.job_roles (id, tenant_id, org_unit_id, code, title, purpose, version, status, valid_from, recorded_by)
     VALUES ($1,$2,$3,'PROBE-ROLE','Probe role','Probe',1,'active', now(), $4)`,
    [ids.jobRole, ids.tenant, ids.orgRoot, ids.assessor]);

  await client.query(
    `INSERT INTO osa.requirements (id, tenant_id, org_unit_id, job_role_id, skill_id, source_type,
       source_reference, required_level, criticality, version, valid_from, recorded_by)
     VALUES ($1,$2,$3,$4,$5,'regulation','PROBE-REG',4,'mandatory',1, now(), $6)`,
    [ids.requirement, ids.tenant, ids.orgRoot, ids.jobRole, ids.skill, ids.assessor]);

  await client.query(
    `INSERT INTO osa.tna_studies (id, tenant_id, org_unit_id, title, objective, status, owner_user_id, due_date)
     VALUES ($1,$2,$3,'Probe study','Probe objective','analysis',$4,'2026-12-01')`,
    [ids.study, ids.tenant, ids.orgRoot, ids.assessor]);

  await client.query(
    `INSERT INTO osa.evidence (id, tenant_id, org_unit_id, subject_user_id, skill_id, evidence_type,
       proficiency_level, strength, observed_at, assessor_user_id, source_reference, status)
     VALUES ($1,$2,$3,$4,$5,'observation',2,0.85, now(), $6,'PROBE-OBS','verified')`,
    [ids.evidence, ids.tenant, ids.orgChild, ids.learner, ids.skill, ids.assessor]);

  await client.query(
    `INSERT INTO osa.gap_cases (id, tenant_id, org_unit_id, tna_study_id, subject_user_id, requirement_id,
       required_level, evidenced_level, priority, status)
     VALUES ($1,$2,$3,$4,$5,$6,4,2,'critical','open')`,
    [ids.gap, ids.tenant, ids.orgChild, ids.study, ids.learner, ids.requirement]);

  await client.query(
    `INSERT INTO osa.interventions (id, tenant_id, org_unit_id, gap_case_id, intervention_type, title,
       owner_user_id, due_date, status)
     VALUES ($1,$2,$3,$4,'learning','Probe intervention',$5,'2026-11-01','active')`,
    [ids.intervention, ids.tenant, ids.orgChild, ids.gap, ids.assessor]);

  await client.query(
    `INSERT INTO osa.courses (id, tenant_id, org_unit_id, code, title, description, skill_id, target_level,
       evidence_rule, passing_score, validity_months, version, status, recorded_by)
     VALUES ($1,$2,$3,'PROBE-101','Probe course','', $4, 4,'assessed',0.8,12,1,'published',$5)`,
    [ids.course, ids.tenant, ids.orgRoot, ids.skill, ids.assessor]);

  await client.query(
    `INSERT INTO osa.course_modules (id, tenant_id, course_id, position, title, kind, duration_minutes, required) VALUES
       ($1,$2,$3,1,'Lesson','lesson',20,true),
       ($4,$2,$3,2,'Assessment','assessment',30,true)`,
    [ids.moduleLesson, ids.tenant, ids.course, ids.moduleAssessment]);

  await client.query(
    `INSERT INTO osa.enrollments (id, tenant_id, org_unit_id, course_id, subject_user_id, source, status, due_date)
     VALUES ($1,$2,$3,$4,$5,'assigned','in_progress','2026-10-01')`,
    [ids.enrollment, ids.tenant, ids.orgChild, ids.course, ids.learner]);

  await client.query(
    `INSERT INTO osa.module_completions (id, tenant_id, enrollment_id, module_id, course_id, score)
     VALUES ($1,$2,$3,$4,$5,NULL)`,
    [ids.completion, ids.tenant, ids.enrollment, ids.moduleLesson, ids.course]);

  await client.query(
    `INSERT INTO osa.signals (id, tenant_id, org_unit_id, source, source_reference, title, summary,
       detected_at, severity, status)
     VALUES ($1,$2,$3,'regulation','PROBE-REG-2','Probe signal','', now(),'critical','new')`,
    [ids.signal, ids.tenant, ids.orgRoot]);
  await client.query(`INSERT INTO osa.signal_job_roles (tenant_id, signal_id, job_role_id) VALUES ($1,$2,$3)`,
    [ids.tenant, ids.signal, ids.jobRole]);
  await client.query(`INSERT INTO osa.signal_skills (tenant_id, signal_id, skill_id) VALUES ($1,$2,$3)`,
    [ids.tenant, ids.signal, ids.skill]);

  await client.query(
    `INSERT INTO osa.notifications (id, tenant_id, org_unit_id, subject_user_id, kind, severity, title, body,
       resource_type, resource_id, due_at, dedupe_key)
     VALUES ($1,$2,$3,$4,'enrollment_due','high','Probe notification','','enrollment',$5, now(), $6)`,
    [ids.notification, ids.tenant, ids.orgChild, ids.learner, ids.enrollment, `enrollment_due:${ids.enrollment}`]);

  await client.query("SELECT set_config('app.tenant_id', '', false), set_config('app.user_id', '', false)");
  return ids;
}

/** Mirrors migration 002 §7 for a throwaway probe role, so the grant set under test is the documented one. */
async function provisionProbeRole(client) {
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        -- Managed platforms (Neon, RDS) run migrations as a non-superuser, and
        -- only a superuser may touch the SUPERUSER attribute at all - even to
        -- clear it. Roles there are NOSUPERUSER by default, so state the
        -- attribute only when we are actually able to.
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
  await client.query(`GRANT USAGE ON SCHEMA osa TO ${PROBE_ROLE}`);
  await client.query(`GRANT SELECT ON osa.tenants TO ${PROBE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT ON osa.audit_events TO ${PROBE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, DELETE ON osa.sessions TO ${PROBE_ROLE}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO ${PROBE_ROLE}`);
  await client.query(`GRANT EXECUTE ON FUNCTION osa.resolve_session(bytea) TO ${PROBE_ROLE}`);
  await client.query(`GRANT EXECUTE ON FUNCTION osa.current_tenant_id() TO ${PROBE_ROLE}`);
  for (const table of ['org_units', 'users', 'user_roles', 'job_roles', 'skills', 'requirements',
    'tna_studies', 'tna_target_roles', 'evidence', 'gap_cases', 'interventions', 'courses',
    'course_modules', 'enrollments', 'module_completions', 'signals', 'signal_job_roles',
    'signal_skills', 'notifications']) {
    await client.query(`GRANT SELECT, INSERT, UPDATE ON osa.${table} TO ${PROBE_ROLE}`);
  }
}

function probeConnectionString() {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

let admin;            // superuser / owner connection
let runtime;          // the non-owning, NOBYPASSRLS runtime role
let runtimePool;
let alpha, beta;      // two tenants

before(async () => {
  if (skip) return;
  admin = await env.pool.connect();
  await provisionProbeRole(admin);
  alpha = await seedTenant(admin, 'alpha');
  beta = await seedTenant(admin, 'beta');
  runtimePool = new env.pg.Pool({ connectionString: probeConnectionString(), max: 2, connectionTimeoutMillis: 3000 });
  runtime = await runtimePool.connect();
});

after(async () => {
  if (skip) return;
  // Ordered by dependency. osa.audit_events is append-only by design and is
  // deliberately not cleaned up — deleting it is what the trigger prevents.
  for (const tenant of [alpha?.tenant, beta?.tenant].filter(Boolean)) {
    await admin.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $1, false)", [tenant]);
    for (const table of ['notifications', 'signal_skills', 'signal_job_roles', 'signals',
      'module_completions', 'enrollments', 'course_modules', 'courses', 'interventions', 'gap_cases',
      'tna_target_roles', 'tna_studies', 'evidence', 'requirements', 'job_roles', 'skills',
      'sessions', 'user_roles', 'users', 'org_units']) {
      await admin.query(`DELETE FROM osa.${table} WHERE tenant_id = $1`, [tenant]).catch(() => {});
    }
  }
  await admin.query("SELECT set_config('app.tenant_id', '', false)");
  await admin.query('DELETE FROM osa.tenants WHERE id = ANY($1::uuid[])',
    [[alpha?.tenant, beta?.tenant].filter(Boolean)]).catch(() => {});
  runtime?.release();
  await runtimePool?.end();
  admin?.release();
  await env.pool?.end();
});

/* =========================================================================
 * 1. The runtime role itself
 * ====================================================================== */

test('the runtime role satisfies the ADR-001 release blockers', { skip }, async () => {
  const { rows } = await runtime.query(`
    SELECT current_user::text AS role,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls,
           (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS superuser,
           (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'osa' AND c.relkind IN ('r','p')
               AND pg_get_userbyid(c.relowner) = current_user) AS owned_tables`);
  assert.equal(rows[0].role, PROBE_ROLE);
  assert.equal(rows[0].bypass_rls, false, 'BYPASSRLS disables every tenant_isolation policy');
  assert.equal(rows[0].superuser, false, 'a superuser bypasses row-level security entirely');
  assert.equal(rows[0].owned_tables, 0, 'an owner can ALTER TABLE ... DISABLE ROW LEVEL SECURITY');
});

test('the runtime role cannot turn row-level security off', { skip }, async () => {
  const error = await errorFrom(runtime.query('ALTER TABLE osa.evidence DISABLE ROW LEVEL SECURITY'));
  assert.ok(error, 'expected the runtime role to be refused');
  assert.equal(error.code, '42501');
});

/* =========================================================================
 * 2. THE PROOF — a missed application predicate is still blocked
 * ====================================================================== */

test('a cross-tenant read returns zero rows even with the application filter deliberately omitted', { skip }, async () => {
  // Not "SELECT ... WHERE tenant_id = $1". The predicate a careless refactor
  // would drop is simply not here, and withoutTenantPredicate() proves it.
  const countAll = withoutTenantPredicate('SELECT count(*)::int AS n FROM osa.evidence');
  const byPrimaryKey = withoutTenantPredicate('SELECT id, source_reference FROM osa.evidence WHERE id = $1::uuid');

  // Sanity: both rows exist, and the owner (which bypasses RLS) can see both.
  if (env.adminIsSuperuser) {
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM osa.evidence WHERE id = ANY($1::uuid[])',
      [[alpha.evidence, beta.evidence]]);
    assert.equal(rows[0].n, 2, 'fixture rows for both tenants must exist before the proof means anything');
  }

  await inTenantContext(runtime, alpha.tenant, alpha.assessor, async () => {
    const all = await runtime.query(countAll);
    assert.equal(all.rows[0].n, 1, "alpha's context must see exactly its own evidence row");

    const own = await runtime.query(byPrimaryKey, [alpha.evidence]);
    assert.equal(own.rows.length, 1, 'alpha must still be able to read its own row');

    // The heart of it: a fetch by primary key of a row that certainly exists,
    // with no tenant predicate, targeting another tenant.
    const foreign = await runtime.query(byPrimaryKey, [beta.evidence]);
    assert.equal(foreign.rows.length, 0, "beta's evidence must be invisible to alpha even by primary key");
  });

  await inTenantContext(runtime, beta.tenant, beta.assessor, async () => {
    const foreign = await runtime.query(byPrimaryKey, [alpha.evidence]);
    assert.equal(foreign.rows.length, 0, 'the block is symmetric');
    const own = await runtime.query(byPrimaryKey, [beta.evidence]);
    assert.equal(own.rows.length, 1);
  });
});

test('every table added by migration 002 is covered by the same proof', { skip }, async () => {
  const cases = [
    ['courses', alpha.course, beta.course],
    ['course_modules', alpha.moduleLesson, beta.moduleLesson],
    ['enrollments', alpha.enrollment, beta.enrollment],
    ['module_completions', alpha.completion, beta.completion],
    ['signals', alpha.signal, beta.signal],
    ['notifications', alpha.notification, beta.notification],
  ];

  await inTenantContext(runtime, alpha.tenant, alpha.assessor, async () => {
    for (const [table, ownId, foreignId] of cases) {
      const byId = withoutTenantPredicate(`SELECT id FROM osa.${table} WHERE id = $1::uuid`);
      assert.equal((await runtime.query(byId, [ownId])).rows.length, 1, `${table}: own row must be readable`);
      assert.equal((await runtime.query(byId, [foreignId])).rows.length, 0, `${table}: foreign row must be invisible`);

      const countAll = withoutTenantPredicate(`SELECT count(*)::int AS n FROM osa.${table}`);
      const { rows } = await runtime.query(countAll);
      assert.equal(rows[0].n, table === 'course_modules' ? 2 : 1, `${table}: an unfiltered count must not cross tenants`);
    }

    // Junction tables carry no id column; they are proved on their composite key.
    for (const junction of ['signal_job_roles', 'signal_skills']) {
      const bySignal = withoutTenantPredicate(`SELECT signal_id FROM osa.${junction} WHERE signal_id = $1::uuid`);
      assert.equal((await runtime.query(bySignal, [alpha.signal])).rows.length, 1);
      assert.equal((await runtime.query(bySignal, [beta.signal])).rows.length, 0, `${junction}: foreign row must be invisible`);
    }
  });
});

test('a cross-tenant JOIN cannot smuggle rows past the policy', { skip }, async () => {
  // A join is where a forgotten predicate most often hides: the developer
  // filters the driving table and trusts the join key for the rest.
  const sql = withoutTenantPredicate(`
    SELECT e.id
      FROM osa.evidence e
      JOIN osa.users u ON u.id = e.subject_user_id
      JOIN osa.org_units o ON o.id = e.org_unit_id`);
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, async () => {
    const { rows } = await runtime.query(sql);
    assert.deepEqual(rows.map((row) => row.id), [alpha.evidence]);
  });
});

test('a write carrying another tenant id is refused by the policy WITH CHECK clause', { skip }, async () => {
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () =>
    runtime.query(
      `INSERT INTO osa.notifications (tenant_id, org_unit_id, subject_user_id, kind, severity, title, body,
         resource_type, resource_id, dedupe_key)
       VALUES ($1,$2,$3,'enrollment_due','high','Smuggled','', 'enrollment', $4, $5)`,
      [beta.tenant, beta.orgChild, beta.learner, beta.enrollment, `smuggle:${randomUUID()}`])));
  assert.ok(error, 'expected the insert to be refused');
  assert.equal(error.code, '42501');
  assert.match(error.message, /row-level security/i);
});

test('an UPDATE cannot move a row into another tenant', { skip }, async () => {
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, async () => {
    // The row is invisible, so the UPDATE matches nothing rather than erroring.
    const invisible = await runtime.query(
      withoutTenantPredicate("UPDATE osa.enrollments SET status = 'withdrawn' WHERE id = $1::uuid"), [beta.enrollment]);
    assert.equal(invisible.rowCount, 0, "beta's enrollment must not be updatable from alpha's context");
  });
  const { rows } = await admin.query('SELECT status FROM osa.enrollments WHERE id = $1::uuid', [beta.enrollment]);
  assert.equal(rows[0].status, 'in_progress', 'the row must be untouched');
});

test('no tenant context at all yields no rows, not every row', { skip }, async () => {
  // The state a pooled connection is in before a request sets its context, and
  // the state it returns to after COMMIT. Failing open here would be the worst
  // possible default.
  await runtime.query('BEGIN');
  await runtime.query("SELECT set_config('app.tenant_id', '', true)");
  const { rows } = await runtime.query(withoutTenantPredicate('SELECT count(*)::int AS n FROM osa.evidence'));
  await runtime.query('COMMIT');
  assert.equal(rows[0].n, 0);
});

test('SET LOCAL context does not survive the transaction that set it', { skip }, async () => {
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, async () => {
    const { rows } = await runtime.query(withoutTenantPredicate('SELECT count(*)::int AS n FROM osa.evidence'));
    assert.equal(rows[0].n, 1);
  });
  // Same physical connection, no BEGIN: this is what the next request would get
  // from the pool if the context had been set at session level.
  const { rows } = await runtime.query(withoutTenantPredicate('SELECT count(*)::int AS n FROM osa.evidence'));
  assert.equal(rows[0].n, 0, 'tenant context must not leak between pooled requests');
});

test('osa.tenants is readable across tenants — a deliberate exception, and a narrow one', { skip }, async () => {
  // 001 omits osa.tenants from the RLS array. That is what makes tenant-first
  // login possible (slug -> tenant_id before any session exists), and it is a
  // real exposure: the runtime role can enumerate the tenant directory. The
  // grant matrix limits it to SELECT. Asserted here so the exception stays
  // deliberate rather than becoming a surprise.
  const { rows } = await runtime.query('SELECT count(*)::int AS n FROM osa.tenants WHERE id = ANY($1::uuid[])',
    [[alpha.tenant, beta.tenant]]);
  assert.equal(rows[0].n, 2);
  const denied = await errorFrom(runtime.query('DELETE FROM osa.tenants WHERE id = $1::uuid', [beta.tenant]));
  assert.ok(denied, 'the runtime role must not be able to write the tenant directory');
  assert.equal(denied.code, '42501');
});

/* =========================================================================
 * 3. Invariants migration 002 moves out of application code
 * ====================================================================== */

test('audit events cannot be updated or deleted', { skip }, async () => {
  const id = randomUUID();
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    `INSERT INTO osa.audit_events (id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome,
       request_id, metadata, previous_hash, event_hash)
     VALUES ($1,$2,$3,'probe.write','evidence',$4,'success','req-probe','{}'::jsonb,
             decode(repeat('00',32),'hex'), decode(repeat('ab',32),'hex'))`,
    [id, alpha.tenant, alpha.assessor, alpha.evidence]));

  // First layer: the runtime role holds only SELECT and INSERT, so the
  // privilege check refuses before the trigger is ever reached.
  const updated = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () =>
    runtime.query("UPDATE osa.audit_events SET action = 'tampered' WHERE id = $1::uuid", [id])));
  assert.ok(updated);
  assert.equal(updated.code, '42501');
  const deleted = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () =>
    runtime.query('DELETE FROM osa.audit_events WHERE id = $1::uuid', [id])));
  assert.ok(deleted);
  assert.equal(deleted.code, '42501');

  // Second layer, and the one that matters: the OWNER holds the privilege, and
  // the append-only trigger refuses anyway. This is what still stands if a
  // later migration grants UPDATE by accident, or if the owner's credentials
  // are the ones that leak.
  const ownerUpdate = await errorFrom(
    admin.query("UPDATE osa.audit_events SET action = 'tampered' WHERE id = $1::uuid", [id]));
  assert.ok(ownerUpdate, 'the ledger must refuse its own owner');
  assert.match(ownerUpdate.message, /append-only/i);
  const ownerDelete = await errorFrom(admin.query('DELETE FROM osa.audit_events WHERE id = $1::uuid', [id]));
  assert.ok(ownerDelete);
  assert.match(ownerDelete.message, /append-only/i);
});

test('only one active enrollment per learner per course can exist', { skip }, async () => {
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    `INSERT INTO osa.enrollments (tenant_id, org_unit_id, course_id, subject_user_id, source, status)
     VALUES ($1,$2,$3,$4,'self','enrolled')`,
    [alpha.tenant, alpha.orgChild, alpha.course, alpha.learner])));
  assert.ok(error, 'the read-then-write in the route is a race; the index is not');
  assert.equal(error.code, '23505');
  assert.match(error.message, /enrollments_one_active/);
});

test('one condition may have only one OPEN notification, but may recur after resolution', { skip }, async () => {
  const key = `enrollment_due:${alpha.enrollment}`;
  const raise = (title) => runtime.query(
    `INSERT INTO osa.notifications (tenant_id, org_unit_id, subject_user_id, kind, severity, title, body,
       resource_type, resource_id, dedupe_key)
     VALUES ($1,$2,$3,'enrollment_due','high',$6,'', 'enrollment', $4, $5) RETURNING id`,
    [alpha.tenant, alpha.orgChild, alpha.learner, alpha.enrollment, key, title]);

  // A second OPEN row for the same condition is the duplicate reminder the
  // sweep promises can never happen.
  const duplicate = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => raise('Duplicate')));
  assert.ok(duplicate);
  assert.equal(duplicate.code, '23505');
  assert.match(duplicate.message, /notifications_one_open/);

  // But a resolved row must NOT block the condition recurring. sweepNotifications()
  // resolves an open row and leaves it on file; when the enrollment reopens it
  // raises a fresh unread row beside it with the same key. A total
  // UNIQUE (tenant_id, dedupe_key) would reject that second episode and the
  // platform would quietly stop chasing a reopened obligation.
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    'UPDATE osa.notifications SET resolved_at = now() WHERE id = $1::uuid', [alpha.notification]));
  const recurrence = await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => raise('Recurrence'));
  assert.equal(recurrence.rows.length, 1, 'a resolved episode must not block the next one');

  const { rows } = await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    'SELECT count(*)::int AS n FROM osa.notifications WHERE dedupe_key = $1', [key]));
  assert.equal(rows[0].n, 2, 'the resolved episode stays on file as part of the record');
});

test('a module completion cannot reference a module from another course', { skip }, async () => {
  // learning.ts throws "Module does not belong to the enrolled course" at
  // runtime. The composite key makes it unrepresentable.
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    `INSERT INTO osa.module_completions (tenant_id, enrollment_id, module_id, course_id)
     VALUES ($1,$2,$3,$4)`,
    [alpha.tenant, alpha.enrollment, beta.moduleLesson, alpha.course])));
  assert.ok(error);
  assert.equal(error.code, '23503');
});

test('an attendance-only course cannot carry a pass mark', { skip }, async () => {
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    `INSERT INTO osa.courses (tenant_id, org_unit_id, code, title, skill_id, target_level, evidence_rule,
       passing_score, version, status)
     VALUES ($1,$2,'PROBE-ATT','Attendance',$3,1,'attendance_only',0.8,1,'published')`,
    [alpha.tenant, alpha.orgRoot, alpha.skill])));
  assert.ok(error);
  assert.equal(error.code, '23514');
});

test('a signal cannot be dismissed without a named reason and a triager', { skip }, async () => {
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    "UPDATE osa.signals SET status = 'dismissed' WHERE id = $1::uuid", [alpha.signal])));
  assert.ok(error, '"nobody looked at it" is the failure this product exists to prevent');
  assert.equal(error.code, '23514');
});

test('gap_cases.gap is generated, so the current refreshGapsForEvidence UPDATE would fail', { skip }, async () => {
  // Documents a real divergence: learning.ts assigns `gap.gap = ...`, and a
  // literal port of that assignment into SQL is rejected outright.
  const error = await errorFrom(inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    'UPDATE osa.gap_cases SET evidenced_level = 4, gap = 0 WHERE id = $1::uuid', [alpha.gap])));
  assert.ok(error);
  assert.equal(error.code, '428C9');

  // The adapter's form — omitting the generated column — succeeds, and the
  // database recomputes the gap.
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    'UPDATE osa.gap_cases SET evidenced_level = 4 WHERE id = $1::uuid', [alpha.gap]));
  const { rows } = await inTenantContext(runtime, alpha.tenant, alpha.assessor, () =>
    runtime.query('SELECT gap FROM osa.gap_cases WHERE id = $1::uuid', [alpha.gap]));
  assert.equal(rows[0].gap, 0);
});

test('session resolution works for the runtime role without any RLS escape of its own', { skip }, async () => {
  const token = randomUUID();
  await inTenantContext(runtime, alpha.tenant, alpha.assessor, () => runtime.query(
    `INSERT INTO osa.sessions (id_hash, tenant_id, user_id, csrf_hash, expires_at)
     VALUES ($1,$2,$3,$4, now() + interval '12 hours')`,
    [sha256(token), alpha.tenant, alpha.assessor, sha256('csrf')]));

  // No transaction, no tenant context: this is the state a request is in when
  // it holds only a cookie.
  const resolved = await runtime.query('SELECT tenant_id, user_id FROM osa.resolve_session($1)', [sha256(token)]);
  assert.equal(resolved.rows.length, 1);
  assert.equal(resolved.rows[0].tenant_id, alpha.tenant);

  // And the table itself stays closed to the runtime role without a context.
  const direct = await runtime.query(withoutTenantPredicate('SELECT count(*)::int AS n FROM osa.sessions'));
  assert.equal(direct.rows[0].n, 0, 'osa.resolve_session must be the only way in');
});

/* =========================================================================
 * 4. The TypeScript adapter (requires tsx)
 * ====================================================================== */

let adapter = null;
if (!skip) {
  try {
    adapter = await import('../../src/lib/server/db/postgres.ts');
  } catch { /* plain `node --test`: TypeScript is not loadable, so these skip */ }
}
const adapterSkip = skip || (adapter ? false : 'run with `node --import tsx --test` to exercise the TypeScript adapter');

test('the adapter refuses to start against an unsafe runtime role', { skip: adapterSkip }, async () => {
  const driver = await import('../../src/lib/server/db/driver.ts');
  assert.throws(
    () => driver.assertRuntimeRoleIsSafe({ role: 'app', bypassRls: true, superuser: false, ownedTables: 0 }),
    /BYPASSRLS/);
  assert.throws(
    () => driver.assertRuntimeRoleIsSafe({ role: 'app', bypassRls: false, superuser: false, ownedTables: 3 }),
    /owns 3 table/);
  assert.deepEqual(
    driver.assertRuntimeRoleIsSafe({ role: 'app', bypassRls: false, superuser: false, ownedTables: 0 }).role, 'app');
});

test('the adapter refuses a tenant context that did not come from a validated session', { skip: adapterSkip }, async () => {
  const driver = await import('../../src/lib/server/db/driver.ts');
  await assert.rejects(
    () => driver.setTenantContext({ query: async () => ({ rows: [], rowCount: 0 }) }, 'ten_northstar', randomUUID()),
    driver.TenantContextError);
});

test('the adapter reads only in-scope rows and its scope predicate is not the only defence', { skip: adapterSkip }, async () => {
  const persistence = await adapter.createPostgresPersistence({ connectionString: probeConnectionString() });
  assert.ok(persistence, 'the adapter must connect with the same pg driver this test loaded');
  try {
    const report = await persistence.assertRuntimeRoleIsSafe();
    assert.equal(report.bypassRls, false);

    const scope = {
      tenantId: alpha.tenant, userId: alpha.assessor,
      orgScopes: [`/${alpha.orgRoot}`], viewerOrgPath: `/${alpha.orgRoot}`, selfOnly: false,
    };
    const result = await persistence.read(scope, async (repo) => ({
      evidence: await repo.listEvidenceInScope(),
      courses: await repo.listAvailableCourses(),
      enrollments: await repo.listEnrollmentsWithProgress(),
      gaps: await repo.listGapCasesWithContext(),
      summary: await repo.readinessSummary(),
      signals: await repo.listSignalsInScope(),
      tenant: await repo.tenant(),
    }));

    assert.equal(result.tenant.id, alpha.tenant);
    assert.deepEqual(result.evidence.map((row) => row.id), [alpha.evidence]);
    assert.equal(result.evidence[0].strength, 0.85, 'numeric must arrive as a number, not the string "0.850"');
    assert.equal(result.courses.length, 1);
    assert.equal(result.courses[0].moduleCount, 2);
    assert.equal(result.courses[0].durationMinutes, 50);
    assert.equal(result.enrollments.length, 1);
    assert.equal(result.enrollments[0].dueDate, '2026-10-01', 'a date column must not drift by a timezone');
    assert.equal(result.enrollments[0].progress.completed, 1);
    assert.equal(result.enrollments[0].progress.total, 2);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].requirement.sourceReference, 'PROBE-REG');
    assert.equal(result.gaps[0].interventions.length, 1);
    assert.equal(result.signals[0].affectedSkillIds.length, 1);
    assert.equal(result.summary.studies, 1);

    // Self-scope narrows to the subject, exactly as isSelfScopedOnly() does.
    const selfScoped = await persistence.read({ ...scope, userId: alpha.assessor, selfOnly: true },
      (repo) => repo.listEvidenceInScope());
    assert.equal(selfScoped.length, 0, 'the assessor is not the subject of their own observation');
  } finally {
    await persistence.close();
  }
});

test('the adapter appends a verifiable audit chain and the GENESIS sentinel survives bytea storage', { skip: adapterSkip }, async () => {
  const persistence = await adapter.createPostgresPersistence({ connectionString: probeConnectionString() });
  try {
    const scope = {
      tenantId: alpha.tenant, userId: alpha.assessor,
      orgScopes: [`/${alpha.orgRoot}`], viewerOrgPath: `/${alpha.orgRoot}`, selfOnly: false,
    };
    const first = await persistence.write(scope, (repo) => repo.appendAudit({
      actorUserId: alpha.assessor, action: 'probe.first', resourceType: 'evidence',
      resourceId: alpha.evidence, outcome: 'success', requestId: 'req-1', metadata: { probe: true },
    }));
    const second = await persistence.write(scope, (repo) => repo.appendAudit({
      actorUserId: alpha.assessor, action: 'probe.second', resourceType: 'evidence',
      resourceId: alpha.evidence, outcome: 'success', requestId: 'req-2',
    }));

    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(second.previousHash, first.hash, 'the second event must chain onto the first');

    // Read back through the mapping layer: the hex <-> bytea round trip must be
    // lossless, or every historical signature fails verification.
    const page = await persistence.read(scope, (repo) => repo.auditChainPage(null, 100));
    const stored = page.find((event) => event.id === second.id);
    assert.ok(stored, 'the appended event must be readable back');
    assert.equal(stored.hash, second.hash);
    assert.equal(stored.previousHash, first.hash);
    assert.deepEqual(stored.metadata, {});

    const genesis = page.find((event) => event.previousHash === 'GENESIS');
    assert.ok(genesis, 'the first event of a tenant chain stores GENESIS as 32 zero bytes and reads back as "GENESIS"');
  } finally {
    await persistence.close();
  }
});

test('the adapter signs audit events identically to audit.ts', { skip: adapterSkip }, async () => {
  // audit-chain.ts duplicates the HMAC because `appendAuditWithin` mints a
  // non-uuid id that is itself part of the signature. This test is the only
  // thing stopping the two implementations from drifting, which would make one
  // of them declare a perfectly intact ledger tampered with.
  const domain = await import('../../src/lib/server/audit.ts');
  if (typeof domain.appendAuditWithin !== 'function') {
    console.log('# audit.ts no longer exports appendAuditWithin; equivalence unproven');
    return;
  }
  const chain = await import('../../src/lib/server/db/audit-chain.ts');

  const shell = { auditEvents: [] };
  const produced = domain.appendAuditWithin(shell, {
    tenantId: alpha.tenant, actorUserId: alpha.assessor, action: 'probe.equivalence',
    resourceType: 'evidence', resourceId: alpha.evidence, outcome: 'success',
    requestId: 'req-equivalence', metadata: { a: 1, b: 'two', c: true, d: null },
  });

  const { hash, ...unsigned } = produced;
  assert.equal(chain.digestOf(unsigned), hash,
    'the adapter and audit.ts must produce the same HMAC for a byte-identical event');
  assert.equal(produced.previousHash, 'GENESIS');
});

/* =========================================================================
 * 5. Rollback rehearsal (opt-in: it drops the eight tables 002 creates)
 * ====================================================================== */

const rollbackSkip = skip ||
  (process.env.IK_PG_REHEARSE_ROLLBACK === 'true'
    ? false
    : 'set IK_PG_REHEARSE_ROLLBACK=true to rehearse the rollback (it drops the tables migration 002 creates)');

test('migration 002 rolls back to the 001 baseline and re-applies', { skip: rollbackSkip }, async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const migration = await readFile(path.join(root, 'database/postgres/002_learning_and_signals.sql'), 'utf8');
  const rollback = migration.split('\n')
    .filter((line) => line.startsWith('--! '))
    .map((line) => line.slice(4))
    .join('\n');
  assert.match(rollback, /DROP TABLE IF EXISTS osa\.notifications/);

  await admin.query(rollback);
  const after = await admin.query(`
    SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'osa'`);
  assert.equal(after.rows[0].tables, 14, 'rollback must leave exactly the 14 tables 001 creates');

  await admin.query(migration);
  const reapplied = await admin.query(`
    SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'osa'`);
  assert.equal(reapplied.rows[0].tables, 22, 're-applying must restore all 22 tables');
});
