-- iK Operational Skills Assurance — migration 002: learning delivery, change
-- signals and notifications.
--
-- Baseline: 001_initial.sql. This migration adds the six entities the TypeScript
-- `Database` type grew after that baseline was written (courses, courseModules,
-- enrollments, moduleCompletions, signals, notifications), the two junction
-- tables that normalise the array fields on those entities, and the session
-- resolution path that forced RLS otherwise makes impossible.
--
-- Conventions inherited from 001 and preserved here without exception:
--   * every tenant table carries tenant_id uuid NOT NULL REFERENCES osa.tenants(id)
--   * every tenant table declares UNIQUE (tenant_id, id) so children can point at
--     it with a tenant-qualified composite foreign key
--   * every foreign key between tenant tables is composite on (tenant_id, <id>),
--     so a row can never reference a parent belonging to another tenant
--   * vocabularies are text + CHECK unless they are shared by more than one
--     table (001 reserves enum types for shared vocabularies)
--   * forced row-level security with the identical `tenant_isolation` policy
--   * valid-time columns where a decision can change and history must survive
--
-- The application transaction MUST execute, from the validated session only:
--   SELECT set_config('app.tenant_id', '<tenant uuid>', true);
--   SELECT set_config('app.user_id',   '<user uuid>',   true);
-- `set_config(..., true)` is the parameterisable form of SET LOCAL. Never build
-- a literal `SET LOCAL app.tenant_id = '...'` by string concatenation: SET does
-- not accept bind parameters, so that form is an injection site.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Shared vocabulary
-- ---------------------------------------------------------------------------

-- Signals and notifications share one severity vocabulary, which is why this is
-- a type rather than two CHECK constraints. Ordered ascending like
-- osa.gap_priority so ORDER BY severity DESC surfaces the urgent rows first.
CREATE TYPE osa.severity AS ENUM ('low','medium','high','critical');

-- ---------------------------------------------------------------------------
-- 1. Learning delivery
--
-- The LMS is the fulfilment engine for an intervention, not a parallel product.
-- A course develops exactly one skill; a passing completion emits evidence
-- against that skill, and evidence remains the single authority on capability.
-- ---------------------------------------------------------------------------

CREATE TABLE osa.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  skill_id uuid NOT NULL,
  target_level smallint NOT NULL CHECK (target_level BETWEEN 0 AND 5),
  evidence_rule text NOT NULL CHECK (evidence_rule IN ('assessed','attendance_only')),
  passing_score numeric(4,3) NOT NULL CHECK (passing_score BETWEEN 0 AND 1),
  validity_months integer NULL CHECK (validity_months IS NULL OR validity_months > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft','published','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Valid time, matching osa.job_roles: a course version decides what evidence
  -- may be minted, so superseding one must not erase what the old one attested.
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable, unlike job_roles.recorded_by: the application does not capture an
  -- author for a course today. Tightened to NOT NULL once it does (see
  -- README-migration.md, "Columns the application cannot populate yet").
  recorded_by uuid NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, version),
  FOREIGN KEY (tenant_id, org_unit_id) REFERENCES osa.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES osa.skills(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES osa.users(tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- An attendance-only course records that someone turned up. Letting it carry
  -- a pass mark invites a later reader to treat attendance as assessment.
  CHECK (evidence_rule <> 'attendance_only' OR passing_score = 0)
);

CREATE TABLE osa.course_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  course_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position > 0),
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('lesson','document','video','scorm','assessment')),
  duration_minutes integer NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
  required boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, course_id, position),
  -- Lets osa.module_completions prove, structurally, that a completed module
  -- belongs to the enrolled course. See the composite keys on that table.
  UNIQUE (tenant_id, course_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES osa.courses(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE osa.enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  course_id uuid NOT NULL,
  -- Named subject_user_id, like osa.evidence and osa.gap_cases, so one org and
  -- self-scoping predicate serves every subject-bearing table.
  subject_user_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('self','assigned','intervention')),
  -- Junctions back to the assurance spine; set when learning fulfils a gap.
  intervention_id uuid NULL,
  gap_case_id uuid NULL,
  status text NOT NULL CHECK (status IN ('enrolled','in_progress','completed','withdrawn')),
  assigned_by_user_id uuid NULL,
  due_date date NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  score numeric(4,3) NULL CHECK (score IS NULL OR score BETWEEN 0 AND 1),
  -- The evidence this completion produced, when it produced any.
  evidence_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, course_id, id),
  FOREIGN KEY (tenant_id, org_unit_id) REFERENCES osa.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES osa.courses(tenant_id, id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES osa.users(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by_user_id) REFERENCES osa.users(tenant_id, id),
  FOREIGN KEY (tenant_id, intervention_id) REFERENCES osa.interventions(tenant_id, id),
  FOREIGN KEY (tenant_id, gap_case_id) REFERENCES osa.gap_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES osa.evidence(tenant_id, id),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  -- Evidence is minted at completion. A pending enrollment holding an evidence
  -- id would mean a competence claim exists for work not yet finished.
  CHECK (evidence_id IS NULL OR status = 'completed'),
  CHECK (assigned_by_user_id IS NULL OR source <> 'self')
);

