-- Project NOVA — migration 006: assessment attempt concurrency invariant.
-- Baseline: 005_assessment_engine.sql.
--
-- Application code resumes an existing in-progress attempt, but two simultaneous
-- start requests can both observe none before either inserts. Make duplicate
-- active attempts structurally impossible in PostgreSQL.

BEGIN;

CREATE UNIQUE INDEX assessment_attempts_one_in_progress
  ON osa.assessment_attempts (tenant_id, assessment_id, subject_user_id)
  WHERE status = 'in_progress';

COMMIT;

-- ROLLBACK
--! DROP INDEX IF EXISTS osa.assessment_attempts_one_in_progress;
