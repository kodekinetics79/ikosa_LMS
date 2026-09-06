-- iK / Project NOVA — migration 009: scheduled sessions, attendance, and catalog listing.
-- Baseline: migrations 001-008.
--
-- SCOPE, STATED HONESTLY
--
-- This adds the parts of "live learning" and "marketplace" that are real without
-- a vendor: a scheduled session, who was expected, who actually attended and for
-- how long, and whether a course is listed for discovery beyond its own
-- organization.
--
-- It does NOT add a video provider. `provider` records which system a session is
-- held in and `join_url` records where; nothing here creates a meeting, issues a
-- token, or reads a provider's attendance report. Until an integration exists,
-- 'manual' is the only honest value and attendance is recorded by a person.
-- The column exists so that integration is a row-level change rather than a
-- schema migration under live data.
--
-- It also does NOT add payments. `list_price_cents` records what a listed course
-- asks for so a catalogue can display it; there is no order, no ledger, no
-- payout and no charge anywhere in this schema. A price is not a transaction.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Scheduled sessions
-- ---------------------------------------------------------------------------

CREATE TABLE osa.live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  course_id uuid NULL,
  -- The course module this session delivers, when it is part of a course.
  -- A standalone session (a briefing, a workshop) has neither.
  module_id uuid NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Who is running it. Nullable because a session may be scheduled before the
  -- instructor is assigned.
  instructor_user_id uuid NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- IANA name, stored so a session reads correctly for a distributed cohort
  -- rather than in whoever-created-it's local time.
  time_zone text NOT NULL DEFAULT 'UTC',
  -- 'manual' means a human records who attended. Every other value names a
  -- provider that is NOT integrated yet; the CHECK deliberately admits only
  -- 'manual' so nothing can claim an integration that does not exist.
  provider text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual')),
  join_url text NOT NULL DEFAULT '',
  capacity integer NULL CHECK (capacity IS NULL OR capacity > 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','cancelled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A session that ends before it starts is a data-entry error, not a state.
  CHECK (ends_at > starts_at),
  -- A module link only means anything alongside its course.
  CHECK ((module_id IS NULL) OR (course_id IS NOT NULL)),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,course_id) REFERENCES osa.courses(tenant_id,id),
  FOREIGN KEY (tenant_id,module_id) REFERENCES osa.course_modules(tenant_id,id),
  FOREIGN KEY (tenant_id,instructor_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES osa.users(tenant_id,id)
);

-- ---------------------------------------------------------------------------
-- 2. Attendance
--
-- One row per person per session. `registered` is an expectation; the rest are
-- observations. `minutes_attended` is stored rather than derived from
-- joined/left because a manually recorded attendance has no timestamps at all,
-- and a derived column would report 0 for a session somebody sat through.
-- ---------------------------------------------------------------------------

CREATE TABLE osa.session_attendance (
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  session_id uuid NOT NULL,
  subject_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered','attended','partial','absent','excused')),
  joined_at timestamptz NULL,
  left_at timestamptz NULL,
  minutes_attended integer NOT NULL DEFAULT 0 CHECK (minutes_attended >= 0),
  note text NOT NULL DEFAULT '',
  -- Null while the row is only a registration. Set the moment a human states
  -- what actually happened, which is what makes this an attendance record
  -- rather than a sign-up list.
  recorded_by uuid NULL,
  recorded_at timestamptz NULL,
  PRIMARY KEY (tenant_id,session_id,subject_user_id),
  CHECK (left_at IS NULL OR joined_at IS NULL OR left_at >= joined_at),
  -- An observation must name who made it. A "attended" nobody signed is not
  -- evidence of anything.
  CHECK (status = 'registered' OR recorded_by IS NOT NULL),
  FOREIGN KEY (tenant_id,session_id) REFERENCES osa.live_sessions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,recorded_by) REFERENCES osa.users(tenant_id,id)
);

-- ---------------------------------------------------------------------------
-- 3. Catalogue listing
--
-- Discovery, not commerce. `visibility` decides who may find a course beyond
-- the organization that owns it; `list_price_cents` is a displayed asking price
-- and nothing in this schema can take money.
-- ---------------------------------------------------------------------------

ALTER TABLE osa.courses
  ADD COLUMN visibility text NOT NULL DEFAULT 'organization'
    CHECK (visibility IN ('organization','tenant','listed')),
  ADD COLUMN summary text NOT NULL DEFAULT '',
  ADD COLUMN instructor_user_id uuid NULL,
  ADD COLUMN list_price_cents integer NULL CHECK (list_price_cents IS NULL OR list_price_cents >= 0),
  ADD COLUMN currency text NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

ALTER TABLE osa.courses
  ADD CONSTRAINT courses_instructor_fk
  FOREIGN KEY (tenant_id,instructor_user_id) REFERENCES osa.users(tenant_id,id);

-- A price without a currency is a number nobody can act on.
ALTER TABLE osa.courses
  ADD CONSTRAINT courses_price_needs_currency
  CHECK ((list_price_cents IS NULL) = (currency IS NULL));

CREATE INDEX live_sessions_when ON osa.live_sessions(tenant_id,starts_at,status);
CREATE INDEX live_sessions_course ON osa.live_sessions(tenant_id,course_id) WHERE course_id IS NOT NULL;
CREATE INDEX live_sessions_instructor ON osa.live_sessions(tenant_id,instructor_user_id) WHERE instructor_user_id IS NOT NULL;
CREATE INDEX session_attendance_subject ON osa.session_attendance(tenant_id,subject_user_id,status);
CREATE INDEX courses_listed ON osa.courses(tenant_id,visibility,status) WHERE visibility <> 'organization';

-- Same lifecycle-aware tenant isolation as every table since migration 004.
ALTER TABLE osa.live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.live_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.live_sessions USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.session_attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.session_attendance USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());

-- Runtime grants, in the migration rather than "out-of-band" — which is the
-- mistake migration 005 made and 007 had to repair.
DO $grants$
DECLARE
  app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'Runtime role % does not exist; skipping grants.', app_role;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'Runtime role % has BYPASSRLS or is a superuser. ADR-001 lists this as a release blocker.', app_role;
  END IF;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.live_sessions TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON osa.session_attendance TO %I', app_role);
END $grants$;

COMMIT;

-- ===========================================================================
-- ROLLBACK
--   grep '^--! ' database/postgres/009_live_sessions_and_catalog.sql \
--     | sed 's/^--! \{0,1\}//' | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
--
--! BEGIN;
--! DROP TABLE IF EXISTS osa.session_attendance;
--! DROP TABLE IF EXISTS osa.live_sessions;
--! DROP INDEX IF EXISTS osa.courses_listed;
--! ALTER TABLE osa.courses DROP CONSTRAINT IF EXISTS courses_price_needs_currency;
--! ALTER TABLE osa.courses DROP CONSTRAINT IF EXISTS courses_instructor_fk;
--! ALTER TABLE osa.courses DROP COLUMN IF EXISTS currency, DROP COLUMN IF EXISTS list_price_cents,
--!   DROP COLUMN IF EXISTS instructor_user_id, DROP COLUMN IF EXISTS summary, DROP COLUMN IF EXISTS visibility;
--! COMMIT;
