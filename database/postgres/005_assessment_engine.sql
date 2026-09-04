-- iK / Project NOVA — migration 005: assessment & exam engine.
-- Baseline: migrations 001-004.
--
-- The assessment engine is evidence-producing infrastructure, not a quiz widget.
-- It separates authoring truth (banks/questions/answer keys), delivery truth
-- (attempts/responses) and grading truth (auto/manual/rubric scores). Answer keys
-- stay server-side and are never part of learner response payloads.

BEGIN;

-- Broaden tenant roles for education/training delivery without removing any
-- existing workforce role.
ALTER TABLE osa.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_code_check;
ALTER TABLE osa.user_roles ADD CONSTRAINT user_roles_role_code_check
  CHECK (role_code IN (
    'tenant_admin','learning_admin','instructor','tna_analyst','manager',
    'assessor','learner','auditor'
  ));

CREATE TABLE osa.rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.rubric_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  rubric_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  max_points numeric(8,2) NOT NULL CHECK (max_points > 0),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,rubric_id,position),
  FOREIGN KEY (tenant_id,rubric_id) REFERENCES osa.rubrics(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE osa.question_banks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.assessment_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  bank_id uuid NOT NULL,
  question_type text NOT NULL CHECK (question_type IN (
    'single_choice','multiple_choice','true_false','short_text','long_text',
    'numeric','matching','ordering'
  )),
  prompt text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_key jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text NOT NULL DEFAULT '',
  points numeric(8,2) NOT NULL DEFAULT 1 CHECK (points > 0),
  difficulty smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 5),
  bloom_level text NOT NULL DEFAULT 'understand' CHECK (bloom_level IN (
    'remember','understand','apply','analyze','evaluate','create'
  )),
  skill_id uuid NULL,
  rubric_id uuid NULL,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai','import')),
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','approved','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,bank_id) REFERENCES osa.question_banks(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,skill_id) REFERENCES osa.skills(tenant_id,id),
  FOREIGN KEY (tenant_id,rubric_id) REFERENCES osa.rubrics(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  org_unit_id uuid NOT NULL,
  course_id uuid NULL,
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assessment_type text NOT NULL DEFAULT 'quiz' CHECK (assessment_type IN ('quiz','exam','practice')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  duration_minutes integer NULL CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  pass_percentage numeric(5,2) NOT NULL DEFAULT 70 CHECK (pass_percentage BETWEEN 0 AND 100),
  attempt_limit integer NOT NULL DEFAULT 1 CHECK (attempt_limit > 0),
  shuffle_questions boolean NOT NULL DEFAULT false,
  shuffle_options boolean NOT NULL DEFAULT false,
  feedback_mode text NOT NULL DEFAULT 'after_submit' CHECK (feedback_mode IN ('immediate','after_submit','after_close')),
  opens_at timestamptz NULL,
  closes_at timestamptz NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,code),
  FOREIGN KEY (tenant_id,org_unit_id) REFERENCES osa.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,course_id) REFERENCES osa.courses(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES osa.users(tenant_id,id),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE osa.assessment_items (
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  assessment_id uuid NOT NULL,
  question_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  points_override numeric(8,2) NULL CHECK (points_override IS NULL OR points_override > 0),
  required boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,assessment_id,question_id),
  UNIQUE (tenant_id,assessment_id,position),
  FOREIGN KEY (tenant_id,assessment_id) REFERENCES osa.assessments(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,question_id) REFERENCES osa.assessment_questions(tenant_id,id)
);

CREATE TABLE osa.assessment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  assessment_id uuid NOT NULL,
  subject_user_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','graded','void')),
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL,
  graded_at timestamptz NULL,
  score_points numeric(10,2) NULL CHECK (score_points IS NULL OR score_points >= 0),
  max_points numeric(10,2) NULL CHECK (max_points IS NULL OR max_points >= 0),
  percentage numeric(5,2) NULL CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
  passed boolean NULL,
  grader_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,assessment_id,subject_user_id,attempt_number),
  FOREIGN KEY (tenant_id,assessment_id) REFERENCES osa.assessments(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES osa.users(tenant_id,id),
  FOREIGN KEY (tenant_id,grader_user_id) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.assessment_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  attempt_id uuid NOT NULL,
  question_id uuid NOT NULL,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_score numeric(8,2) NULL CHECK (auto_score IS NULL OR auto_score >= 0),
  manual_score numeric(8,2) NULL CHECK (manual_score IS NULL OR manual_score >= 0),
  final_score numeric(8,2) NULL CHECK (final_score IS NULL OR final_score >= 0),
  feedback text NOT NULL DEFAULT '',
  graded_by uuid NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  graded_at timestamptz NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,attempt_id,question_id),
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES osa.assessment_attempts(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,question_id) REFERENCES osa.assessment_questions(tenant_id,id),
  FOREIGN KEY (tenant_id,graded_by) REFERENCES osa.users(tenant_id,id)
);

CREATE TABLE osa.rubric_scores (
  tenant_id uuid NOT NULL REFERENCES osa.tenants(id),
  response_id uuid NOT NULL,
  criterion_id uuid NOT NULL,
  points numeric(8,2) NOT NULL CHECK (points >= 0),
  feedback text NOT NULL DEFAULT '',
  graded_by uuid NOT NULL,
  graded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,response_id,criterion_id),
  FOREIGN KEY (tenant_id,response_id) REFERENCES osa.assessment_responses(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,criterion_id) REFERENCES osa.rubric_criteria(tenant_id,id),
  FOREIGN KEY (tenant_id,graded_by) REFERENCES osa.users(tenant_id,id)
);

CREATE INDEX assessment_questions_bank ON osa.assessment_questions(tenant_id,bank_id,review_status);
CREATE INDEX assessments_org_status ON osa.assessments(tenant_id,org_unit_id,status);
CREATE INDEX assessments_course ON osa.assessments(tenant_id,course_id) WHERE course_id IS NOT NULL;
CREATE INDEX assessment_items_order ON osa.assessment_items(tenant_id,assessment_id,position);
CREATE INDEX attempts_subject ON osa.assessment_attempts(tenant_id,subject_user_id,status,started_at DESC);
CREATE INDEX attempts_assessment ON osa.assessment_attempts(tenant_id,assessment_id,status);
CREATE INDEX responses_attempt ON osa.assessment_responses(tenant_id,attempt_id);

-- New tables inherit the same lifecycle-aware tenant isolation introduced by
-- migration 004. Unmanaged tenants remain enabled through that function.
ALTER TABLE osa.rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.rubrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.rubrics USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.rubric_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.rubric_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.rubric_criteria USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.question_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.question_banks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.question_banks USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.assessment_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.assessment_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.assessment_questions USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.assessments USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.assessment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.assessment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.assessment_items USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.assessment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.assessment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.assessment_attempts USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.assessment_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.assessment_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.assessment_responses USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());
ALTER TABLE osa.rubric_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE osa.rubric_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON osa.rubric_scores USING (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled()) WITH CHECK (tenant_id = osa.current_tenant_id() AND osa.tenant_runtime_enabled());

COMMIT;

-- Runtime grants are intentionally provisioned out-of-band after migration:
-- SELECT/INSERT/UPDATE on the nine tables above for ik_osa_app; DELETE only on
-- assessment_items/rubric_scores when authoring replacement rows is required.
