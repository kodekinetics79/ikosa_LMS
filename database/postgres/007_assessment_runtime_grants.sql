-- iK / Project NOVA — migration 007: assessment engine runtime grants.
-- Baseline: migrations 001-006.
--
-- WHY THIS EXISTS
--
-- 005_assessment_engine.sql creates nine tables and ends with a comment saying
-- runtime grants are "intentionally provisioned out-of-band after migration".
-- Nothing then provisioned them. On a database migrated exactly as documented,
-- `ik_osa_app` holds no privilege at all on any assessment table:
--
--   SELECT has_table_privilege('ik_osa_app','osa.assessments','SELECT');  -- f
--
-- So every authoring, attempt and grading request fails with "permission denied
-- for table assessments" the moment the application connects as the role
-- ADR-001 requires it to use. Any rehearsal that appeared to work was run as a
-- privileged role, which also silently bypasses the tenant_isolation policies
-- the same rehearsal was meant to prove.
--
-- Grants belong in a migration for the same reason the 001-004 grants do: a
-- privilege that only exists because someone remembered to type it is a
-- privilege that will be missing on the next environment.
--
-- The matrix is the one 005 describes, and no wider:
--   * SELECT, INSERT, UPDATE on the nine tables — authoring, delivery, grading
--   * DELETE only on osa.assessment_items and osa.rubric_scores, the two places
--     where re-authoring genuinely replaces rows rather than superseding them
--   * no DELETE on attempts, responses, questions or banks: a learner's
--     submitted work and its grading history are evidence, and retirement is a
--     status change

BEGIN;

-- >>> GRANTS BEGIN  (extractable: see README-migration.md, "Provision the runtime role")
DO $grants$
DECLARE
  app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'Runtime role % does not exist; skipping assessment grants. Provision it, then re-run migration 007.', app_role;
    RETURN;
  END IF;

  -- Same two release blockers migration 002 checks. A role that bypasses RLS
  -- would read every tenant's question banks and answer keys.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND rolbypassrls) THEN
    RAISE EXCEPTION 'Runtime role % has BYPASSRLS. ADR-001 lists this as a release blocker.', app_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND rolsuper) THEN
    RAISE EXCEPTION 'Runtime role % is a superuser. ADR-001 lists this as a release blocker.', app_role;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'rubrics','rubric_criteria','question_banks','assessment_questions',
    'assessments','assessment_items','assessment_attempts',
    'assessment_responses','rubric_scores']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.%I TO %I', t, app_role);
  END LOOP;

  -- Re-authoring an assessment replaces its item rows; re-marking against a
  -- rubric replaces its criterion scores. Everything else is superseded, never
  -- removed.
  EXECUTE format('GRANT DELETE ON osa.assessment_items, osa.rubric_scores TO %I', app_role);

  -- 005 uses uuid primary keys throughout, so there is nothing sequence-backed
  -- to grant today. Granting anyway keeps the statement correct if a later
  -- assessment table introduces an identity column.
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO %I', app_role);
END $grants$;
-- >>> GRANTS END

COMMIT;


-- ===========================================================================
-- VERIFICATION
--
--   SELECT c.relname,
--          has_table_privilege('ik_osa_app','osa.'||quote_ident(c.relname),'SELECT') AS sel,
--          has_table_privilege('ik_osa_app','osa.'||quote_ident(c.relname),'INSERT') AS ins,
--          has_table_privilege('ik_osa_app','osa.'||quote_ident(c.relname),'UPDATE') AS upd,
--          has_table_privilege('ik_osa_app','osa.'||quote_ident(c.relname),'DELETE') AS del
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'osa' AND c.relkind = 'r'
--      AND c.relname LIKE ANY (ARRAY['assessment%','question_banks','rubric%'])
--    ORDER BY 1;
--
-- Expected: sel/ins/upd true for all nine; del true only for assessment_items
-- and rubric_scores.
--
-- ===========================================================================
-- ROLLBACK
--
-- Extract and run with:
--   grep '^--! ' database/postgres/007_assessment_runtime_grants.sql \
--     | sed 's/^--! \{0,1\}//' | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
--
--! BEGIN;
--! DO $rollback$
--! DECLARE
--!   app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
--!   t text;
--! BEGIN
--!   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN RETURN; END IF;
--!   FOREACH t IN ARRAY ARRAY[
--!     'rubrics','rubric_criteria','question_banks','assessment_questions',
--!     'assessments','assessment_items','assessment_attempts',
--!     'assessment_responses','rubric_scores']
--!   LOOP
--!     EXECUTE format('REVOKE ALL ON osa.%I FROM %I', t, app_role);
--!   END LOOP;
--! END $rollback$;
--! COMMIT;
