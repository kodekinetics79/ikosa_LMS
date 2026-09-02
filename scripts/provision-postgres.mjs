/**
 * Load the demo dataset into PostgreSQL. Idempotent; safe to re-run.
 *
 *   node --import tsx scripts/provision-postgres.mjs
 *
 * The schema is created by database/postgres/001_initial.sql and
 * 002_learning_and_signals.sql. Those migrations create 22 empty tables, which
 * means a freshly provisioned database has no tenants and nobody can sign in.
 * This script closes that gap and nothing else.
 *
 * WHAT IT LOADS
 *   `seedDatabase()` from src/lib/server/seed.ts — the same fixture the JSON
 *   store uses — translated to storage form by src/lib/server/db/write-mapping.ts
 *   and src/lib/server/db/ids.ts. The fixtures are imported, never retyped, so
 *   the two datastores cannot drift.
 *
 * WHAT IT DELIBERATELY DOES NOT LOAD
 *   * osa.audit_events. The ledger is a per-tenant HMAC chain over content that
 *     includes each event's own id. A backfilled row cannot be signed by
 *     anything that would later verify, so seeded history would report
 *     `hash_mismatch` on data nobody tampered with. The chain must start empty
 *     and grow from real activity.
 *   * osa.sessions. The table keys on `id_hash` and stores `csrf_hash`; the
 *     plaintext token is not recoverable from a hash, so a seeded session is a
 *     row no browser could ever present. Sign in instead.
 *
 * WHICH ROLE IT CONNECTS AS
 *   The migration role (DATABASE_URL_UNPOOLED), not the runtime role. The
 *   runtime role holds SELECT and no more on osa.tenants — by design, since
 *   creating a tenant is not something a request should be able to do — so it
 *   cannot perform this load at all. `app.tenant_id` is still set for every
 *   tenant's statements: the tables are FORCE ROW LEVEL SECURITY, so a
 *   migration role without BYPASSRLS is filtered exactly like the application,
 *   and setting the context keeps this script correct under either kind of role.
 *
 * VERIFICATION
 *   Every assertion is then re-run over a second connection opened as the
 *   RUNTIME role (/tmp/ik-runtime-url), which holds NOBYPASSRLS and owns no
 *   tables. Proving the data is readable by the migration role would prove
 *   nothing about whether the application can see it.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { seedDatabase } from "../src/lib/server/seed.ts";
import { verifyPassword } from "../src/lib/server/security.ts";
import { assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule } from "../src/lib/server/db/driver.ts";
import { ltreeToPath, pathToLtree, toStorageId } from "../src/lib/server/db/ids.ts";
import {
  fromCourse, fromCourseModule, fromEnrollment, fromEvidence, fromGapCase,
  fromIntervention, fromJobRole, fromModuleCompletion, fromNotification,
  fromOrgUnit, fromRequirement, fromSignal, fromSignalJobRoles, fromSignalSkills,
  fromSkill, fromStudy, fromStudyTargetRoles, fromTenant, fromUser, fromUserRoles,
} from "../src/lib/server/db/write-mapping.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_URL_FILE = process.env.IK_RUNTIME_URL_FILE ?? "/tmp/ik-runtime-url";
const DEMO_PASSWORD = "Demo!2026";

/* ---------------------------------------------------------------------------
 * Credentials
 *
 * Read from the environment or from a file outside the repository. Nothing in
 * this script prints a connection string, a password or a password hash.
 * ------------------------------------------------------------------------- */

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // a real env var always wins
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function adminConnectionString() {
  const url = process.env.IK_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    throw new Error(
      "No admin connection string. Set DATABASE_URL_UNPOOLED (or IK_ADMIN_DATABASE_URL), or put it in .env.local. " +
      "The pooled DATABASE_URL is not used: this is a single transaction and wants one session.",
    );
  }
  return url;
}

function runtimeConnectionString() {
  const fromEnv = process.env.IK_RUNTIME_DATABASE_URL;
  if (fromEnv) return fromEnv;
  if (existsSync(RUNTIME_URL_FILE)) {
    const contents = readFileSync(RUNTIME_URL_FILE, "utf8").trim();
    if (contents) return contents;
  }
  return null;
}