-- The application enforces "one active enrollment per learner per course" with
-- a read-then-write, which two concurrent requests both pass. Here it is an
-- invariant. Completed and withdrawn rows are excluded so requalification after
-- evidence expiry stays possible.
CREATE UNIQUE INDEX enrollments_one_active
  ON osa.enrollments (tenant_id, course_id, subject_user_id)
  WHERE status IN ('enrolled','in_progress');

CREATE TABLE osa.module_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  enrollment_id uuid NOT NULL,
  module_id uuid NOT NULL,
  -- Denormalised solely to carry the invariant below. Never selected on its own.
  course_id uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  score numeric(4,3) NULL CHECK (score IS NULL OR score BETWEEN 0 AND 1),
  UNIQUE (tenant_id, id),
  -- Replaces the in-memory scan that makes recordModuleCompletion idempotent.
  -- Replaying a completion now collides and is resolved with ON CONFLICT.
  UNIQUE (tenant_id, enrollment_id, module_id),
  -- "Module does not belong to the enrolled course" is a runtime throw in
  -- learning.ts. These two composite keys make it unrepresentable: the module
  -- and the enrollment must agree on the same course, in the same tenant.
  FOREIGN KEY (tenant_id, course_id, enrollment_id)
    REFERENCES osa.enrollments(tenant_id, course_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, course_id, module_id)
    REFERENCES osa.course_modules(tenant_id, course_id, id)
);

-- ---------------------------------------------------------------------------
-- 2. Change signals
--
-- The front of the continuous-TNA funnel. Triage either links a signal to a
-- study or dismisses it with a stated reason; a signal is never silently
-- dropped, because "nobody looked at it" is the failure this product prevents.
-- ---------------------------------------------------------------------------

CREATE TABLE osa.signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('regulation','policy','incident','audit','workforce','performance')),
  source_reference text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  detected_at timestamptz NOT NULL,
  -- When the change starts to bite. Drives triage urgency.
  effective_at timestamptz NULL,
  severity osa.severity NOT NULL,
  status text NOT NULL CHECK (status IN ('new','triaged','linked','dismissed')),
  linked_study_id uuid NULL,
  triaged_by_user_id uuid NULL,
  triaged_at timestamptz NULL,
  dismissed_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, org_unit_id) REFERENCES osa.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, linked_study_id) REFERENCES osa.tna_studies(tenant_id, id),
  FOREIGN KEY (tenant_id, triaged_by_user_id) REFERENCES osa.users(tenant_id, id),
  -- A dismissal must name a person, a moment and a reason. Without this the
  -- product's central promise degrades into an unaudited delete.
  CHECK (status <> 'dismissed' OR (dismissed_reason IS NOT NULL AND triaged_by_user_id IS NOT NULL AND triaged_at IS NOT NULL)),
  CHECK (status <> 'linked' OR (linked_study_id IS NOT NULL AND triaged_by_user_id IS NOT NULL AND triaged_at IS NOT NULL)),
  CHECK (status = 'dismissed' OR dismissed_reason IS NULL),
  CHECK (triaged_at IS NULL OR triaged_at >= detected_at)
);

