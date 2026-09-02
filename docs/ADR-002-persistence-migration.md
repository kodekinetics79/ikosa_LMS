# ADR-002: Migrating persistence from the JSON store to PostgreSQL

**Status:** Proposed
**Decision date:** 2026-09-01
**Supersedes nothing.** Extends ADR-001, item 1 ("the R0 repository boundary is
intentionally replaceable").

## Context

`src/lib/server/store.ts` reads and rewrites the entire database file on every
mutation, serialised by a per-process promise queue. Three consequences, in
order of how quickly they become fatal:

1. **It cannot run more than one instance.** Two processes silently overwrite
   each other's writes; the queue is per-process and the file is rewritten
   whole. There is no lock, no compare-and-swap, and no way to detect the loss.
2. **It cannot run on a read-only or per-instance filesystem.** `compose.yaml`
   already sets `read_only: true` on the app container and mounts a writable
   volume just for this. That volume is what pins the product to one replica.
3. **It is measured at roughly 4 requests/second with 200k evidence rows**, and
   the shape of the code says why: every request parses the whole database, and
   `visibleRows()` then runs `assertScoped()` per row, which linear-scans
   `orgUnits` per row. `appendAudit()` scans the entire ledger on every
   mutation. `GET /api/gaps` performs three array scans per gap.

`database/postgres/001_initial.sql` is a genuinely good schema — tenant-qualified
composite foreign keys, valid-time on decision-critical records, an append-only
audit ledger, forced RLS on every tenant table — and it has never been connected
to anything. Its central claim, from ADR-001, was untested: *"a missed
application predicate is still blocked by database RLS in production."*

## Decisions

### 1. The schema stays. The application moves to it.

`001` is not rewritten. `002_learning_and_signals.sql` adds the six entities the
`Database` type grew since (`courses`, `courseModules`, `enrollments`,
`moduleCompletions`, `signals`, `notifications`) plus two junction tables, using
`001`'s conventions without exception.

The representation gaps — prefixed string ids against `uuid`, `/a/b` paths
against `ltree`, hex digests and a `GENESIS` sentinel against `bytea`, a
generated `gap` column the application writes to — are resolved in a mapping
layer, not by loosening column types. Each is catalogued with its reproduced
error in `database/postgres/README-migration.md`. Weakening `uuid` to `text`
would have been a one-line change and would have discarded the referential
integrity that makes the schema worth migrating to.

### 2. The repository interface is query-shaped. There is no `readDatabase()`.

A literal port — `SELECT *` followed by the same in-memory filter — reproduces
today's full table scan with network round trips added. `OsaRepository` therefore
takes an `ActorScope` on every method and pushes tenant, delegated-org and
self-scope into SQL, where `org_units_path_gist` and the indexes in `002` serve
them. There is no "give me everything" method, because one would be used.

Authorization does **not** move into the database. `authorize()` remains the
single source of truth for whether an action is permitted; the scope predicates
decide which rows a query may consider; RLS is the third layer and the only one
that still holds when the second is forgotten.

Domain rules do not move either. `recordModuleCompletion`,
`refreshGapsForEvidence` and the audit signature stay where they are; the
adapter loads the working set they need, runs them unmodified, and writes back
the delta in one transaction. Two implementations of "may this completion emit
evidence" is how a compliance product starts telling two different stories.

### 3. Every transaction sets its tenant context with `set_config`, never `SET LOCAL`

`SET LOCAL` does not accept bind parameters, so writing it literally requires
string concatenation — on the value that decides which tenant's data a request
can see. `SELECT set_config('app.tenant_id', $1, true)` is the parameterisable
equivalent. Nothing in the adapter interpolates a tenant or user id.

The context is transaction-local, so a pooled connection returned to the pool
carries none. A session-level `SET` would leak one tenant's context into the
next request; the integration test asserts the transaction-local behaviour
directly, because this is the failure mode a connection pool makes invisible.

### 4. Cutover: expand/contract, read-path shadowing, per-deployment flip. **No dual-write.**

Dual-write is the obvious choice and it is wrong here.

- The two stores have incompatible consistency models — a whole-file rewrite
  against a transaction — and cannot be made to agree without a distributed
  transaction.
- The audit hash chain makes divergence *undetectable until verification*: a
  write that lands in one store and not the other produces two chains with
  different heads, and neither is authoritative.
- It doubles the failure surface of evidence creation, the one operation in this
  product that must never be lost.

A single big-bang across the fleet is also wrong, for a different reason: the
JSON store is per-instance, so there is no single "the data" to cut over. Each
deployment has its own file.

The plan is therefore **per-deployment, single-writer, with a short read-only
window**:

**Phase 0 — dark (this change).** The layer exists, is typechecked, and is
proven against a real server. No route imports it. `pg` is loaded dynamically
and is not a declared dependency, so a checkout that never installs it still
builds, typechecks and tests clean.

**Phase 1 — prerequisites.** The changes listed in README-migration.md §5, behind
`IK_PERSISTENCE=json|postgres`, defaulting to `json`. The full unit and
Playwright suites must pass against **both** settings. This is the phase that
takes the time; the SQL is the easy part.

**Phase 2 — shadow reads.** For a soak period, GETs execute against both stores
and compare, logging differences with the request id. JSON stays authoritative.
Reads are idempotent, so this is cheap and risks nothing, and it is the only way
to find mapping bugs — a `numeric` returned as `"0.850"`, a `date` drifting a
day — at production data volumes rather than fixture volumes. Shadow **reads**
only; this is not dual-write.

**Phase 3 — flip, one deployment at a time.**

1. Drain and stop accepting mutations (`503` on non-GET) — target 60 seconds.
2. Run the backfill: JSON file → PostgreSQL, ids derived with `uuidV5`.
3. Verify: row counts per collection, and a full re-read through the repository
   compared against the JSON store.
4. Set `IK_PERSISTENCE=postgres`, restart, resume writes.
5. Watch the audit chain verification endpoint. It is the canary: if the
   backfill is wrong, `verifyAuditChain` says so precisely.

**Phase 4 — contract.** After a soak, delete the write path in `store.ts`, delete
`src/lib/server/db/audit-chain.ts` (see below), and make `pg` a hard dependency.

### 5. Audit chain: seal and stitch. Nothing is re-signed, nothing is re-hashed.

Historical audit rows are **not** backfilled into `osa.audit_events`, and this is
a deliberate refusal rather than a shortcut.

The HMAC covers the event's `id` and `resourceId`. In the JSON store those are
`aud_9f3c…` and, for authentication events, `session.id.slice(0, 12)` — twelve
characters of a base64url token. `osa.audit_events.id` and `resource_id` are
`uuid`. Storing them requires mapping them, mapping them changes the hash input,
and the row then fails its own verification: `hash_mismatch` reported on data
nobody touched. Re-signing is worse — it would mean re-computing every historical
signature with the current secret, which destroys precisely the property the
ledger exists to provide.

So, per tenant, at cutover:

1. **Export** the tenant's chain verbatim — the exact objects that were signed —
   as a JSON document.
2. **Verify** it once with the existing `verifyAuditChain(tenantId)`. A tenant
   whose chain does not verify blocks its own cutover; that is a release blocker
   under ADR-001 and is discovered here, not later.
3. **Seal** it: write it to retention-locked object storage with a signed
   manifest, as ADR-001 item 6 already prescribes for durable exports.
4. **Stitch**: write one `audit.chain.sealed` event as the new PostgreSQL chain's
   first event. Its `previousHash` is `GENESIS`; its `metadata` carries
   `legacy_final_hash` (the last hash of the sealed chain) and
   `legacy_export_sha256` (the digest of the exported document).

Verification after cutover is two-part: the legacy verifier over the sealed
export, plus the live verifier over PostgreSQL. The stitch event is what proves
they are one ledger. No signature is invalidated because no signature is
recomputed.

Going forward, ids are uuids, mapping is the identity, and the problem does not
recur.

Two operational notes. First, `appendAudit` takes a transaction-scoped advisory
lock keyed on the tenant before reading the chain head: two concurrent appenders
at READ COMMITTED would otherwise read the same head and fork the chain, which
no retry repairs. The single-process write queue hid this completely. Second,
the chain must be ordered by `sequence`, not `occurred_at`, which ties inside a
millisecond; `002` adds `audit_tenant_sequence` for it.

### 6. In-flight sessions: invalidate them. Do not migrate them.

Session tokens could be migrated — hash them into `id_hash` and existing cookies
keep working. CSRF tokens cannot. `osa.sessions` stores `csrf_hash bytea`,
`GET /api/auth/session` returns the raw `csrfToken` to the browser, and a hash
does not go backwards. Carrying the raw token into the new store to avoid a
re-login would discard the exact property the schema was designed for.

So all sessions are invalidated at cutover. With a 12-hour session lifetime and
a login form, that is a few seconds of inconvenience inside a window that
already stops writes. One `auth.session.invalidated` event per tenant is written
so the mass logout is explainable to whoever reads the ledger next.

If a re-login is genuinely unacceptable for a given deployment, the fallback is:
migrate sessions with `csrf_hash` populated from a freshly minted token, and have
`/api/auth/session` issue that new token on first call after cutover. It works;
it is a code path that exists for one hour; prefer the invalidation.

The in-memory login throttle in `auth.ts` must move to a shared store in the same
release. It protects a single instance, which is the constraint this migration
exists to remove — cutting over without it turns a working brute-force defence
into a decorative one.

### 7. Rollback

**Schema rollback is rehearsed and proven.** The rollback block in `002` is
executed by `tests/integration/postgres-repository.test.mjs`, which asserts the
schema goes 22 tables → 14 (the exact `001` baseline) → 22.

**Data rollback has a hard boundary: the first successful write against
PostgreSQL.**

- *Before* that point the JSON file is untouched and still authoritative.
  Rollback is flipping `IK_PERSISTENCE` back. Free.
- *After* it, rolling back means exporting PostgreSQL back to JSON, and any
  write made in between is at risk.

The runbook must state this as a point of no return rather than implying
symmetry. After the first write, the correct response to a problem is to roll
*forward* under PostgreSQL, and the read-only window in Phase 3 exists to make
the free-rollback period long enough to verify.

## Consequences

- The single-instance ceiling lifts, and with it the read-only-filesystem
  constraint that forced a writable volume into `compose.yaml`.
- ADR-001's central claim is now tested rather than asserted. The integration
  test issues cross-tenant reads with the tenant predicate *mechanically
  verified to be absent*, including fetches by primary key of rows known to
  exist in another tenant, and requires zero rows.
- Several invariants move from application code into the schema — one active
  enrollment per learner per course, one open notification per condition, a
  module completion that cannot reference another course's module, a dismissed
  signal that must name a reason. Each was previously a read-then-write that
  concurrency defeats.
- The database is stricter than the application in at least one place that
  matters: a principal holding `manager` but not `assessor` can currently record
  evidence about themselves, and `001`'s separation-of-duties CHECK refuses it.
  That check in `evidence/route.ts` is too narrow and must be widened before
  cutover, not after it starts failing inserts.
- `src/lib/server/db/audit-chain.ts` duplicates the audit HMAC and is a known
  defect with a test pinning it to `audit.ts` and a cutover task to delete it.
- `osa.tenants` carries no RLS, by omission in `001`. It is what makes
  tenant-first login work without a privilege escape, and it means the runtime
  role can enumerate the tenant directory. Accepted, limited to `SELECT`, and
  asserted in the test so it stays a decision.
- Search, object storage, queues and caches still have to repeat the same tenant
  namespace before being introduced. This migration does not change that.

## Release blockers added to ADR-001's list

- The audit chain of any tenant fails verification during the pre-cutover export.
- The RLS proof does not execute in CI against a real PostgreSQL before the
  first production cutover. A skipped proof is not a passing proof.
- `security.ts::id()` still mints prefixed strings.
- The login throttle is still per-process while more than one instance runs.
