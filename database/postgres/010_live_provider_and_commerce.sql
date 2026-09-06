-- iK / Project NOVA — migration 010: a real live-class provider, and commerce.
-- Baseline: migrations 001-009.
--
-- WHAT CHANGED SINCE 009, AND WHY
--
-- 009 constrained `provider` to 'manual' because no integration existed and a
-- column that admits a value nothing implements is a claim the code cannot keep.
-- Jitsi needs no account, no OAuth app and no API key: a room is a URL, and the
-- instance is self-hostable. So 'jitsi' becomes a value the product actually
-- honours, and the CHECK widens by exactly one.
--
-- Zoom and Teams stay out. Both need a registered OAuth application and tenant
-- credentials, and adding them to this CHECK before an adapter exists would put
-- the schema back to describing capability the code does not have.
--
-- COMMERCE, HONESTLY SCOPED
--
-- 009 added a displayed asking price and said plainly that a price is not a
-- transaction. This adds the transaction — for the settlement method that needs
-- no payment processor: an invoice. A corporate customer is invoiced and pays
-- out of band; the platform records what was ordered, what it was worth, and
-- what access it granted.
--
-- `settlement` admits 'invoice' and 'free' only. Card payment needs a processor
-- and a merchant account, so 'card' is deliberately absent for the same reason
-- 'zoom' is: the schema must not offer a route the code cannot walk.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Live provider
-- ---------------------------------------------------------------------------

ALTER TABLE osa.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_provider_check;
ALTER TABLE osa.live_sessions
  ADD CONSTRAINT live_sessions_provider_check CHECK (provider IN ('manual','jitsi'));

-- The room the provider hosts this session in. Derived from the session id
-- through a keyed digest rather than being the id itself: a room name is
-- effectively a bearer token on a public instance, and a predictable one lets
-- anybody who can guess a uuid walk into a live exam briefing.
ALTER TABLE osa.live_sessions ADD COLUMN provider_room text NOT NULL DEFAULT '';

-- A provider-backed session must have a room, and a manual one must not pretend
-- to have one.
ALTER TABLE osa.live_sessions
  ADD CONSTRAINT live_sessions_room_matches_provider
  CHECK ((provider = 'manual' AND provider_room = '') OR (provider <> 'manual' AND provider_room <> ''));

-- Who said this person attended: a human taking a register, or the provider
-- reporting it. The distinction is load-bearing — provider-reported presence is
-- a client-side signal and must never silently become the same kind of fact as
-- an assessor's observation.
ALTER TABLE osa.session_attendance
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','provider'));

-- ---------------------------------------------------------------------------
-- 2. Commerce — orders and entitlements
--
-- An order records what was bought and for whom. An entitlement records what
-- access it granted, separately, because access outlives the order: a refund
-- revokes the entitlement without deleting the record that money was owed.
-- ---------------------------------------------------------------------------

CREATE TABLE osa.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  course_id uuid NOT NULL,
  -- Who it is FOR. Null for a bulk seat purchase that is assigned later.
  subject_user_id uuid NULL,
  -- Who placed it. Always a person.
  ordered_by uuid NOT NULL,
  seats integer NOT NULL DEFAULT 1 CHECK (seats > 0),
  -- Captured at order time, not read from the course. A course's asking price
  -- may change; what this customer was told they owed may not.
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  -- 'free' settles immediately; 'invoice' is settled out of band by a human
  -- marking it paid. No card: that needs a processor and a merchant account.
  settlement text NOT NULL CHECK (settlement IN ('free','invoice')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','cancelled','refunded')),
  reference text NOT NULL DEFAULT '',
  placed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  settled_by uuid NULL,
  -- A free order is never pending: there is nothing to settle.
  CHECK (settlement <> 'free' OR status <> 'pending'),
  -- Money moved, so somebody has to have said so.
  CHECK (status <> 'paid' OR settled_by IS NOT NULL),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,course_id) REFERENCES osa.courses(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,ordered_by) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,settled_by) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.course_entitlements (
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  course_id uuid NOT NULL,
  subject_user_id uuid NOT NULL,
  order_id uuid NULL,
  -- 'granted' by an administrator directly, or 'purchased' via an order.
  origin text NOT NULL CHECK (origin IN ('granted','purchased')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid NOT NULL,
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id,course_id,subject_user_id),
  -- A revocation without a reason is an unexplained loss of access.
  CHECK (revoked_at IS NULL OR revoked_reason <> ''),
  CHECK (origin <> 'purchased' OR order_id IS NOT NULL),
  FOREIGN KEY (tenant_id,course_id) REFERENCES osa.courses(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES osa.orders(tenant_id,id),
  FOREIGN KEY (tenant_id,granted_by) REFERENCES osa.users(tenant_id,id)
);

CREATE INDEX orders_course ON osa.orders(tenant_id,course_id,status);
CREATE INDEX orders_outstanding ON osa.orders(tenant_id,status,placed_at) WHERE status = 'pending';
CREATE INDEX entitlements_subject ON osa.course_entitlements(tenant_id,subject_user_id) WHERE revoked_at IS NULL;

ALTER TABLE osa.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.orders USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.course_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.course_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.course_entitlements USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());

DO $grants$
DECLARE app_role text := coalesce(nullif(current_setting('osa.runtime_role', true), ''), 'ik_osa_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'Runtime role % does not exist; skipping grants.', app_role; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'Runtime role % has BYPASSRLS or is a superuser. ADR-001 lists this as a release blocker.', app_role;
  END IF;
  -- No DELETE on either: an order is a financial record and an entitlement is
  -- revoked, not erased.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.orders TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON osa.course_entitlements TO %I', app_role);
END $grants$;

COMMIT;

-- ===========================================================================
-- ROLLBACK
--! BEGIN;
--! DROP TABLE IF EXISTS osa.course_entitlements;
--! DROP TABLE IF EXISTS osa.orders;
--! ALTER TABLE osa.session_attendance DROP COLUMN IF EXISTS source;
--! ALTER TABLE osa.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_room_matches_provider;
--! ALTER TABLE osa.live_sessions DROP COLUMN IF EXISTS provider_room;
--! ALTER TABLE osa.live_sessions DROP CONSTRAINT IF EXISTS live_sessions_provider_check;
--! ALTER TABLE osa.live_sessions ADD CONSTRAINT live_sessions_provider_check CHECK (provider IN ('manual'));
--! COMMIT;
