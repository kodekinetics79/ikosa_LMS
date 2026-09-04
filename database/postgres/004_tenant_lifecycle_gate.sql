-- iK / Project NOVA — migration 004: tenant lifecycle gate.
--
-- Managed tenant state is a security boundary, not a decorative platform flag.
-- The normal tenant runtime must not be able to keep reading/writing data after
-- a platform owner suspends the tenant or its trial expires. Enforcement lives
-- in RLS so every existing and future route inherits it automatically.
--
-- Backward compatibility: tenants with no osa.tenant_control row are considered
-- unmanaged and remain enabled during the control-plane rollout.
--
-- Role-specific EXECUTE grants are intentionally provisioned out-of-band. They
-- depend on deployment role names and credentials and do not belong in a schema
-- migration. See docs/CONTROL_PLANE_PROVISIONING.md.

BEGIN;

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

CREATE OR REPLACE FUNCTION osa.revoke_tenant_sessions(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = osa, pg_catalog
AS $$
  WITH deleted AS (
    DELETE FROM osa.sessions
     WHERE tenant_id = p_tenant_id
    RETURNING 1
  )
  SELECT count(*)::bigint FROM deleted
$$;

REVOKE ALL ON FUNCTION osa.runtime_tenant_control() FROM PUBLIC;
REVOKE ALL ON FUNCTION osa.revoke_tenant_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION osa.tenant_runtime_enabled() TO PUBLIC;

-- Strengthen the policies explicitly rather than dynamically. This is verbose
-- on purpose: managed Postgres migration runners often split or reject DO blocks
-- containing nested dollar quotes, and release migrations must be portable.
ALTER POLICY tenant_isolation ON osa.org_units USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.users USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.user_roles USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.sessions USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.job_roles USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.skills USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.requirements USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.tna_studies USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.tna_target_roles USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.evidence USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.gap_cases USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.interventions USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.audit_events USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.courses USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.course_modules USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.enrollments USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.module_completions USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.signals USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.signal_job_roles USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.signal_skills USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER POLICY tenant_isolation ON osa.notifications USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());

COMMIT;

-- ROLLBACK is intentionally documented, not auto-executed.
-- Restore each tenant_isolation policy to:
--   USING (tenant_id = osa.current_tenant_id())
--   WITH CHECK (tenant_id = osa.current_tenant_id())
-- then drop osa.revoke_tenant_sessions(uuid), osa.runtime_tenant_control(), and
-- osa.tenant_runtime_enabled().
