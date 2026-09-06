# Migrations 007 and 008 — rehearsal evidence and production actions

Status: **rehearsed on a disposable database. NOT applied to production.**

## What has and has not been applied

| Migration | Purpose | Production |
|---|---|---|
| 001-003 | Baseline schema, learning/signals, SaaS control plane | applied |
| 004 | Tenant lifecycle RLS gate | applied |
| 005 | Assessment & exam engine (9 tables) | **NOT applied** |
| 006 | One-in-progress-attempt unique index | **NOT applied** |
| 007 | Assessment runtime grants | **NOT applied** — new in this branch |
| 008 | `course_modules.assessment_id` | **NOT applied** — new in this branch |

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

## Production actions deliberately NOT performed

None of the following were done, and each needs a human decision:

1. **No migration was applied to the Neon production database.** 005, 006, 007
   and 008 are all outstanding there.
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

1. Confirm the production runtime role name; set `osa.runtime_role` to it.
2. Apply 005, 006, 007, 008 in one maintenance window, in that order.
3. Verify with the block in the VERIFICATION section of 007, then re-check
   `assertRuntimeRoleIsSafe` passes at boot.
4. Set `AUTH_SECRET` if it is not already set — the boot check now refuses to
   start without it, which is a behaviour change for any instance that was
   missing it and failing every sign-in at runtime instead.
