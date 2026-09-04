-- iK / Project NOVA — migration 004: tenant lifecycle gate.
--
-- The tenant runtime must know whether its own managed tenant is active without
-- gaining SELECT access to the global commercial portfolio. This SECURITY
-- DEFINER function exposes exactly one row: the control state for the tenant
-- already established in app.tenant_id. Existing/unmanaged tenants return no
-- row and remain backward-compatible during the control-plane rollout.

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

REVOKE ALL ON FUNCTION osa.runtime_tenant_control() FROM PUBLIC;

DO $grant_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ik_osa_app') THEN
    GRANT EXECUTE ON FUNCTION osa.runtime_tenant_control() TO ik_osa_app;
  END IF;
END $grant_runtime$;

COMMIT;

-- ROLLBACK
--! BEGIN;
--! DROP FUNCTION IF EXISTS osa.runtime_tenant_control();
--! COMMIT;
