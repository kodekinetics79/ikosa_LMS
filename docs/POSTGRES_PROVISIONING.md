# Provisioning the demo dataset into PostgreSQL

`database/postgres/001_initial.sql` and `002_learning_and_signals.sql` create 22
tables and not one row. A freshly migrated database therefore has no tenants,
which means `POST /api/auth/login` has no slug to resolve and **nobody can sign
in**. `scripts/provision-postgres.mjs` is the step that closes that gap, and it
is the only thing in this repository that writes seed data to PostgreSQL.

It is idempotent: running it twice inserts nothing the second time and changes
no row it inserted the first time. That is asserted by the script itself, not
assumed — see [Idempotence](#idempotence).

---

## Running it

```bash
node --import tsx scripts/provision-postgres.mjs
```

`tsx` is required because the script imports `src/lib/server/seed.ts` directly
rather than duplicating its fixtures; there is no build step and no second copy
of the demo data to drift.

### Credentials

Nothing is hard-coded and nothing is printed. Connection strings are read, in
this order:

| Purpose | Source |
|---|---|
| Loading (admin) | `IK_ADMIN_DATABASE_URL`, else `DATABASE_URL_UNPOOLED`, else `POSTGRES_URL_NON_POOLING` |
| Verifying (runtime) | `IK_RUNTIME_DATABASE_URL`, else the file at `IK_RUNTIME_URL_FILE` (default `/tmp/ik-runtime-url`) |

If none of those are set in the environment, the script reads `.env.local` from
the repository root — a real environment variable always wins over the file. The
only thing it ever echoes about a connection is `user@host/database`; the
password is stripped by `describeConnection()`.

The **unpooled** URL is used deliberately. The whole load is one transaction and
wants one session; a pooler is free to hand successive statements to different
backends, and `SET LOCAL`/`set_config(..., true)` is per-session state.

### Prerequisites

* Both migrations applied — the script refuses to run unless `information_schema`
  reports exactly 22 tables in schema `osa`.
* The runtime role provisioned (`ik_osa_app`, or whatever
  `SET osa.runtime_role` named), with `002`'s grant section applied to it.
  Without it the load still succeeds but verification is reported as a failure,
  because an unverified load is not a finished one.

---

## What it does

### Source of truth

`seedDatabase()` in `src/lib/server/seed.ts`, imported. It returns the whole
`Database` object; the script consumes every collection on it. Translation to
storage form goes through the two existing modules plus one new one:

* `src/lib/server/db/ids.ts` — `toStorageId` (uuid v5 over the legacy id, so
  `ten_northstar` always becomes the same uuid), `pathToLtree`, `pathsToLtree`.
* `src/lib/server/db/write-mapping.ts` — **new**: the write direction of
  `mapping.ts`. One function per entity, each returning a column→value object.
  It is a mirror, so every divergence `mapping.ts` undoes on the way out is
  visible next to the code that creates it on the way in.
* `src/lib/server/db/driver.ts` — `loadPgModule`, `inspectRuntimeRole`,
  `assertRuntimeRoleIsSafe`, reused rather than reimplemented.

Nothing under `src/app/**` imports any of this, and `write-mapping.ts` has
exactly one consumer: this script.

### Which role it connects as, and why

**The migration role**, with `app.tenant_id` and `app.user_id` set anyway.

The runtime role cannot do this job. `002`'s grant matrix gives `ik_osa_app`
`SELECT` and nothing else on `osa.tenants` — creating a tenant is not something
a request should be able to do — so a load running as the runtime role fails at
the very first statement. Provisioning is an operator action and belongs to the
operator's role.

The tenant context is still set before each tenant's statements, via
`set_config('app.tenant_id', $1, true)`. Every tenant table is `FORCE ROW LEVEL
SECURITY`, which filters the table owner too, so a migration role *without*
`BYPASSRLS` is filtered exactly like the application. Setting the context makes
the script correct under either kind of role rather than only under the
privileged one. (On the Neon database this was run against, `neondb_owner` does
hold `BYPASSRLS`, so the context is belt and braces there — but it is the belt
on a self-hosted deployment where the migration user is an ordinary owner.)

`osa.tenants` is written first, before any context exists. It is the one table
in the schema carrying no RLS policy, and that omission is exactly what makes
tenant-first login possible.

### Transaction and conflict handling

The whole load is **one transaction**. A failure at any statement leaves the
database as it was; a half-loaded demo is not a reachable state.

`SET LOCAL TimeZone = 'UTC'` is issued inside it. Several domain fields typed
`string` hold bare calendar dates that land in `timestamptz` columns; bound
uninterpreted, they resolve against the session's TimeZone, and the same script
would write different rows on different machines. `write-mapping.ts::utcInstant`
anchors them at UTC midnight and the `SET LOCAL` covers anything it misses.

Every insert carries `ON CONFLICT (id) DO NOTHING`, or a bare `ON CONFLICT DO
NOTHING` for the four junction tables whose primary key is composite. Not an
upsert: `DO UPDATE` would rewrite `users.password_hash` on every run, because
`hashPassword` salts randomly and `seedDatabase()` returns a different hash each
time it is called. `DO NOTHING` keeps the first-inserted hash — which is why the
second run changes nothing, and why the demo password keeps working.

Choosing `(id)` rather than a bare clause on the id-keyed tables is deliberate:
a real collision on `(tenant_id, code, version)`, `(tenant_id, email)` or
`(tenant_id, path)` still raises, instead of being silently swallowed.

### Insert order

Tenants first, then per tenant, in dependency order:

```text
org_units (shallowest path first — parent_id is a self-reference)
users -> user_roles -> skills -> job_roles -> requirements
tna_studies -> tna_target_roles
evidence -> gap_cases -> interventions
courses -> course_modules -> enrollments -> module_completions
signals -> signal_job_roles -> signal_skills
notifications
```

Every foreign key between tenant tables is composite on `(tenant_id, <id>)`, so
there are no cross-tenant dependencies and tenants can be loaded one at a time.

---

## What it deliberately does not do

### No audit backfill

`osa.audit_events` is never written. The ledger is a per-tenant HMAC chain, and
the digest covers each event's **own id** (`README-migration.md` §2.4). A row
minted by a backfill cannot be signed by anything that would later recompute the
same hash from the row's contents, so seeded history reports `hash_mismatch` on
data nobody tampered with — the ledger failing its own verification on the first
read is strictly worse than an empty ledger.

The chain starts empty and grows from real activity. The script asserts the
audit row count is unchanged by the load.

### No sessions

`osa.sessions` keys on `id_hash bytea` and stores `csrf_hash bytea`, while
`Session.id` and `Session.csrfToken` are plaintext in the JSON store
(`README-migration.md` §2.8). A hash cannot be handed back to a browser, so a
seeded session is a row no cookie could ever present. `seedDatabase()` returns
no sessions and the script writes none. Sign in instead.

### No notifications

`seedDatabase()` returns none, and the script would write them if it did.
Notifications are **derived** by `sweepNotifications()` from the state this
script loads — pre-writing them would put rows on file that no condition raised,
and the sweep would then have to reconcile against fiction.

### No generated columns, no invented values

`gap_cases.gap` is `GENERATED ALWAYS AS (greatest(required_level -
evidenced_level, 0)) STORED`. `fromGapCase()` omits it; PostgreSQL computes it.
The seed's own `gap` value is used only as the expected result in verification.

`skills.status`, `skills.version`, `courses.valid_from`/`valid_to`,
`org_units.created_at` and the other columns with no domain source are left to
their column DEFAULTs rather than assigned a made-up value.

Two columns cannot be: `job_roles.recorded_by` and `requirements.recorded_by`
are `NOT NULL` with a foreign key to `osa.users`, and the domain type has no
author field at all (`README-migration.md` §3). The script uses that tenant's
`tenant_admin`, and it makes the choice visibly in `loadSeed()` rather than
burying it in the mapping. `courses.recorded_by`, which `002` deliberately
declares nullable for this reason, is left NULL.

---

## Verification

Everything the load claims is re-checked over a **second connection opened as
the runtime role** (`ik_osa_app`), because proving the data is readable by the
migration role proves nothing about whether the application can see it. The
script calls `inspectRuntimeRole` + `assertRuntimeRoleIsSafe` from
`driver.ts` first, so the report states `bypassRls=false superuser=false
ownedTables=0` before any assertion is made against it.

Asserted, with tenant context set from the seed's own values:

* both seeded tenants resolve from `osa.tenants` (no RLS — this is what login
  depends on);
* 5 Northstar + 1 Gulf users visible under RLS, 6 total, and *only* this
  tenant's users inside a tenant context;
* each tenant admin's `password_hash` still satisfies
  `security.ts::verifyPassword("Demo!2026", …)`;
* roles round-trip through `osa.user_roles`; org paths round-trip through
  `ltree`;
* `LOTO-401` / `DIAG-210` / `BRIEF-STORM` with their module counts (4 / 2 / 1),
  status, evidence rule, passing score and validity, plus `LOTO-401`'s modules
  in presentation order;
* the two gap cases, with the **generated** `gap` equal to the seed's 2 and 1;
* 5 Northstar signals and their job-role / skill junction rows;
* `evidence.strength` intact through `numeric(4,3)` — and that it comes back as
  a *string* without the `::float8` cast, which is why the adapter casts;
* `tna_studies.due_date` reads back as the calendar date written, via `::text`;
* enrollments with their module-completion counts;
* a Northstar signal is invisible from inside the Gulf tenant context.

A failed check sets a non-zero exit code.

---

## Idempotence

The script counts every one of the 22 tables before and after the load, and also
computes an md5 over `row::text` of the seeded rows of each table. Counts prove
no row was **added**; the digest proves no row was **changed** — an upsert that
rewrote a column would move the digest while the count held.

First run:

```text
  table               before  attempted  inserted  after  delta  seed rows        digest
  ------------------  ------  ---------  --------  -----  -----  ---------  ------------
  tenants                  8          2         2     10     +2          2  8bb8536c838e
  org_units                8          4         4     12     +4          4  d2651aa7f84f
  users                    8          6         6     14     +6          6  82b533297250
  user_roles               0          7         7      7     +7          7  4e43e46d0acf
  sessions                 0          0         0      0      0          0  (not seeded)
  skills                   0          3         3      3     +3          3  dec885f59dc7
  job_roles                0          2         2      2     +2          2  a7a7000d1fb4
  requirements             0          3         3      3     +3          3  674ba2de3ebd
  tna_studies              0          1         1      1     +1          1  acdcd4d3814c
  tna_target_roles         0          1         1      1     +1          1  5a195acbab85
  evidence                 0          2         2      2     +2          2  6f8b24535530
  gap_cases                0          2         2      2     +2          2  bbab5e3716a7
  interventions            0          3         3      3     +3          3  cd53759339fd
  courses                  0          4         4      4     +4          4  a35bbd07e427
  course_modules           0          9         9      9     +9          9  3595119ef81a
  enrollments              0          2         2      2     +2          2  9a9c0bf2ed7d
  module_completions       0          2         2      2     +2          2  0a0f00ffb597
  signals                  0          6         6      6     +6          6  c402e6cf1074
  signal_job_roles         0          5         5      5     +5          5  ce5adfddbb55
  signal_skills            0          6         6      6     +6          6  5e4ab801a503
  notifications            0          0         0      0      0          0       (empty)
  audit_events             6          0         0      6      0          0  (not seeded)
```

70 rows across 19 tables. (The non-zero `before` on `tenants`, `org_units`,
`users` and `audit_events` is the throwaway `rls-alpha-…` / `rls-beta-…`
fixtures left behind by `tests/integration/postgres-repository.test.mjs`, which
is why the table carries a separate **seed rows** column.)

Second run, same command:

```text
  tenants                 10          2         0     10      0          2  8bb8536c838e
  org_units               12          4         0     12      0          4  d2651aa7f84f
  users                   14          6         0     14      0          6  82b533297250
  …
  signal_skills            6          6         0      6      0          6  5e4ab801a503

Idempotence
===========
  ok    this run inserted no rows (the dataset was already present)
  ok    no seeded row changed content
  ok    sessions untouched by the load (hashed id/csrf, unseedable)
  ok    audit_events untouched by the load (per-tenant HMAC chain, unbackfillable)
```

Every digest is byte-identical to the first run's.

---

## Resetting

There is no `--reset` flag, on purpose: a script that can erase a tenant's
evidence is a script that will eventually erase a tenant's evidence, and the
runtime role has no `DELETE` on those tables for the same reason.

To start over, delete the seeded rows by hand as the **migration** role, in
reverse dependency order. `osa.audit_events` has a `BEFORE UPDATE OR DELETE`
trigger that refuses deletion outright, so any audit rows the demo generated
must be dropped with the table or left in place — a chain that has lost its
middle no longer verifies, so leaving it is usually the right answer.

Two cautions before running it:

* If the migration role does **not** hold `BYPASSRLS`, every table below is
  `FORCE ROW LEVEL SECURITY` and each `DELETE` will silently match zero rows.
  Run it one tenant at a time with
  `SELECT set_config('app.tenant_id', '<tenant uuid>', true);` first, exactly as
  the provisioning script does on the way in.
* The block below was validated by parsing and planning every statement against
  the live schema (`PREPARE`, no execution) rather than by running it — the demo
  data it would erase is the data this work exists to load.

```bash
psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
-- The seed's tenants, by the uuid v5 derivation of their legacy ids.
CREATE TEMP TABLE seed_tenants(id uuid);
INSERT INTO seed_tenants
SELECT id FROM osa.tenants WHERE slug IN ('northstar','gulf-energy');

DELETE FROM osa.notifications       WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.signal_skills       WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.signal_job_roles    WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.signals             WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.module_completions  WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.enrollments         WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.course_modules      WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.courses             WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.interventions       WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.gap_cases           WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.evidence            WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.tna_target_roles    WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.tna_studies         WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.requirements        WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.job_roles           WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.skills              WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.sessions            WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.user_roles          WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.users               WHERE tenant_id IN (SELECT id FROM seed_tenants);
DELETE FROM osa.org_units           WHERE tenant_id IN (SELECT id FROM seed_tenants);
-- Fails if audit events reference these tenants. That is the trigger working.
DELETE FROM osa.tenants             WHERE id IN (SELECT id FROM seed_tenants);
COMMIT;
SQL
```

Then run the provisioning script again. Because ids are uuid v5 derivations of
the legacy string ids, the reloaded rows carry the **same** uuids as before, so
a bookmarked `/studies/<uuid>` still resolves.

A full teardown — dropping everything `002` created and re-applying both
migrations — is documented in `database/postgres/README-migration.md`,
"Rollback".

---

## Known noise

node-postgres prints a deprecation warning for `sslmode=require` in the Neon
connection string ("treated as an alias for `verify-full`"). It comes from
`pg-connection-string`, affects every consumer of these URLs equally, and is not
something this script sets.

---

## Divergences this script had to handle

Each is documented at length in `database/postgres/README-migration.md`; this is
the subset that a bulk load runs into, with what was done.

| # | Divergence | Handling |
|---|---|---|
| §2.1 | ids are `uuid`; the seed uses `ten_northstar` | `toStorageId` — uuid v5, deterministic, so re-runs collide with themselves |
| §2.2 | `org_units.path` is `ltree`; the domain uses `/a/b` | `pathToLtree`, also for `users.delegated_org_paths ltree[]` |
| §2.5 | `gap_cases.gap` is `GENERATED ALWAYS … STORED` | never emitted; verified against the seed's value after the database computes it |
| §2.6 | `numeric` returns a string | irrelevant on write (a JS number binds fine); verified on read both ways |
| §2.7 | `date` drifts a day parsed at local midnight | calendar dates stay text in both directions; read back with `::text` |
| §2.8 | `sessions` store hashed id/csrf | none seeded |
| §2.9 | `Course.status: "published"` is not in `osa.record_status` | none needed — `002` types it as a CHECK, not that enum, for exactly this reason |
| §2.4 | audit ids are part of the signature | no audit backfill |
| §3 | `job_roles.recorded_by` / `requirements.recorded_by` `NOT NULL`, no domain source | that tenant's `tenant_admin` |
| §3 | `skills.scale` is `scale_code`; `status`/`version` have no domain source | renamed; left to DEFAULT |
| — | bare calendar dates bound to `timestamptz` (`effectiveFrom`, `Signal.effectiveAt`) | anchored at UTC midnight; `SET LOCAL TimeZone = 'UTC'` |
| — | `hashPassword` salts randomly, so `seedDatabase()` is not referentially transparent | `ON CONFLICT DO NOTHING`, never `DO UPDATE` |

**No enum or CHECK value in the seed failed to fit.** Every `status`, `kind`,
`type`, `source`, `criticality`, `severity`, `evidence_rule` and `role_code`
value was checked against the constraint or enum type in the schema, including
the one the migration README flags as a trap — `Course.status: "published"`,
which is not a member of `osa.record_status` and does not have to be, because
`002` declares `courses.status` as a text CHECK.
