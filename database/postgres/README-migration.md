# PostgreSQL migration — schema/code gap audit and operations

`001_initial.sql` has never been connected to anything. It is a good schema, and
the TypeScript `Database` type in `src/lib/server/domain.ts` has moved since it
was written. This document records exactly where the two disagree, what
`002_learning_and_signals.sql` does about it, and what still has to change in
files this work did not touch.

Nothing here is speculative. Every error message quoted below was produced
against PostgreSQL 16.4 — the version `compose.infrastructure.yaml` pins.

---

## 1. Coverage

The TypeScript `Database` type has 18 collections. `001_initial.sql` creates 14
tables covering 12 of them (`users` splits into `users` + `user_roles`,
`tnaStudies` into `tna_studies` + `tna_target_roles`).

| TypeScript collection | Table | Status |
|---|---|---|
| `tenants` … `interventions`, `auditEvents` | 14 tables in `001` | present |
| `courses` | `osa.courses` | **added by 002** |
| `courseModules` | `osa.course_modules` | **added by 002** |
| `enrollments` | `osa.enrollments` | **added by 002** |
| `moduleCompletions` | `osa.module_completions` | **added by 002** |
| `signals` | `osa.signals` + `osa.signal_job_roles` + `osa.signal_skills` | **added by 002** |
| `notifications` | `osa.notifications` | **added by 002** |

The two signal junction tables follow the precedent `001` set by normalising
`TnaStudy.targetRoleIds` into `osa.tna_target_roles`: an array column cannot
carry a tenant-qualified foreign key, so an array is a place where a
cross-tenant identifier can hide.

---

## 2. Type-level divergences

These are not stylistic. Each one makes a literal port fail at the first
statement.

### 2.1 Identifiers: `uuid` columns vs prefixed strings

Every id column in `001` is `uuid`. `security.ts::id()` produces
`"<prefix>_<24 hex>"`, and `seed.ts` uses hand-written literals
(`ten_northstar`, `usr_learner`, `org_ns_ops`).

```
ik_osa=# select 'ten_northstar'::uuid;
ERROR:  invalid input syntax for type uuid: "ten_northstar"
```

**Resolution.** `src/lib/server/db/ids.ts` derives a uuid from a legacy id with
RFC 4122 version 5 (SHA-1) under a fixed namespace. Deterministic, so the
backfill is re-runnable after a rollback and a bookmarked
`/studies/tna_field_2026` still resolves without a lookup table. Ids minted
after cutover are ordinary random uuids.

**Still required (existing file):** `security.ts::id()` must return
`randomUUID()`. Until it does, the adapter is the only thing minting
identifiers PostgreSQL accepts. See §5.

### 2.2 `org_units.path` is `ltree`; the domain uses `/a/b`

```
ik_osa=# select '/org_ns/org_ns_ops'::ltree;
ERROR:  ltree syntax error at character 1
```

ltree separates labels with `.` and has no leading separator. This is worth
fixing rather than abandoning: `isOrgInScope()`'s `path.startsWith(scope + "/")`
is a linear string test no index can serve, whereas `path <@ scope` is a GiST
lookup on the `org_units_path_gist` index `001` already creates. That is the
difference between a delegated-scope filter costing a scan of every row and
costing an index probe — and delegated scope is on *every* record query in the
product.

`ids.ts::pathToLtree` / `ltreeToPath` convert. PostgreSQL 16 accepts `-` in
ltree labels, so a uuid is a valid label unchanged (verified on 16.4).

The same applies to `users.delegated_org_paths ltree[]`.

### 2.3 Audit hashes: `bytea` columns, hex strings, and the `GENESIS` sentinel

`audit_events.previous_hash` and `event_hash` are `bytea`. `audit.ts` writes
64-character hex HMAC-SHA256 digests, and the first event of each tenant chain
writes the literal string `"GENESIS"`:

```
ik_osa=# select decode('GENESIS','hex');
ERROR:  invalid hexadecimal digit: "G"
```

**Resolution.** `mapping.ts` encodes `GENESIS` as 32 zero bytes — a value the
HMAC can never produce, so it stays unambiguous — and hex-decodes everything
else. Critically, the **digest is still computed over the domain object carrying
the string `"GENESIS"`**. The bytea column is a storage encoding, never a hash
input, so no historical signature is affected by the representation change.

