-- iK / Project NOVA — migration 003: SaaS control plane.
--
-- This migration creates GLOBAL SaaS control-plane state only. It deliberately
-- does not create login roles or embed credentials. Provision the dedicated
-- `ik_osa_control_plane` login role out-of-band and grant the narrow privileges
-- documented in docs/CONTROL_PLANE_PROVISIONING.md.
--
-- Tenant runtime remains separate and NOBYPASSRLS. Tenant creation inserts the
-- global tenant row first, then sets app.tenant_id inside the same transaction
-- before writing org_units/users/user_roles, so forced RLS remains effective.

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

CREATE FUNCTION osa.prevent_platform_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN RAISE EXCEPTION ''platform_audit_events are append-only''; END';

CREATE TRIGGER platform_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON osa.platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION osa.prevent_platform_audit_mutation();

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
