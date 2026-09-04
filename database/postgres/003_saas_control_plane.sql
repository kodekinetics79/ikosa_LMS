-- iK / Project NOVA — migration 003: SaaS control plane.
--
-- This migration deliberately keeps cross-tenant SaaS administration OUTSIDE
-- the tenant runtime connection. The application must use a dedicated
-- CONTROL_PLANE_DATABASE_URL whose role is provisioned with the grants below.
-- That role remains NOSUPERUSER/NOBYPASSRLS and owns no tenant table. Tenant
-- creation works by inserting the global tenant row first, then setting
-- app.tenant_id inside the same transaction before touching forced-RLS tables.

BEGIN;

CREATE TABLE osa.platform_operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NULL
);

CREATE TABLE osa.platform_sessions (
  id_hash bytea PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES osa.platform_operators(id) ON DELETE CASCADE,
  csrf_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL
);
CREATE INDEX platform_sessions_operator ON osa.platform_sessions(operator_id, expires_at DESC);

CREATE TABLE osa.tenant_control (
  tenant_id uuid PRIMARY KEY REFERENCES osa.tenants(id) ON DELETE CASCADE,
  tenant_kind text NOT NULL CHECK (tenant_kind IN ('education','corporate','training_provider','ngo')),
  state text NOT NULL CHECK (state IN ('trial','active','suspended')) DEFAULT 'trial',
  plan_code text NOT NULL,
  seat_limit integer NOT NULL CHECK (seat_limit > 0),
  storage_gb integer NOT NULL CHECK (storage_gb > 0),
  ai_monthly_credits integer NOT NULL DEFAULT 0 CHECK (ai_monthly_credits >= 0),
  enabled_modules text[] NOT NULL DEFAULT ARRAY['learn','assess']::text[],
  trial_ends_at timestamptz NULL,
  contract_ends_at timestamptz NULL,
  custom_domain text NULL,
  brand_name text NULL,
  created_by_operator_id uuid NOT NULL REFERENCES osa.platform_operators(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (array_length(enabled_modules, 1) >= 1),
  CHECK (enabled_modules <@ ARRAY['learn','assess','live','ai','skills','tna','evidence','credentials','insights']::text[])
);
CREATE INDEX tenant_control_state ON osa.tenant_control(state, plan_code);

CREATE TABLE osa.platform_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  operator_id uuid NULL REFERENCES osa.platform_operators(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','failure','allowed','denied')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_time ON osa.platform_audit_events(occurred_at DESC);

CREATE FUNCTION osa.prevent_platform_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'platform_audit_events are append-only'; END $$;
CREATE TRIGGER platform_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON osa.platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION osa.prevent_platform_audit_mutation();

-- Existing demo tenants pre-date the control plane. Register them so the new
-- dashboard can show them without inventing commercial history.
DO $backfill$
DECLARE bootstrap_operator uuid;
BEGIN
  SELECT id INTO bootstrap_operator FROM osa.platform_operators ORDER BY created_at LIMIT 1;
  -- No operator normally exists at migration time; the app bootstrap inserts
  -- one at first platform login. Therefore no tenant_control rows are created
  -- here. Existing tenants remain intentionally absent until claimed by the
  -- owner, and list queries only expose managed tenants.
  PERFORM bootstrap_operator;
END $backfill$;

-- Dedicated control-plane role grants. The login role itself is provisioned
-- outside version control because its password belongs in secret storage.
-- Before running this migration, optionally set:
--   SET osa.control_plane_role = 'ik_osa_control_plane';
-- The default is ik_osa_control_plane.
DO $control_grants$
DECLARE
  control_role text := coalesce(nullif(current_setting('osa.control_plane_role', true), ''), 'ik_osa_control_plane');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = control_role) THEN
    RAISE NOTICE 'Control-plane role % does not exist; skipping grants. Provision it and re-run this grant block.', control_role;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = control_role AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Control-plane role % must be NOSUPERUSER and NOBYPASSRLS.', control_role;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA osa TO %I', control_role);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA osa TO %I', control_role);

  -- Global control-plane records.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.platform_operators TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON osa.platform_sessions TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.tenant_control TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT ON osa.platform_audit_events TO %I', control_role);

  -- Tenant provisioning. Forced RLS remains in force for the tenant tables;
  -- callers must SET LOCAL app.tenant_id to the newly created tenant.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.tenants TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.org_units TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.users TO %I', control_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON osa.user_roles TO %I', control_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION osa.current_tenant_id() TO %I', control_role);
END $control_grants$;

COMMIT;

-- ROLLBACK (destructive; export control-plane records first)
--! BEGIN;
--! DROP TRIGGER IF EXISTS platform_audit_no_update_delete ON osa.platform_audit_events;
--! DROP FUNCTION IF EXISTS osa.prevent_platform_audit_mutation();
--! DROP TABLE IF EXISTS osa.platform_audit_events;
--! DROP TABLE IF EXISTS osa.tenant_control;
--! DROP TABLE IF EXISTS osa.platform_sessions;
--! DROP TABLE IF EXISTS osa.platform_operators;
--! COMMIT;
