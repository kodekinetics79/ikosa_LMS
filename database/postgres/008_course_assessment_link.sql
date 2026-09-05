-- iK / Project NOVA — migration 008: the course module ↔ assessment link.
-- Baseline: migrations 001-007.
--
-- WHY THIS COLUMN EXISTS
--
-- The product has two halves that had no connection at all. `osa.course_modules`
-- carries a `kind` of 'assessment' but no payload of any sort — no url, no
-- assessment id, nothing — so an "assessment" module was a label, and the
-- learner recorded their own score by typing a number into a free-text field.
-- Meanwhile the assessment engine graded real attempts against real answer keys
-- and its results reached nothing.
--
-- `osa.assessments.course_id` already existed but points at the COURSE, which is
-- not enough: a course may legitimately have several assessment modules (a
-- practical, a written paper, an end-of-module quiz) and completion has to know
-- WHICH module an attempt satisfies. `recordModuleCompletion` — the single
-- authority that decides whether a completion emits competence evidence — takes
-- a module id.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not add a second evidence engine, a second completion rule, or a
-- second answer to "is this person competent". It adds one nullable column so
-- the existing authority can be called with the module it already needed.
-- Whether evidence is emitted stays entirely inside
-- src/lib/server/learning.ts::recordModuleCompletion: an attendance-only course
-- still emits nothing, and a failed assessment still emits nothing.

BEGIN;

ALTER TABLE osa.course_modules
  ADD COLUMN assessment_id uuid NULL;

-- Tenant-qualified, like every other foreign key in this schema: a bare
-- REFERENCES osa.assessments(id) would let a module in one tenant point at an
-- assessment in another, and RLS would then hide the target rather than reject
-- the reference.
ALTER TABLE osa.course_modules
  ADD CONSTRAINT course_modules_assessment_fk
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES osa.assessments(tenant_id, id);

-- A link only means anything on an assessment module. Allowing it on a lesson
-- would create a row whose `kind` and whose payload disagree, and every reader
-- would then need to decide which one to believe.
ALTER TABLE osa.course_modules
  ADD CONSTRAINT course_modules_assessment_kind
  CHECK (assessment_id IS NULL OR kind = 'assessment');

-- One assessment backs at most one module. Without this, a single passing
-- attempt would satisfy two modules of the same course and count twice towards
-- completion — the course would be finished by doing half of it.
CREATE UNIQUE INDEX course_modules_assessment_unique
  ON osa.course_modules (tenant_id, assessment_id)
  WHERE assessment_id IS NOT NULL;

-- The lookup the submit and grading paths perform on every finalized attempt:
-- "which module, if any, does this assessment satisfy".
CREATE INDEX course_modules_by_assessment
  ON osa.course_modules (tenant_id, assessment_id)
  WHERE assessment_id IS NOT NULL;

COMMIT;


-- ===========================================================================
-- VERIFICATION
--
--   \d osa.course_modules
--   -- assessment_id uuid, NULL allowed
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'osa.course_modules'::regclass
--      AND conname IN ('course_modules_assessment_fk','course_modules_assessment_kind');
--   -- both present
--
--   -- The kind check bites:
--   UPDATE osa.course_modules SET assessment_id = gen_random_uuid() WHERE kind = 'lesson';
--   -- ERROR:  new row violates check constraint "course_modules_assessment_kind"
--
-- Existing rows are untouched: the column is nullable with no default, so every
-- course module written before this migration keeps behaving exactly as it did.
--
-- ===========================================================================
-- ROLLBACK
--
-- Extract and run with:
--   grep '^--! ' database/postgres/008_course_assessment_link.sql \
--     | sed 's/^--! \{0,1\}//' | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
--
--! BEGIN;
--! DROP INDEX IF EXISTS osa.course_modules_by_assessment;
--! DROP INDEX IF EXISTS osa.course_modules_assessment_unique;
--! ALTER TABLE osa.course_modules DROP CONSTRAINT IF EXISTS course_modules_assessment_kind;
--! ALTER TABLE osa.course_modules DROP CONSTRAINT IF EXISTS course_modules_assessment_fk;
--! ALTER TABLE osa.course_modules DROP COLUMN IF EXISTS assessment_id;
--! COMMIT;
