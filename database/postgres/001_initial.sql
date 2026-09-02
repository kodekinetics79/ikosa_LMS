-- iK Operational Skills Assurance — production PostgreSQL 16+ baseline.
-- The application transaction MUST execute:
--   SET LOCAL app.tenant_id = '<authenticated tenant uuid>';
--   SET LOCAL app.user_id = '<authenticated user uuid>';
-- before accessing tenant data. Never derive these settings from request payloads.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS osa;
REVOKE ALL ON SCHEMA osa FROM PUBLIC;

CREATE TYPE osa.record_status AS ENUM ('draft','active','retired');
CREATE TYPE osa.gap_priority AS ENUM ('low','medium','high','critical');
CREATE TYPE osa.audit_outcome AS ENUM ('allowed','denied','success','failure');

CREATE TABLE osa.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  home_region text NOT NULL,
  locale text NOT NULL DEFAULT 'en-US',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE osa.org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  parent_id uuid NULL,
  code text NOT NULL,
  name text NOT NULL,
  path ltree NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code), UNIQUE (tenant_id, path),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES osa.org_units(tenant_id, id)
);

CREATE TABLE osa.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  email citext NOT NULL,
  display_name text NOT NULL,
  password_hash text NULL,
  active boolean NOT NULL DEFAULT true,
  delegated_org_paths ltree[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id, org_unit_id) REFERENCES osa.org_units(tenant_id, id)
);

CREATE TABLE osa.user_roles (
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  user_id uuid NOT NULL,
  role_code text NOT NULL CHECK (role_code IN ('tenant_admin','tna_analyst','manager','assessor','learner','auditor')),
  PRIMARY KEY (tenant_id, user_id, role_code),
  FOREIGN KEY (tenant_id, user_id) REFERENCES osa.users(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE osa.sessions (
  id_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  user_id uuid NOT NULL,
  csrf_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES osa.users(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE osa.job_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  code text NOT NULL, title text NOT NULL, purpose text NOT NULL, version integer NOT NULL CHECK (version > 0),
  status osa.record_status NOT NULL DEFAULT 'draft', valid_from timestamptz NOT NULL, valid_to timestamptz NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), recorded_by uuid NOT NULL,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,code,version),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,recorded_by) REFERENCES osa.users(tenant_id,id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE osa.skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  code text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', scale_code text NOT NULL DEFAULT 'awareness-to-expert',
  status osa.record_status NOT NULL DEFAULT 'active', version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,code,version)
);

CREATE TABLE osa.requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  job_role_id uuid NOT NULL, skill_id uuid NOT NULL, source_type text NOT NULL CHECK (source_type IN ('policy','regulation','risk','strategy','incident')),
  source_reference text NOT NULL, required_level smallint NOT NULL CHECK (required_level BETWEEN 0 AND 5),
  criticality text NOT NULL CHECK (criticality IN ('standard','important','mandatory')), version integer NOT NULL CHECK (version > 0),
  valid_from timestamptz NOT NULL, valid_to timestamptz NULL, recorded_at timestamptz NOT NULL DEFAULT now(), recorded_by uuid NOT NULL,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,job_role_id) REFERENCES osa.job_roles(tenant_id,id),
  FOREIGN KEY (tenant_id,skill_id) REFERENCES osa.skills(tenant_id,id),
  FOREIGN KEY (tenant_id,recorded_by) REFERENCES osa.users(tenant_id,id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE osa.tna_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  title text NOT NULL, objective text NOT NULL, status text NOT NULL CHECK (status IN ('draft','collecting','analysis','approved')),
  owner_user_id uuid NOT NULL, due_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.tna_target_roles (
  tenant_id uuid NOT NULL, tna_study_id uuid NOT NULL, job_role_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,tna_study_id,job_role_id),
  FOREIGN KEY (tenant_id,tna_study_id) REFERENCES osa.tna_studies(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,job_role_id) REFERENCES osa.job_roles(tenant_id,id)
);