-- affectedJobRoleIds / affectedSkillIds are arrays on the TypeScript type.
-- Normalised here for the same reason 001 normalised TnaStudy.targetRoleIds
-- into osa.tna_target_roles: an array cannot carry a tenant-qualified foreign
-- key, so an array is a place where a cross-tenant id can hide.
CREATE TABLE osa.signal_job_roles (
  tenant_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  job_role_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, signal_id, job_role_id),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES osa.signals(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES osa.job_roles(tenant_id, id)
);

CREATE TABLE osa.signal_skills (
  tenant_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, signal_id, skill_id),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES osa.signals(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, skill_id) REFERENCES osa.skills(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- 3. Notifications
--
-- Derived from state by an idempotent sweep rather than written ad hoc, so the
-- same condition can never raise two rows and a missed sweep never loses one.
-- ---------------------------------------------------------------------------

CREATE TABLE osa.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  -- The person who needs to act.
  subject_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'evidence_expiring','evidence_expired','enrollment_due','enrollment_overdue',
    'signal_untriaged','intervention_overdue')),
  severity osa.severity NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  -- Deliberately polymorphic (evidence, enrollment, signal, intervention), so
  -- no foreign key. The tenant-qualified key on the sweep's source row is what
  -- keeps this honest; resource_id is a pointer for the UI, not an authority.
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  due_at timestamptz NULL,
  -- Stable identity for the underlying condition. Uniqueness is enforced by the
  -- PARTIAL index below, not here -- see the comment on notifications_one_open.
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz NULL,
  resolved_at timestamptz NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, org_unit_id) REFERENCES osa.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES osa.users(tenant_id, id),
  CHECK (read_at IS NULL OR read_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

-- The sweep's invariant, stated exactly as sweepNotifications() states it: at
-- most one UNRESOLVED notification per (tenant, dedupe_key).
--
-- A total UNIQUE (tenant_id, dedupe_key) would be wrong, and wrong in the
-- product's own terms. A resolved notification stays on file because "this was
-- chased and dealt with" is part of the record an auditor asks for; when the
-- same condition recurs -- the enrollment reopens, the signal goes untriaged
-- again -- a fresh unread row is raised BESIDE the resolved one, carrying the
-- same key. The key identifies the condition; a row is one episode of it. Under
-- a total constraint that second episode would be rejected, and the platform
-- would silently stop chasing a reopened obligation.
CREATE UNIQUE INDEX notifications_one_open
  ON osa.notifications (tenant_id, dedupe_key)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the access patterns the application actually issues
--
-- Every index is tenant-leading: RLS injects tenant_id = current_tenant_id()
-- into every plan, so an index without tenant_id in front of it is not usable
-- for the predicate the planner is given.
-- ---------------------------------------------------------------------------

-- Catalogue browse: published courses inside (or above) a delegated org scope.
CREATE INDEX courses_org_status ON osa.courses (tenant_id, org_unit_id, status);
-- Gap closure: "which courses develop the skill this gap needs".
CREATE INDEX courses_skill ON osa.courses (tenant_id, skill_id) WHERE status = 'published';
-- Course player: modules in presentation order.
CREATE INDEX course_modules_course_position ON osa.course_modules (tenant_id, course_id, position);
-- "My learning", and any manager view of one person's record.
CREATE INDEX enrollments_subject ON osa.enrollments (tenant_id, subject_user_id, status);
-- Course-side reporting: completion rate for a course.
CREATE INDEX enrollments_course ON osa.enrollments (tenant_id, course_id, status);
-- Org rollups over a delegated subtree.
CREATE INDEX enrollments_org ON osa.enrollments (tenant_id, org_unit_id, status);
-- The overdue sweep. Partial: finished enrollments are never chased.
CREATE INDEX enrollments_due ON osa.enrollments (tenant_id, due_date)
  WHERE status IN ('enrolled','in_progress') AND due_date IS NOT NULL;
-- Progress calculation for one enrollment.
CREATE INDEX module_completions_enrollment ON osa.module_completions (tenant_id, enrollment_id);
-- Signal inbox, newest and most severe first.
CREATE INDEX signals_status_severity ON osa.signals (tenant_id, status, severity DESC, detected_at DESC);
-- "What bites soon and is still untriaged".
CREATE INDEX signals_effective ON osa.signals (tenant_id, effective_at)
  WHERE status IN ('new','triaged') AND effective_at IS NOT NULL;
CREATE INDEX signals_org ON osa.signals (tenant_id, org_unit_id, status);
-- One person's open notifications, soonest first.
CREATE INDEX notifications_subject_open ON osa.notifications (tenant_id, subject_user_id, due_at)
  WHERE resolved_at IS NULL;
-- The sweep's own scan, by condition class.
CREATE INDEX notifications_kind_open ON osa.notifications (tenant_id, kind, due_at)
  WHERE resolved_at IS NULL;

-- Additive indexes on 001 tables, for access patterns that only became real
-- once the sweep and the learning loop existed. No table is altered.

-- appendAudit needs the tenant's most recent event to chain onto. The existing
-- audit_tenant_time index orders by occurred_at, which ties inside a
-- millisecond; `sequence` is the only total order the chain can trust.
CREATE INDEX audit_tenant_sequence ON osa.audit_events (tenant_id, sequence DESC);
-- evidence_expiring / evidence_expired sweep.
CREATE INDEX evidence_expiry ON osa.evidence (tenant_id, expires_at)
  WHERE status = 'verified' AND expires_at IS NOT NULL;
-- intervention_overdue sweep.
CREATE INDEX interventions_due ON osa.interventions (tenant_id, due_date)
  WHERE status IN ('planned','active');

-- ---------------------------------------------------------------------------
-- 5. Forced row-level security — identical policy shape to 001
-- ---------------------------------------------------------------------------

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['courses','course_modules','enrollments','module_completions','signals','signal_job_roles','signal_skills','notifications']
  LOOP
    EXECUTE format('ALTER TABLE osa.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osa.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON osa.%I USING (tenant_id = osa.current_tenant_id()) WITH CHECK (tenant_id = osa.current_tenant_id())', t);
  END LOOP;
END $rls$;

-- ---------------------------------------------------------------------------
-- 6. Session resolution under forced RLS
--
-- Forced RLS makes one real request impossible: resolving a session cookie.
-- The cookie carries an opaque token and nothing else, so the tenant is not
-- known until osa.sessions has been read — and osa.sessions cannot be read
-- until the tenant is known. FORCE ROW LEVEL SECURITY means even the table
-- owner is filtered, so a SECURITY DEFINER function owned by the migration
-- role would return zero rows too.
--
-- Resolved with the narrowest escape that exists: a dedicated NOLOGIN role
-- that holds one additional permissive SELECT policy on osa.sessions and
-- nothing else, and owns one STABLE function that returns tenant_id, user_id
-- and the CSRF hash for a session the caller already holds the token to. The
-- runtime role keeps NOBYPASSRLS and owns no tables; it is granted EXECUTE on
-- this function and cannot read osa.sessions any other way.
--
-- Login does NOT use an escape: osa.tenants carries no RLS (by design in 001 —
-- see README-migration.md), so slug -> tenant_id resolves first and the user
-- lookup then runs inside a normal tenant context.
-- ---------------------------------------------------------------------------

DO $resolver_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ik_osa_session_resolver') THEN
    BEGIN
      -- NOLOGIN: nothing may ever connect as this role. NOINHERIT and
      -- NOBYPASSRLS: it gains nothing beyond the single policy below.
      EXECUTE 'CREATE ROLE ik_osa_session_resolver NOLOGIN NOINHERIT NOBYPASSRLS';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Migration 002 must create role ik_osa_session_resolver. Grant CREATEROLE to the migration role, or provision the role first (see README-migration.md).';
    END;
  END IF;
END $resolver_role$;

CREATE POLICY session_resolution ON osa.sessions
  FOR SELECT TO ik_osa_session_resolver USING (true);

-- A policy grants ROW visibility, not TABLE privilege. Without these two grants
-- the SECURITY DEFINER function below fails with "permission denied for schema
-- osa" the first time a session cookie is resolved -- and only then, because
-- nothing else in the system runs as this role. Caught by
-- tests/integration/postgres-repository.test.mjs.
GRANT USAGE ON SCHEMA osa TO ik_osa_session_resolver;
GRANT SELECT ON osa.sessions TO ik_osa_session_resolver;

CREATE FUNCTION osa.resolve_session(p_id_hash bytea)
RETURNS TABLE (tenant_id uuid, user_id uuid, csrf_hash bytea, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = osa, pg_catalog
AS $$
  SELECT s.tenant_id, s.user_id, s.csrf_hash, s.expires_at
  FROM osa.sessions s
  WHERE s.id_hash = p_id_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
$$;

-- PostgreSQL 16 split role membership from the right to SET ROLE, so a
-- CREATEROLE migration user that just created this role still cannot assume it,
-- and the OWNER TO below fails with "must be able to SET ROLE". Granting
-- membership WITH SET makes the ownership transfer possible on PG16+ and on
-- managed platforms (Neon, RDS) where the migration user is not a superuser.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'ik_osa_session_resolver', 'SET') THEN
    EXECUTE format('GRANT ik_osa_session_resolver TO %I WITH SET TRUE', current_user);
  END IF;
END
$$;

-- PostgreSQL requires a new owner to hold CREATE on the object's schema, so the
-- transfer needs it momentarily. It is revoked immediately afterwards: this role
-- must own exactly one function and be able to create nothing.
GRANT CREATE ON SCHEMA osa TO ik_osa_session_resolver;
ALTER FUNCTION osa.resolve_session(bytea) OWNER TO ik_osa_session_resolver;
REVOKE CREATE ON SCHEMA osa FROM ik_osa_session_resolver;
-- SECURITY DEFINER functions are EXECUTE-to-PUBLIC by default. Revoke first,
-- then grant deliberately.
REVOKE ALL ON FUNCTION osa.resolve_session(bytea) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 7. Runtime role privileges
--
-- The runtime role is provisioned outside migrations (it needs a credential,
-- which must never live in version control). This grants to it if it exists and
-- says so loudly if it does not. Name it via
--   SET osa.runtime_role = 'my_app_role';
-- before running the migration; the default is ik_osa_app.
--
-- The grant matrix is deliberately narrow:
--   * no DELETE anywhere except osa.sessions (logout), so a bug cannot erase
--     evidence, gaps or enrollments — retirement is a status change
--   * no privileges at all on osa.audit_events beyond SELECT/INSERT: the
--     append-only trigger is defence in depth, not the only defence
--   * SELECT only on osa.tenants, which carries no RLS
--   * no ownership, no BYPASSRLS, no CREATE on the schema
-- ---------------------------------------------------------------------------

-- >>> GRANTS BEGIN  (extractable: see README-migration.md, "Provision the runtime role")
DO $grants$
DECLARE
  app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'Runtime role % does not exist; skipping grants. Provision it, then re-run section 7 (see README-migration.md).', app_role;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND rolbypassrls) THEN
    RAISE EXCEPTION 'Runtime role % has BYPASSRLS. ADR-001 lists this as a release blocker.', app_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND rolsuper) THEN
    RAISE EXCEPTION 'Runtime role % is a superuser. ADR-001 lists this as a release blocker.', app_role;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA osa TO %I', app_role);
  EXECUTE format('GRANT SELECT ON osa.tenants TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON osa.audit_events TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON osa.sessions TO %I', app_role);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION osa.resolve_session(bytea) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION osa.current_tenant_id() TO %I', app_role);

  FOREACH t IN ARRAY ARRAY[
    'org_units','users','user_roles','job_roles','skills','requirements',
    'tna_studies','tna_target_roles','evidence','gap_cases','interventions',
    'courses','course_modules','enrollments','module_completions',
    'signals','signal_job_roles','signal_skills','notifications']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.%I TO %I', t, app_role);
  END LOOP;

  -- Junction rows are removed, not retired.
  EXECUTE format('GRANT DELETE ON osa.tna_target_roles, osa.signal_job_roles, osa.signal_skills, osa.user_roles TO %I', app_role);