### 2.4 `audit_events.id` is `uuid` and is part of the signature

This is the sharpest incompatibility in the migration, and it is the reason
`src/lib/server/db/audit-chain.ts` exists.

`audit.ts::appendAuditWithin` mints the event id itself via `id("aud")`. The id
is one of the fields the HMAC covers. Mapping it to a uuid *after* signing
produces a row whose stored hash cannot be recomputed from its own contents: the
ledger fails its own verification on the first read, reported as `hash_mismatch`
on data nobody tampered with.

There is no way to inject an id into `appendAuditWithin`, so the adapter signs
over the **storage-form** event — identifiers mapped before the HMAC, never
after. That duplicates the digest, which is a defect, and it is guarded by
`tests/integration/postgres-repository.test.mjs` ("the adapter signs audit events
identically to audit.ts"), which asserts both implementations produce the same
hash for a byte-identical event. ADR-002 lists deleting `audit-chain.ts` as a
cutover task.

The same field-is-signed problem is why historical audit rows are **not**
backfilled at all. See ADR-002, "Audit chain".

### 2.5 `gap_cases.gap` is a generated column

```
ik_osa=# update osa.gap_cases set evidenced_level = 4, gap = 0 where id = …;
ERROR:  cannot insert a non-DEFAULT value into column "gap"
DETAIL:  Column "gap" is a generated column.
```

`learning.ts::refreshGapsForEvidence` assigns `gap.gap = Math.max(0, …)` and
`seed.ts` writes `gap: 2` literally. Every INSERT and UPDATE in the adapter omits
the column and lets the database recompute it. Asserted by the integration test.

### 2.6 `numeric` arrives as a string

`evidence.strength` and `enrollments.score` are `numeric(4,3)`. node-postgres
returns `numeric` as a **string**, because arbitrary precision does not fit a JS
double:

```
ik_osa=# select 0.85::numeric(4,3);   -- driver yields the string "0.850"
```

`learning.ts` compares `finalScore < course.passingScore` directly. A string
there compares lexicographically and passes the wrong learners. Every `numeric`
column is selected as `col::float8`.

### 2.7 `date` columns drift by a timezone

node-postgres parses a bare `date` into a JS `Date` at **local** midnight, so a
`due_date` of `2026-09-15` read west of UTC becomes `2026-09-14T…Z`. The domain
types `dueDate` as a `string`. Every `date` column is selected as `col::text`.

### 2.8 Sessions and CSRF tokens are hashed in SQL, plaintext in the store

`osa.sessions` keys on `id_hash bytea` and stores `csrf_hash bytea`. The JSON
store keeps `Session.id` and `Session.csrfToken` in plaintext.

Hashing is right — a datastore compromise then yields no usable cookie. But
`GET /api/auth/session` returns `csrfToken` to the browser, and a hash cannot be
read back. See §5 and ADR-002, "In-flight sessions".

`osa.sessions` also has `revoked_at`, which the application has no concept of;
logout deletes the row.

### 2.9 Enum vs union mismatches

`osa.record_status` is `('draft','active','retired')`. `Course.status` is
`"draft" | "published" | "retired"` — `published` is not a member, so courses
cannot reuse the type. `002` uses a CHECK constraint, which is `001`'s dominant
convention (13 CHECK-constrained text columns against 3 enum types); the single
new enum, `osa.severity`, exists because signals and notifications share one
vocabulary.

`osa.gap_priority` and `osa.audit_outcome` match the TypeScript unions exactly.

---

## 3. Field-level divergences in `001` tables

| Table | SQL has | Domain type has | Consequence |
|---|---|---|---|
| `job_roles` | `valid_from`, `valid_to`, `recorded_at`, `recorded_by NOT NULL` | `effectiveFrom` only | `recorded_by` has no source in the application |
| `requirements` | `valid_from`/`valid_to`, `recorded_by NOT NULL` | `effectiveFrom`/`effectiveTo`, no author | same |
| `skills` | `scale_code`, `status`, `version` | `scale`, no status or version | name mismatch; adapter filters `status <> 'retired'` |
| `tna_studies` | `version NOT NULL DEFAULT 1` | — | harmless default |
| `users` | `password_hash text NULL`, `email citext` | `passwordHash: string` (non-null), `email: string` | SSO users have no password; `login()`'s `toLowerCase()` comparisons become redundant under `citext` |
| `evidence` | `content_digest bytea`, `created_at` | — | unused |
| `gap_cases` | `updated_at` | — | adapter maintains it |
| `org_units` | `created_at NOT NULL` | — | defaulted |
| `sessions` | `revoked_at` | — | see §2.8 |

`002` deliberately declares `courses.recorded_by` **nullable**, rather than
repeating `001`'s `recorded_by NOT NULL` on a column the application cannot
populate. Tighten it once course authorship is captured.

---

## 4. Behavioural divergences — the database is stricter than the code

These are places where the schema will reject something the application
currently accepts. Each is, on inspection, the schema being right.

1. **A non-assessor cannot record evidence about themselves.**
   `src/app/api/evidence/route.ts` sets `assessorUserId: principal.user.id`
   unconditionally, and raises "Separation of duties violation" only when
   `principal.roles.includes("assessor")`. A principal holding `manager` but not
   `assessor` can therefore assert evidence about themselves today (as
   `pending`). `001` has `CHECK (assessor_user_id IS NULL OR assessor_user_id <>
   subject_user_id)`, which refuses it. **The check in the route is too narrow;
   the constraint is correct.**

2. **One active enrollment per learner per course becomes an invariant.**
   The route enforces it with a read-then-write that two concurrent requests
   both pass. `enrollments_one_active` — a partial unique index over
   `status IN ('enrolled','in_progress')` — makes it real, and leaves
   requalification after a completed enrollment possible.

3. **A module completion cannot reference a module from another course.**
   `learning.ts` throws "Module does not belong to the enrolled course" at
   runtime. `002` carries a denormalised `course_id` on `module_completions` and
   two composite foreign keys, so the module and the enrollment must agree on
   the same course in the same tenant. Unrepresentable, not merely checked.

4. **A dismissed signal must name a reason, a triager and a moment.**
   "Nobody looked at it" is the failure this product exists to prevent, so
   dismissal without a stated reason is a CHECK violation rather than a
   convention.

5. **An attendance-only course cannot carry a pass mark.**

6. **`osa.tenants` carries no RLS.** It is absent from `001`'s policy array.
   That omission is what makes tenant-first login possible — slug → tenant_id
   before any session exists — but it does mean the runtime role can enumerate
   the tenant directory. The grant matrix limits it to `SELECT`, and the
   integration test asserts both halves so the exception stays deliberate.

7. **One *open* notification per condition, not one row per condition.**
   `sweepNotifications()` maintains "at most one UNRESOLVED notification per
   (tenant, dedupeKey)"; a resolved row stays on file, and a recurrence raises a
   fresh row beside it with the same key. A total
   `UNIQUE (tenant_id, dedupe_key)` would reject the second episode and the
   platform would silently stop chasing a reopened obligation. `002` uses a
   partial unique index, `notifications_one_open`, and the adapter's upsert
   repeats the predicate so PostgreSQL infers it.

---

## 5. Required changes to files this work did not touch

Each of these is a prerequisite for cutover. None of them has been made.

| File | Change | Why |
|---|---|---|
| `src/lib/server/security.ts` | `id()` returns `randomUUID()` | §2.1 — otherwise nothing the application mints is storable |
| `src/lib/server/audit.ts` | `appendAuditWithin` accepts an injected id | §2.4 — lets `db/audit-chain.ts` be deleted |
| `src/app/api/auth/session/route.ts` | stop returning `csrfToken`; mint or verify against `csrf_hash` | §2.8 — the raw token is not recoverable from the schema |
| `src/lib/server/auth.ts` | make `tenantSlug` mandatory at login; move the in-memory login throttle to a shared store | tenant-first login avoids an RLS escape entirely; the throttle is per-process and the whole point of this migration is to run more than one process |
| `src/app/api/evidence/route.ts` | widen the self-assertion check beyond `assessor` | §4.1 |
| `package.json` | add `pg` (and `@types/pg`) | the driver is loaded dynamically today so `tsc` stays clean without it |
| `src/app/api/**` | route handlers call the repository instead of `readDatabase()` | the point of the interface |

`src/lib/server/db/repository.ts` documents why a literal port of `readDatabase`
would keep the current performance ceiling: `visibleRows()` is
O(rows × orgUnits) *after* reading every row of every table, `appendAudit()`
scans the whole ledger per mutation, and `GET /api/gaps` runs three array scans
per gap. The interface is query-shaped so those become index lookups.

---

## 6. Running it

### Bring up PostgreSQL and apply both migrations

`compose.infrastructure.yaml` mounts `./database/postgres` into the container's
`docker-entrypoint-initdb.d`, so on a **fresh volume** both migrations are
applied automatically, in filename order:

```bash
docker compose -f compose.infrastructure.yaml up -d postgres
export DATABASE_URL='postgresql://ik_osa:local-only-change-me@127.0.0.1:5432/ik_osa'
psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema='osa'"
--> 22
```

Against an **existing** database already at the `001` baseline, apply `002` by
hand:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/postgres/002_learning_and_signals.sql
```

`002` is not written to be re-applied over itself — it fails loudly on a second
run. Roll back first.

### Provision the runtime role

`002` grants to the runtime role but does not create it — a role needs a
credential, which must never live in version control.

```sql
CREATE ROLE ik_osa_app LOGIN PASSWORD '…'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
```

`002` cannot be re-run whole once it has been applied. Extract and run just its
grant section:

```bash
sed -n '/>>> GRANTS BEGIN/,/>>> GRANTS END/p' database/postgres/002_learning_and_signals.sql \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

To grant to a differently named role, prepend `SET osa.runtime_role = 'my_role';`
to that input. The migration refuses
outright if the named role has `BYPASSRLS` or is a superuser — ADR-001 lists both
as release blockers, and `PostgresPersistence.assertRuntimeRoleIsSafe()` checks
the same three properties again at pool creation, fatally.

`002` also creates `ik_osa_session_resolver`: a `NOLOGIN`, `NOBYPASSRLS` role
that owns exactly one `SECURITY DEFINER` function and holds one additional
`SELECT` policy on `osa.sessions`. It exists because resolving a session cookie
is the one operation that cannot be tenant-scoped first — the cookie carries an
opaque token, and forced RLS filters even the table owner. Nothing can connect
as it.

### Run the tests

```bash
npm install pg           # pg is NOT a dependency of this repository
node --import tsx --test tests/integration/postgres-repository.test.mjs
```

Without `pg`, without a reachable database, or without `002` applied, every test
**skips** with a stated reason rather than failing. It is not wired into
`npm test` (unit tests only) or `scripts/run-live-integration.sh` (which names
`live-api.test.mjs` explicitly), so it cannot break CI for engineers with no
database in front of them.

To use a `pg` installed outside this repository:

```bash
IK_PG_MODULE=/abs/path/to/node_modules/pg/lib/index.js \
  node --import tsx --test tests/integration/postgres-repository.test.mjs
```

Under plain `node --test` the SQL-level RLS proof still runs in full; only the
TypeScript adapter tests skip.

### Rollback

The rollback lives in `002_learning_and_signals.sql` itself, as lines prefixed
`--! `. Extract and run it with:

```bash
grep '^--! ' database/postgres/002_learning_and_signals.sql \
  | sed 's/^--! \{0,1\}//' \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

It has been rehearsed, as ADR-001 requires: the integration test
`migration 002 rolls back to the 001 baseline and re-applies` asserts the schema
goes 22 tables → 14 → 22. It is opt-in because it drops tables:

```bash
IK_PG_REHEARSE_ROLLBACK=true node --import tsx --test tests/integration/postgres-repository.test.mjs
```

**Data loss is total and intended.** Every row in the eight tables `002` creates
is discarded. Export them first if the database has served traffic. Nothing in
`001` loses a row; the policy, function, role, indexes and grants added to
`001`'s tables are the only things reverted there.