/** Redacts the password so a connection failure can be diagnosed without leaking one. */
function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.username}@${url.hostname}${url.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}

/* ---------------------------------------------------------------------------
 * Table catalogue
 *
 * Every table name in this file is a literal from this list; none is ever
 * derived from data. Column names come from write-mapping.ts, also literals.
 * ------------------------------------------------------------------------- */

/** The 22 tables 001 and 002 create, in dependency order. */
const ALL_TABLES = [
  "tenants", "org_units", "users", "user_roles", "sessions", "skills", "job_roles",
  "requirements", "tna_studies", "tna_target_roles", "evidence", "gap_cases",
  "interventions", "courses", "course_modules", "enrollments", "module_completions",
  "signals", "signal_job_roles", "signal_skills", "notifications", "audit_events",
];

/** Tables this script never writes, and why. Asserted to be unchanged by the load. */
const NEVER_SEEDED = new Set(["sessions", "audit_events"]);

/**
 * `ON CONFLICT (id) DO NOTHING` wherever `id` is the primary key: a second run
 * is a no-op, but a genuine collision on any OTHER unique constraint —
 * (tenant_id, code, version), (tenant_id, path), (tenant_id, email) — still
 * raises. Junction tables have a composite primary key and no other unique
 * constraint, so a bare `ON CONFLICT DO NOTHING` is exact for them.
 */
const JUNCTION_TABLES = new Set(["user_roles", "tna_target_roles", "signal_job_roles", "signal_skills"]);

function conflictClause(table) {
  return JUNCTION_TABLES.has(table) ? "ON CONFLICT DO NOTHING" : "ON CONFLICT (id) DO NOTHING";
}

/* ---------------------------------------------------------------------------
 * Output helpers
 * ------------------------------------------------------------------------- */

function renderTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[column] ?? "").length)));
  const line = (cells, pad = " ") =>
    cells.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column], pad) : String(cell).padStart(widths[column], pad))).join("  ");
  const out = [line(headers), line(widths.map((width) => "-".repeat(width)), "-")];
  for (const row of rows) out.push(line(row.map((cell) => cell ?? "")));
  return out.map((row) => `  ${row}`).join("\n");
}

function heading(text) {
  console.log(`\n${text}\n${"=".repeat(text.length)}`);
}

const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  return ok;
}

/* ---------------------------------------------------------------------------
 * Insert
 * ------------------------------------------------------------------------- */

async function insertRows(client, table, rows) {
  if (rows.length === 0) return { attempted: 0, inserted: 0 };
  let inserted = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    // Table and column names are literals from this file and write-mapping.ts.
    // Every value is bound.
    const sql = `INSERT INTO osa.${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ${conflictClause(table)}`;
    const result = await client.query(sql, columns.map((column) => row[column]));
    inserted += result.rowCount ?? 0;
  }
  return { attempted: rows.length, inserted };
}