END $grants$;
-- >>> GRANTS END

COMMIT;


-- ===========================================================================
-- ROLLBACK
--
-- Rehearsed as ADR-001 requires; the rehearsal is asserted by
-- tests/integration/postgres-repository.test.mjs ("migration 002 rollback
-- returns the database to the 001 baseline").
--
-- Extract and run with:
--   grep '^--! ' database/postgres/002_learning_and_signals.sql \
--     | sed 's/^--! \{0,1\}//' | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
--
-- Data loss is total and intended: every row in the eight tables below is
-- discarded. Before rolling back a database that has served traffic, export
-- them (README-migration.md, "Rollback"). Nothing in 001 loses a row — the
-- policy, function, role, indexes and grants added to 001's tables are the only
-- things reverted there.
-- ===========================================================================
--! BEGIN;
--!
--! -- Reverse dependency order.
--! DROP TABLE IF EXISTS osa.notifications;
--! DROP TABLE IF EXISTS osa.signal_skills;
--! DROP TABLE IF EXISTS osa.signal_job_roles;
--! DROP TABLE IF EXISTS osa.signals;
--! DROP TABLE IF EXISTS osa.module_completions;
--! DROP TABLE IF EXISTS osa.enrollments;
--! DROP TABLE IF EXISTS osa.course_modules;
--! DROP TABLE IF EXISTS osa.courses;
--!
--! DROP TYPE IF EXISTS osa.severity;
--!
--! -- Indexes added to 001 tables.
--! DROP INDEX IF EXISTS osa.audit_tenant_sequence;
--! DROP INDEX IF EXISTS osa.evidence_expiry;
--! DROP INDEX IF EXISTS osa.interventions_due;
--!
--! -- Session resolution path. Privileges are revoked before the role is
--! -- dropped: DROP ROLE fails while a role still holds a grant anywhere.
--! DROP FUNCTION IF EXISTS osa.resolve_session(bytea);
--! DROP POLICY IF EXISTS session_resolution ON osa.sessions;
--! DO $resolver_revoke$
--! BEGIN
--!   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ik_osa_session_resolver') THEN
--!     REVOKE ALL ON ALL TABLES IN SCHEMA osa FROM ik_osa_session_resolver;
--!     REVOKE ALL ON SCHEMA osa FROM ik_osa_session_resolver;
--!   END IF;
--! END $resolver_revoke$;
--!
--! -- Privileges granted in section 7. Revoked before the role is dropped so a
--! -- re-run of 002 re-grants from a known-empty state.
--! DO $revoke$
--! DECLARE
--!   app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
--! BEGIN
--!   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
--!     EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA osa FROM %I', app_role);
--!     EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA osa FROM %I', app_role);
--!     EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA osa FROM %I', app_role);
--!     EXECUTE format('REVOKE USAGE ON SCHEMA osa FROM %I', app_role);
--!   END IF;
--! END $revoke$;
--!
--! -- The resolver role is dropped last: DROP ROLE fails while it owns anything.
--! DROP ROLE IF EXISTS ik_osa_session_resolver;
--!
--! COMMIT;