CREATE TABLE osa.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  subject_user_id uuid NOT NULL, skill_id uuid NOT NULL, evidence_type text NOT NULL CHECK (evidence_type IN ('assessment','observation','work_product','credential')),
  proficiency_level smallint NOT NULL CHECK (proficiency_level BETWEEN 0 AND 5), strength numeric(4,3) NOT NULL CHECK (strength BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL, expires_at timestamptz NULL, assessor_user_id uuid NULL, source_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','verified','revoked')), content_digest bytea NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,skill_id) REFERENCES osa.skills(tenant_id,id),
  FOREIGN KEY (tenant_id,assessor_user_id) REFERENCES osa.users(tenant_id,id),
  CHECK (assessor_user_id IS NULL OR assessor_user_id <> subject_user_id), CHECK (expires_at IS NULL OR expires_at > observed_at)
);

CREATE TABLE osa.gap_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  tna_study_id uuid NOT NULL, subject_user_id uuid NOT NULL, requirement_id uuid NOT NULL,
  required_level smallint NOT NULL CHECK (required_level BETWEEN 0 AND 5), evidenced_level smallint NOT NULL CHECK (evidenced_level BETWEEN 0 AND 5),
  gap smallint GENERATED ALWAYS AS (greatest(required_level-evidenced_level,0)) STORED,
  priority osa.gap_priority NOT NULL, cause_hypothesis text NOT NULL DEFAULT '', status text NOT NULL CHECK (status IN ('open','triaged','actioned','verified')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,tna_study_id) REFERENCES osa.tna_studies(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,requirement_id) REFERENCES osa.requirements(tenant_id,id)
);

CREATE TABLE osa.interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), org_unit_id uuid NOT NULL,
  gap_case_id uuid NOT NULL, intervention_type text NOT NULL CHECK (intervention_type IN ('learning','coaching','job_aid','process','tooling','staffing')),
  title text NOT NULL, owner_user_id uuid NOT NULL, due_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','active','completed','verified')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,gap_case_id) REFERENCES osa.gap_cases(tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES osa.tenants(id), actor_user_id uuid NULL,
  action text NOT NULL, resource_type text NOT NULL, resource_id uuid NULL, outcome osa.audit_outcome NOT NULL,
  request_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_hash bytea NOT NULL, event_hash bytea NOT NULL,
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES osa.users(tenant_id,id)
);

CREATE INDEX org_units_path_gist ON osa.org_units USING gist(path);
CREATE INDEX requirements_role_skill ON osa.requirements(tenant_id,job_role_id,skill_id) WHERE valid_to IS NULL;
CREATE INDEX evidence_subject_skill ON osa.evidence(tenant_id,subject_user_id,skill_id,observed_at DESC);
CREATE INDEX gap_cases_priority ON osa.gap_cases(tenant_id,status,priority);
CREATE INDEX audit_tenant_time ON osa.audit_events(tenant_id,occurred_at DESC);

CREATE FUNCTION osa.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true),'')::uuid $$;

-- Defense in depth: RLS applies even when application predicates are accidentally omitted.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_units','users','user_roles','sessions','job_roles','skills','requirements','tna_studies','tna_target_roles','evidence','gap_cases','interventions','audit_events']
  LOOP
    EXECUTE format('ALTER TABLE osa.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osa.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON osa.%I USING (tenant_id = osa.current_tenant_id()) WITH CHECK (tenant_id = osa.current_tenant_id())', t);
  END LOOP;
END $rls$;

CREATE FUNCTION osa.prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON osa.audit_events FOR EACH ROW EXECUTE FUNCTION osa.prevent_audit_mutation();

-- The deployment role owns migrations. Runtime roles receive only required schema/table privileges;
-- production provisioning must not grant BYPASSRLS or table ownership to the application role.
COMMIT;
