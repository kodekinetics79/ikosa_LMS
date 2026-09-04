-- iK / Project NOVA — migration 004: tenant lifecycle gate.
--
-- Managed tenant state is a security boundary, not a decorative platform flag.
-- The normal tenant runtime must not be able to keep reading/writing data after
-- a platform owner suspends the tenant or its trial expires. Enforcement lives
-- in RLS so every existing and future route inherits it automatically.
--
-- Backward compatibility: tenants with no osa.tenant_control row are considered
-- unmanaged and remain enabled during the control-plane rollout.

BEGIN;

-- Narrow commercial-state reader for the tenant already established through
-- app.tenant_id. The runtime receives no SELECT privilege on the global
-- osa.tenant_control portfolio.
CREATE OR REPLACE FUNCTION osa.runtime_tenant_control()
RETURNS TABLE (
  state text,
  trial_ends_at timestamptz,
  enabled_modules text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = osa, pg_catalog
AS $$
  SELECT c.state, c.trial_ends_at, c.enabled_modules
    FROM osa.tenant_control c
   WHERE c.tenant_id = osa.current_tenant_id()
$$;

-- Boolean gate used by every tenant RLS policy. No control row means legacy /
-- unmanaged and therefore allowed. Managed tenants are allowed only while
-- active, or during an unexpired trial.
CREATE OR REPLACE FUNCTION osa.tenant_runtime_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = osa, pg_catalog
AS $$
  SELECT coalesce(
    (
      SELECT CASE
        WHEN c.state = 'active' THEN true
        WHEN c.state = 'trial' AND (c.trial_ends_at IS NULL OR c.trial_ends_at > now()) THEN true
        ELSE false
      END
      FROM osa.tenant_control c
      WHERE c.tenant_id = osa.current_tenant_id()
    ),
    true
  )
$$;

-- Keep the detail function private to known application roles. The boolean gate
-- is invoked from RLS policies themselves and is safe to execute with no input:
-- it exposes only whether the caller's already-established tenant may run.
REVOKE ALL ON FUNCTION osa.runtime_tenant_control() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osa.tenant_runtime_enabled() TO PUBLIC;

DO $grant_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ik_osa_app') THEN
    GRANT EXECUTE ON FUNCTION osa.runtime_tenant_control() TO ik_osa_app;
  END IF;
END $grant_runtime$;

-- Strengthen every existing tenant policy. The session resolver keeps its own
-- dedicated SELECT-only escape policy on osa.sessions; normal runtime traffic
-- still passes through tenant_isolation and therefore this lifecycle gate.
DO $lifecycle_rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_units','users','user_roles','sessions','job_roles','skills','requirements',
    'tna_studies','tna_target_roles','evidence','gap_cases','interventions','audit_events',
    'courses','course_modules','enrollments','module_completions','signals',
    'signal_job_roles','signal_skills','notifications'
  ]
  LOOP
    EXECUTE format(
      'ALTER POLICY tenant_isolation ON osa.%I USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled())',
      t
    );
  END LOOP;
END $lifecycle_rls$;

COMMIT;

-- ROLLBACK
--! BEGIN;
--! DO $rollback_rls$
--! DECLARE t text;
--! BEGIN
--!   FOREACH t IN ARRAY ARRAY[
--!     'org_units','users','user_roles','sessions','job_roles','skills','requirements',
--!     'tna_studies','tna_target_roles','evidence','gap_cases','interventions','audit_events',
--!     'courses','course_modules','enrollments','module_completions','signals',
--!     'signal_job_roles','signal_skills','notifications'
--!   ]
--!   LOOP
--!     EXECUTE format(
--!       'ALTER POLICY tenant_isolation ON osa.%I USING (tenant_id = osa.current_tenant_id()) WITH CHECK (tenant_id = osa.current_tenant_id())',
--!       t
--!     );
--!   END LOOP;
--! END $rollback_rls$;
--! DROP FUNCTION IF EXISTS osa.runtime_tenant_control();
--! DROP FUNCTION IF EXISTS osa.tenant_runtime_enabled();
--! COMMIT;
