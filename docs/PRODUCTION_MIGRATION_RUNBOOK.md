# Production migration runbook — 005 to 010

Rehearsal evidence, and the production actions deliberately not taken.

Status: **rehearsed on a disposable database. NOT applied to production.**

## What has and has not been applied

| Migration | Purpose | Production |
|---|---|---|
| 001-003 | Baseline schema, learning/signals, SaaS control plane | applied |
| 004 | Tenant lifecycle RLS gate | applied |
| 005 | Assessment & exam engine (9 tables) | **NOT applied** |
| 006 | One-in-progress-attempt unique index | **NOT applied** |
| 007 | Assessment runtime grants | **NOT applied** |
| 008 | `course_modules.assessment_id` | **NOT applied** |
| 009 | Live sessions, attendance, catalogue listing | **NOT applied** |
| 010 | Jitsi provider, orders, entitlements | **NOT applied** |

## Why 007 exists

`005_assessment_engine.sql` creates nine tables and ends by saying runtime
grants are provisioned "out-of-band". Nothing provisioned them. On a database
migrated exactly as documented:

```sql
SELECT has_table_privilege('ik_osa_app','osa.assessments','SELECT');  -- f
```

Every authoring, attempt and grading request fails with `permission denied for
table assessments` the moment the application connects as the role ADR-001
requires. **Any earlier rehearsal that appeared to work was run as a privileged
role — which also bypasses the `tenant_isolation` policies that same rehearsal
was meant to prove.** 005 and 006 must not be applied to production without 007.

## Rehearsal performed

Disposable PostgreSQL 16.15 in Docker, provisioned by
`scripts/provision-test-database.sh`: role `ik_osa_app` created LOGIN
NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE, then migrations 001-008 applied
in order with `osa.runtime_role` set so the grant sections fire.

**007**
- applied; per-table privileges verified: SELECT/INSERT/UPDATE true on all nine,
  DELETE true only on `assessment_items` and `rubric_scores`;
- rolled back with the extractable `--!` block; `has_table_privilege` returned
  `f` again;
- re-applied; privileges restored. Idempotent.

**008**
- applied; `course_modules.assessment_id uuid NULL` present with
  `course_modules_assessment_fk` and `course_modules_assessment_kind`;
- the kind CHECK verified to bite:
  `UPDATE osa.course_modules SET assessment_id = gen_random_uuid() WHERE kind='lesson'`
  → `violates check constraint "course_modules_assessment_kind"`;
- rolled back; column count 0. Re-applied; column count 1.
- Existing rows untouched — the column is nullable with no default.

**Application-level proof on the migrated database:** 17/17 live integration
tests and 17/17 @critical browser journeys, with the application connected as
`ik_osa_app` and RLS enforcing the tenant boundary.

## 009 — live sessions, attendance, catalogue listing

Creates `osa.live_sessions` and `osa.session_attendance`, and adds five columns
to `osa.courses` (`visibility`, `summary`, `instructor_user_id`,
`list_price_cents`, `currency`).

The course columns are all nullable or defaulted, so **existing course rows are
untouched** and keep behaving exactly as they did: every one defaults to
`visibility = 'organization'`, which is the delivery rule already in force.

Rehearsed: applied; grants verified for `ik_osa_app`; the
`courses_price_needs_currency` CHECK verified to reject a price with no currency;
rolled back to the 008 baseline; re-applied.

Two constraints worth knowing before this reaches production data:

* `session_attendance` requires `recorded_by` on any row that is not
  `registered`. An attendance nobody signed cannot be inserted, which is
  deliberate — it is what separates an attendance record from a sign-up list.
* `live_sessions` requires `ends_at > starts_at`. Nothing existing violates it
  because the table is new.

## 010 — live provider and commerce

Widens `live_sessions.provider` from `('manual')` to `('manual','jitsi')`, adds
`provider_room` and `session_attendance.source`, and creates `osa.orders` and
`osa.course_entitlements`.

Rehearsed: applied; constraint definitions verified
(`live_sessions_provider_check`, `live_sessions_room_matches_provider`); grants
verified (INSERT yes, **DELETE no** on both new tables — an order is a financial
record and an entitlement is revoked with a stated reason, not erased); rolled
back to the 009 baseline; re-applied.

**`AUTH_SECRET` becomes load-bearing in a second way here.** The Jitsi room name
is an HMAC of the session id under that secret. Rotating it after sessions exist
does not break the schema, but every existing hosted session silently moves to a
new room — anyone holding an old join link arrives somewhere nobody else is. If
that secret is ever rotated, hosted sessions scheduled before the rotation must
be re-issued.

## Production actions deliberately NOT performed

None of the following were done, and each needs a human decision:

1. **No migration was applied to the Neon production database.** 005, 006, 007,
   008, 009 and 010 are all outstanding there.
2. **No production runtime role was altered.** 007 grants to whatever
   `osa.runtime_role` names; the production role name must be confirmed before
   it runs.
3. **No production data was read, written or deleted.** The provisioner refuses
   any non-local host unless `IK_ALLOW_REMOTE_PROVISION=yes` is set explicitly,
   and its schema reset is default-on only for a local host.
4. **`AUDIT_HASH_SECRET` was not rotated.** ADR note: the production database
   already holds 18 audit events that cannot be verified because they were
   written under a different secret. An HMAC chain is only verifiable under the
   key that signed it and `audit_events` is append-only, so **rotating that
   secret again would orphan more history permanently.**

## Recommended production sequence

1. Confirm the production runtime role name; set `osa.runtime_role` to it. Every
   migration's grant block reads that setting and defaults to `ik_osa_app`.
2. Apply 005, 006, 007, 008, 009, 010 in one maintenance window, **in that
   order**. 007 must not be separated from 005/006: without it the runtime role
   holds no privilege on any assessment table and the engine returns
   `permission denied` on every request.
3. Verify with the block in the VERIFICATION section of 007, then confirm
   `assertRuntimeRoleIsSafe` passes at boot.
4. **Set `AUTH_SECRET` before deploying.** The boot check now refuses to start
   without it — a behaviour change for any instance that was previously starting
   and then failing every sign-in at runtime instead.
5. Optionally set `LIVE_JITSI_DOMAIN` to a self-hosted Jitsi instance. The
   default is the public `meet.jit.si`, which is acceptable for a pilot and
   wrong for regulated training: a public instance puts a third party inside a
   class that may discuss incidents, named people and safety findings.

## Rollback

Every migration from 007 onward carries an extractable rollback block:

```
grep '^--! ' database/postgres/0NN_*.sql | sed 's/^--! \{0,1\}//' \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

Each was rehearsed by rolling back to the previous baseline and re-applying.
Roll back in reverse order (010, 009, 008, 007). Note that a rollback of 009 or
010 **drops tables**: any live session, attendance record, order or entitlement
written after the migration is lost. Rolling back after the feature has been
used is a data decision, not just a schema one.