/** Row counts for all 22 tables: the whole table, and the rows this seed owns. */
async function tableCounts(client, seedTenantIds) {
  const counts = {};
  for (const table of ALL_TABLES) {
    const scope = table === "tenants" ? "id" : "tenant_id";
    const { rows } = await client.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE ${scope} = ANY($1::uuid[])) AS seeded
         FROM osa.${table}`,
      [seedTenantIds],
    );
    counts[table] = { total: Number(rows[0].total), seeded: Number(rows[0].seeded) };
  }
  return counts;
}

/**
 * A digest over every seeded row of every table.
 *
 * Counts prove no row was added. This proves no row was CHANGED: `t::text` is
 * the whole row, so an upsert that rewrote a column — a re-derived password
 * hash, a refreshed timestamp — would move the digest even though the count
 * held. It is the difference between "the second run inserted nothing" and
 * "the second run changed nothing".
 */
async function seedDigest(client, seedTenantIds) {
  const digests = {};
  for (const table of ALL_TABLES) {
    if (NEVER_SEEDED.has(table)) continue;
    const scope = table === "tenants" ? "id" : "tenant_id";
    const { rows } = await client.query(
      `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '(empty)') AS digest
         FROM osa.${table} t WHERE ${scope} = ANY($1::uuid[])`,
      [seedTenantIds],
    );
    digests[table] = String(rows[0].digest).slice(0, 12);
  }
  return digests;
}

/* ---------------------------------------------------------------------------
 * The load
 * ------------------------------------------------------------------------- */

async function loadSeed(client, db) {
  const ofTenant = (rows, tenantId) => rows.filter((row) => row.tenantId === tenantId);
  const courseIdOfEnrollment = new Map(db.enrollments.map((enrollment) => [enrollment.id, enrollment.courseId]));
  const summary = new Map(ALL_TABLES.map((table) => [table, { attempted: 0, inserted: 0 }]));

  const record = (table, result) => {
    const running = summary.get(table);
    running.attempted += result.attempted;
    running.inserted += result.inserted;
  };

  // osa.tenants is the one table in the schema with no RLS policy — that
  // omission is what makes tenant-first login possible — so it is written
  // before any tenant context exists.
  record("tenants", await insertRows(client, "tenants", db.tenants.map(fromTenant)));

  for (const tenant of db.tenants) {
    const tenantId = tenant.id;
    const users = ofTenant(db.users, tenantId);

    // `job_roles.recorded_by` and `requirements.recorded_by` are NOT NULL with a
    // foreign key to osa.users, and the domain type has no author field at all
    // (README-migration.md §3). The tenant administrator is the least wrong
    // answer available and the choice is made here, once, rather than hidden in
    // the mapping.
    const author = users.find((user) => user.roles.includes("tenant_admin")) ?? users[0];
    if (!author) throw new Error(`Tenant ${tenant.slug} seeds no users; job_roles.recorded_by has no possible value.`);

    // FORCE ROW LEVEL SECURITY applies to the table owner too, so the context is
    // set even though the migration role may hold BYPASSRLS. set_config(..., true)
    // is the parameterisable form of SET LOCAL; it is reverted at COMMIT.
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
      toStorageId(tenantId),
      toStorageId(author.id),
    ]);

    // org_units.parent_id is a self-reference: shallowest path first.
    const orgUnits = ofTenant(db.orgUnits, tenantId)
      .slice()
      .sort((a, b) => a.path.split("/").filter(Boolean).length - b.path.split("/").filter(Boolean).length);

    record("org_units", await insertRows(client, "org_units", orgUnits.map(fromOrgUnit)));
    record("users", await insertRows(client, "users", users.map(fromUser)));
    record("user_roles", await insertRows(client, "user_roles", users.flatMap(fromUserRoles)));
    record("skills", await insertRows(client, "skills", ofTenant(db.skills, tenantId).map(fromSkill)));
    record("job_roles", await insertRows(client, "job_roles",
      ofTenant(db.jobRoles, tenantId).map((role) => fromJobRole(role, author.id))));
    record("requirements", await insertRows(client, "requirements",
      ofTenant(db.requirements, tenantId).map((requirement) => fromRequirement(requirement, author.id))));

    const studies = ofTenant(db.tnaStudies, tenantId);
    record("tna_studies", await insertRows(client, "tna_studies", studies.map(fromStudy)));
    record("tna_target_roles", await insertRows(client, "tna_target_roles", studies.flatMap(fromStudyTargetRoles)));

    record("evidence", await insertRows(client, "evidence", ofTenant(db.evidence, tenantId).map(fromEvidence)));
    record("gap_cases", await insertRows(client, "gap_cases", ofTenant(db.gapCases, tenantId).map(fromGapCase)));
    record("interventions", await insertRows(client, "interventions", ofTenant(db.interventions, tenantId).map(fromIntervention)));

    record("courses", await insertRows(client, "courses", ofTenant(db.courses, tenantId).map(fromCourse)));
    record("course_modules", await insertRows(client, "course_modules", ofTenant(db.courseModules, tenantId).map(fromCourseModule)));
    record("enrollments", await insertRows(client, "enrollments", ofTenant(db.enrollments, tenantId).map(fromEnrollment)));
    record("module_completions", await insertRows(client, "module_completions",
      ofTenant(db.moduleCompletions, tenantId).map((completion) => {
        const courseId = courseIdOfEnrollment.get(completion.enrollmentId);
        if (!courseId) throw new Error(`Module completion ${completion.id} names an enrollment the seed does not contain.`);
        return fromModuleCompletion(completion, courseId);
      })));

    const signals = ofTenant(db.signals, tenantId);
    record("signals", await insertRows(client, "signals", signals.map(fromSignal)));
    record("signal_job_roles", await insertRows(client, "signal_job_roles", signals.flatMap(fromSignalJobRoles)));
    record("signal_skills", await insertRows(client, "signal_skills", signals.flatMap(fromSignalSkills)));

    record("notifications", await insertRows(client, "notifications", ofTenant(db.notifications, tenantId).map(fromNotification)));
  }

  return summary;
}

/* ---------------------------------------------------------------------------
 * Verification, as the runtime role
 * ------------------------------------------------------------------------- */

async function verifyAsRuntimeRole(pg, connectionString, db) {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  try {
    const report = await inspectRuntimeRole(client);
    assertRuntimeRoleIsSafe(report);
    console.log(`  connected as ${report.role} — bypassRls=${report.bypassRls} superuser=${report.superuser} ownedTables=${report.ownedTables}`);

    const northstar = db.tenants.find((tenant) => tenant.slug === "northstar");
    const gulf = db.tenants.find((tenant) => tenant.slug === "gulf-energy");

    // osa.tenants carries no RLS by design, so the directory is readable before
    // any tenant context is set. That is exactly what login depends on.
    const directory = await client.query(
      "SELECT slug, name FROM osa.tenants WHERE slug = ANY($1::text[]) ORDER BY slug",
      [[northstar.slug, gulf.slug]],
    );
    check("both seeded tenants are visible to the runtime role", directory.rows.map((row) => row.slug), ["gulf-energy", "northstar"]);

    let totalUsers = 0;
    for (const tenant of [northstar, gulf]) {
      const tenantId = toStorageId(tenant.id);
      const seedUsers = db.users.filter((user) => user.tenantId === tenant.id);
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        tenantId,
        toStorageId(seedUsers[0].id),
      ]);

      console.log(`\n  -- tenant ${tenant.slug} --`);

      // Under RLS the runtime role sees this tenant's users and no others. A
      // count equal to the whole seed would mean the policies are not applying.
      const users = await client.query("SELECT count(*)::int AS n FROM osa.users");
      check(`${tenant.slug}: users visible under RLS`, users.rows[0].n, seedUsers.length);
      totalUsers += users.rows[0].n;

      // The point of the exercise: a seeded hash that verifyPassword still
      // accepts. A re-derived or normalised hash would leave nobody able to
      // sign in, which is the state this script exists to end.
      const admin = seedUsers.find((user) => user.roles.includes("tenant_admin"));
      const stored = await client.query(
        `SELECT u.password_hash,
                coalesce((SELECT array_agg(r.role_code ORDER BY r.role_code) FROM osa.user_roles r
                           WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id), '{}') AS roles,
                (SELECT o.path::text FROM osa.org_units o WHERE o.tenant_id = u.tenant_id AND o.id = u.org_unit_id) AS org_path
           FROM osa.users u WHERE u.email = $1`,
        [admin.email],
      );
      check(`${tenant.slug}: ${admin.email} password verifies against the seeded scrypt hash`,
        stored.rowCount === 1 && verifyPassword(DEMO_PASSWORD, stored.rows[0].password_hash), true);
      check(`${tenant.slug}: roles round-trip through osa.user_roles`,
        [...stored.rows[0].roles].sort(), [...admin.roles].sort());

      // `/org_ns/org_ns_ops` was stored as `<uuid>.<uuid>`; the stored label
      // path must be exactly what pathToLtree produces, and ltreeToPath must
      // invert it. A `/`-separated value would not have been storable at all.
      const expectedPath = db.orgUnits.find((unit) => unit.id === admin.orgUnitId).path;
      check(`${tenant.slug}: org unit path is stored as ltree`, stored.rows[0].org_path, pathToLtree(expectedPath));
      check(`${tenant.slug}: ltreeToPath inverts it`,
        ltreeToPath(stored.rows[0].org_path).split("/").filter(Boolean).length, expectedPath.split("/").filter(Boolean).length);

      await client.query("COMMIT");
    }
    check("6 users across both tenants", totalUsers, db.users.length);

    // ---- Northstar detail -------------------------------------------------
    const tenantId = toStorageId(northstar.id);
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
      tenantId,
      toStorageId(db.users.find((user) => user.tenantId === northstar.id).id),
    ]);
    console.log("\n  -- northstar detail --");

    const courses = await client.query(
      `SELECT c.code, c.title, c.status, c.evidence_rule,
              c.passing_score::float8 AS passing_score, c.validity_months, c.target_level,
              (SELECT count(*)::int FROM osa.course_modules m
                WHERE m.tenant_id = c.tenant_id AND m.course_id = c.id) AS modules
         FROM osa.courses c WHERE c.code = ANY($1::text[]) ORDER BY c.code`,
      [["BRIEF-STORM", "DIAG-210", "LOTO-401"]],
    );
    const expectedCourses = ["crs_storm", "crs_diag", "crs_loto"]
      .map((id) => db.courses.find((course) => course.id === id))
      .map((course) => ({
        code: course.code, status: course.status, evidence_rule: course.evidenceRule,
        passing_score: course.passingScore, validity_months: course.validityMonths,
        target_level: course.targetLevel,
        modules: db.courseModules.filter((module) => module.courseId === course.id).length,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    check("LOTO / DIAG / BRIEF courses and their module counts",
      courses.rows.map((row) => ({
        code: row.code, status: row.status, evidence_rule: row.evidence_rule,
        passing_score: row.passing_score, validity_months: row.validity_months,
        target_level: row.target_level, modules: row.modules,
      })), expectedCourses);
    console.log(renderTable(
      ["course", "status", "rule", "pass", "months", "level", "modules"],
      courses.rows.map((row) => [row.code, row.status, row.evidence_rule, row.passing_score, row.validity_months ?? "null", row.target_level, row.modules]),
    ));

    const modules = await client.query(
      `SELECT m.position, m.title, m.kind, m.duration_minutes, m.required
         FROM osa.course_modules m JOIN osa.courses c ON c.tenant_id = m.tenant_id AND c.id = m.course_id
        WHERE c.code = 'LOTO-401' ORDER BY m.position`,
    );
    check("LOTO-401 modules are in presentation order",
      modules.rows.map((row) => [row.position, row.kind]),
      db.courseModules.filter((module) => module.courseId === "crs_loto").map((module) => [module.position, module.kind]));

    // `gap` is GENERATED ALWAYS AS (greatest(required_level - evidenced_level, 0))
    // STORED, so the value read back was computed by PostgreSQL, never inserted.
    const gaps = await client.query(
      `SELECT g.required_level, g.evidenced_level, g.gap, g.priority, g.status, r.source_reference
         FROM osa.gap_cases g JOIN osa.requirements r ON r.tenant_id = g.tenant_id AND r.id = g.requirement_id
        ORDER BY g.gap DESC, g.priority DESC`,
    );
    const expectedGaps = db.gapCases
      .filter((gapCase) => gapCase.tenantId === northstar.id)
      .map((gapCase) => ({
        required_level: gapCase.requiredLevel, evidenced_level: gapCase.evidencedLevel,
        gap: gapCase.gap, priority: gapCase.priority, status: gapCase.status,
      }))
      .sort((a, b) => b.gap - a.gap);
    check("2 gap cases, with `gap` recomputed by the generated column to the seed's value",
      gaps.rows.map((row) => ({
        required_level: row.required_level, evidenced_level: row.evidenced_level,
        gap: row.gap, priority: row.priority, status: row.status,
      })), expectedGaps);
    console.log(renderTable(
      ["gap case (requirement)", "required", "evidenced", "gap (generated)", "priority", "status"],
      gaps.rows.map((row) => [row.source_reference, row.required_level, row.evidenced_level, row.gap, row.priority, row.status]),
    ));

    const signals = await client.query(
      `SELECT s.source_reference, s.severity, s.status,
              (SELECT count(*)::int FROM osa.signal_job_roles j WHERE j.tenant_id = s.tenant_id AND j.signal_id = s.id) AS job_roles,
              (SELECT count(*)::int FROM osa.signal_skills k WHERE k.tenant_id = s.tenant_id AND k.signal_id = s.id) AS skills
         FROM osa.signals s ORDER BY s.severity DESC, s.detected_at DESC`,
    );
    const seedSignals = db.signals.filter((signal) => signal.tenantId === northstar.id);
    check("5 Northstar signals", signals.rows.length, seedSignals.length);
    check("signal job-role / skill junctions match the seed arrays",
      signals.rows.map((row) => [row.source_reference, row.job_roles, row.skills]).sort(),
      seedSignals.map((signal) => [signal.sourceReference, signal.affectedJobRoleIds.length, signal.affectedSkillIds.length]).sort());
    console.log(renderTable(
      ["signal", "severity", "status", "job roles", "skills"],
      signals.rows.map((row) => [row.source_reference, row.severity, row.status, row.job_roles, row.skills]),
    ));

    // numeric(4,3) comes back as a string unless cast; the adapter casts to
    // float8 everywhere, so the seeded value must survive that cast intact.
    const evidence = await client.query(
      "SELECT source_reference, strength::float8 AS strength, strength AS raw, expires_at, observed_at FROM osa.evidence ORDER BY source_reference",
    );
    check("evidence.strength survives numeric(4,3) as a float",
      evidence.rows.map((row) => row.strength).sort(),
      db.evidence.filter((item) => item.tenantId === northstar.id).map((item) => item.strength).sort());
    check("evidence.strength is a STRING without the ::float8 cast (README §2.6)",
      evidence.rows.every((row) => typeof row.raw === "string"), true);

    // date columns are selected as ::text; parsed as a Date they lose a day
    // west of UTC (README §2.7).
    const study = await client.query(
      "SELECT due_date::text AS due_date_text, title FROM osa.tna_studies",
    );
    check("tna_studies.due_date reads back as the calendar date the seed wrote",
      study.rows[0].due_date_text, db.tnaStudies[0].dueDate);

    const enrollments = await client.query(
      `SELECT e.status, e.source, e.due_date::text AS due_date, c.code,
              (SELECT count(*)::int FROM osa.module_completions mc
                WHERE mc.tenant_id = e.tenant_id AND mc.enrollment_id = e.id) AS completed_modules
         FROM osa.enrollments e JOIN osa.courses c ON c.tenant_id = e.tenant_id AND c.id = e.course_id
        ORDER BY c.code`,
    );
    check("enrollments with their module completions",
      enrollments.rows.map((row) => [row.code, row.status, row.source, row.due_date, row.completed_modules]),
      db.enrollments
        .map((enrollment) => [
          db.courses.find((course) => course.id === enrollment.courseId).code,
          enrollment.status, enrollment.source, enrollment.dueDate,
          db.moduleCompletions.filter((completion) => completion.enrollmentId === enrollment.id).length,
        ])
        .sort((a, b) => a[0].localeCompare(b[0])));

    await client.query("COMMIT");

    // The runtime role must NOT be able to see the other tenant's rows.
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [toStorageId(gulf.id)]);
    const leak = await client.query("SELECT count(*)::int AS n FROM osa.signals WHERE source_reference = 'CAPA-2026-017'");
    check("RLS: a Northstar signal is invisible inside the Gulf tenant context", leak.rows[0].n, 0);
    await client.query("COMMIT");
  } finally {
    client.release();
    await pool.end();
  }
}

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

async function main() {
  loadEnvFile(path.join(REPO_ROOT, ".env.local"));

  const pg = await loadPgModule();
  if (!pg) throw new Error("The `pg` driver could not be loaded. Run `npm install`.");

  const db = seedDatabase();
  const seedTenantIds = db.tenants.map((tenant) => toStorageId(tenant.id));
  const connectionString = adminConnectionString();

  heading("iK OSA — PostgreSQL demo dataset provisioning");
  console.log(`  admin connection : ${describeConnection(connectionString)}`);
  console.log(`  seed tenants     : ${db.tenants.map((tenant) => tenant.slug).join(", ")}`);

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  let before;
  let after;
  let digestBefore;
  let digestAfter;
  let summary;

  try {
    const role = await inspectRuntimeRole(client);
    console.log(`  running as       : ${role.role} (bypassRls=${role.bypassRls}, superuser=${role.superuser}, ownsTables=${role.ownedTables})`);

    const schema = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'osa'",
    );
    if (schema.rows[0].n !== ALL_TABLES.length) {
      throw new Error(
        `Schema osa has ${schema.rows[0].n} tables; expected ${ALL_TABLES.length}. Apply 001_initial.sql and 002_learning_and_signals.sql first.`,
      );
    }

    before = await tableCounts(client, seedTenantIds);
    digestBefore = await seedDigest(client, seedTenantIds);

    // One transaction. A failure at any statement leaves the database exactly
    // as it was, so a half-loaded demo is not a state that can be reached.
    await client.query("BEGIN");
    // Bare calendar dates bound to timestamptz columns resolve against the
    // session TimeZone; pinning it to UTC makes the load byte-identical
    // wherever it runs, which is what makes re-running it a no-op.
    await client.query("SET LOCAL TimeZone = 'UTC'");
    summary = await loadSeed(client, db);
    await client.query("COMMIT");

    after = await tableCounts(client, seedTenantIds);
    digestAfter = await seedDigest(client, seedTenantIds);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  heading("Rows loaded");
  console.log(renderTable(
    ["table", "before", "attempted", "inserted", "after", "delta", "seed rows", "digest"],
    ALL_TABLES.map((table) => {
      const attempt = summary.get(table);
      const delta = after[table].total - before[table].total;
      return [
        table, before[table].total, attempt.attempted, attempt.inserted, after[table].total,
        delta === 0 ? "0" : `+${delta}`, after[table].seeded, digestAfter[table] ?? "(not seeded)",
      ];
    }),
  ));

  heading("Idempotence");
  const changedDigests = ALL_TABLES.filter((table) => digestBefore[table] !== undefined && digestBefore[table] !== digestAfter[table]);
  const insertedTotal = ALL_TABLES.reduce((sum, table) => sum + summary.get(table).inserted, 0);
  if (insertedTotal === 0) {
    check("this run inserted no rows (the dataset was already present)", insertedTotal, 0);
    check("no seeded row changed content", changedDigests, []);
  } else {
    console.log(`  first load: ${insertedTotal} rows inserted across ${ALL_TABLES.filter((t) => summary.get(t).inserted > 0).length} tables.`);
    console.log("  Run this script again; the second run must report 0 inserted and identical digests.");
  }
  for (const table of NEVER_SEEDED) {
    check(`${table} untouched by the load (${table === "sessions" ? "hashed id/csrf, unseedable" : "per-tenant HMAC chain, unbackfillable"})`,
      after[table].total - before[table].total, 0);
  }

  heading("Verification — as the RUNTIME role, under RLS");
  const runtimeUrl = runtimeConnectionString();
  if (!runtimeUrl) {
    failures.push(`No runtime connection string: set IK_RUNTIME_DATABASE_URL or place one at ${RUNTIME_URL_FILE}.`);
    console.log(`  SKIPPED — no runtime credential at ${RUNTIME_URL_FILE} and IK_RUNTIME_DATABASE_URL is unset.`);
  } else {
    console.log(`  runtime connection: ${describeConnection(runtimeUrl)}`);
    await verifyAsRuntimeRole(pg, runtimeUrl, db);
  }

  heading("Result");
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL  ${failure}`);
    console.error(`\n  ${failures.length} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("  All checks passed. The demo tenants are signed-in-able.");
  console.log(`  Sign in at /login as admin@northstar.example or admin@gulf.example (password: ${DEMO_PASSWORD}).`);
}

main().catch((error) => {
  console.error(`\nProvisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split("\n").slice(1, 6).join("\n"));
  process.exitCode = 1;
});
