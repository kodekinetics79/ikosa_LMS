import "server-only";

import type { Principal } from "./auth";
import type { Assessment, AssessmentAttempt, AssessmentQuestion, BloomLevel, QuestionBank, QuestionType } from "./domain";
import { scoreObjectiveQuestion, percentage } from "./assessment-scoring";
import { scopeForPrincipal } from "./tenant-runtime";
import { signAuditEvent } from "./db/audit-chain";
import {
  assertRuntimeRoleIsSafe,
  inspectRuntimeRole,
  loadPgModule,
  withTenantTransaction,
  type Pool,
  type PoolClient,
} from "./db/driver";
import { newId, pathToLtree, pathsToLtree } from "./db/ids";
import * as map from "./db/mapping";
import { conflict, forbidden, notFound, outOfRange } from "./errors";
import { recordAssessmentCourseProgress } from "./assessment/course-completion";

export type AssessmentSummary = Assessment & {
  itemCount: number;
  attemptCount: number;
  pendingMarking: number;
};

export type LearnerQuestion = {
  id: string;
  position: number;
  questionType: QuestionType;
  prompt: string;
  options: unknown;
  points: number;
  required: boolean;
};

export type AttemptWorkspace = {
  attempt: AssessmentAttempt;
  /**
   * The instant the database will stop accepting answers: the earlier of
   * `started_at + duration_minutes` and the assessment's `closes_at`, or null
   * when the assessment is untimed and has no closing time. Rendered by the
   * player together with `serverNow` so the countdown is a view of the server's
   * clock rather than of the learner's.
   */
  deadlineAt: string | null;
  /** The database's clock at the moment this payload was built. */
  serverNow: string;
  assessment: Pick<Assessment, "id" | "code" | "title" | "assessmentType" | "durationMinutes" | "passPercentage" | "feedbackMode">;
  questions: LearnerQuestion[];
  responses: Array<{ questionId: string; response: unknown; finalScore: number | null; feedback: string }>;
};

export type CreateBankInput = { orgUnitId: string; code: string; name: string; description: string; requestId: string };
export type CreateQuestionInput = {
  bankId: string;
  questionType: QuestionType;
  prompt: string;
  options: unknown;
  answerKey: unknown;
  rationale: string;
  points: number;
  difficulty: number;
  bloomLevel: BloomLevel;
  skillId: string | null;
  rubricId: string | null;
  origin: "manual" | "ai" | "import";
  reviewStatus: "draft" | "approved" | "rejected";
  requestId: string;
};
export type CreateAssessmentInput = {
  orgUnitId: string;
  courseId: string | null;
  code: string;
  title: string;
  description: string;
  assessmentType: "quiz" | "exam" | "practice";
  durationMinutes: number | null;
  passPercentage: number;
  attemptLimit: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  feedbackMode: "immediate" | "after_submit" | "after_close";
  opensAt: string | null;
  closesAt: string | null;
  requestId: string;
};

let poolPromise: Promise<Pool> | null = null;

async function runtimePool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for assessments");
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await loadPgModule();
      if (!pg) throw new Error("PostgreSQL driver is unavailable");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
      assertRuntimeRoleIsSafe(await inspectRuntimeRole(pool));
      return pool;
    })();
  }
  return poolPromise;
}

const canAuthor = (principal: Principal) => principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst");
const canGrade = (principal: Principal) => principal.roles.some((role) => role === "tenant_admin" || role === "assessor");
const canAttempt = (principal: Principal) => principal.roles.includes("learner");

function requireAuthor(principal: Principal): void {
  if (!canAuthor(principal)) throw forbidden("Assessment authoring permission required");
}
function requireGrader(principal: Principal): void {
  if (!canGrade(principal)) throw forbidden("Assessment grading permission required");
}
function requireLearner(principal: Principal): void {
  if (!canAttempt(principal)) throw forbidden("Learner permission required");
}

function num(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function isoOrNull(value: unknown): string | null { return value === null || value === undefined ? null : iso(value); }
function bool(value: unknown): boolean { return value === true || value === "true" || value === "t"; }

function toAssessment(row: Record<string, unknown>): Assessment {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), orgUnitId: String(row.org_unit_id),
    courseId: row.course_id ? String(row.course_id) : null, code: String(row.code), title: String(row.title),
    description: String(row.description ?? ""), assessmentType: String(row.assessment_type) as Assessment["assessmentType"],
    status: String(row.status) as Assessment["status"], durationMinutes: row.duration_minutes === null ? null : num(row.duration_minutes),
    passPercentage: num(row.pass_percentage), attemptLimit: num(row.attempt_limit),
    shuffleQuestions: bool(row.shuffle_questions), shuffleOptions: bool(row.shuffle_options),
    feedbackMode: String(row.feedback_mode) as Assessment["feedbackMode"], opensAt: isoOrNull(row.opens_at), closesAt: isoOrNull(row.closes_at),
    createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function toQuestion(row: Record<string, unknown>): AssessmentQuestion {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), bankId: String(row.bank_id),
    questionType: String(row.question_type) as QuestionType, prompt: String(row.prompt), options: row.options,
    answerKey: row.answer_key, rationale: String(row.rationale ?? ""), points: num(row.points), difficulty: num(row.difficulty),
    bloomLevel: String(row.bloom_level) as BloomLevel, skillId: row.skill_id ? String(row.skill_id) : null,
    rubricId: row.rubric_id ? String(row.rubric_id) : null, origin: String(row.origin) as AssessmentQuestion["origin"],
    reviewStatus: String(row.review_status) as AssessmentQuestion["reviewStatus"], version: num(row.version),
    createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function toAttempt(row: Record<string, unknown>): AssessmentAttempt {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), assessmentId: String(row.assessment_id), subjectUserId: String(row.subject_user_id),
    attemptNumber: num(row.attempt_number), status: String(row.status) as AssessmentAttempt["status"], startedAt: iso(row.started_at),
    submittedAt: isoOrNull(row.submitted_at), gradedAt: isoOrNull(row.graded_at),
    scorePoints: row.score_points === null ? null : num(row.score_points), maxPoints: row.max_points === null ? null : num(row.max_points),
    percentage: row.percentage === null ? null : num(row.percentage), passed: row.passed === null ? null : bool(row.passed),
    graderUserId: row.grader_user_id ? String(row.grader_user_id) : null, createdAt: iso(row.created_at),
  };
}

function scopePaths(principal: Principal): { roots: string[]; viewer: string } {
  const scope = scopeForPrincipal(principal);
  return { roots: pathsToLtree(scope.orgScopes), viewer: pathToLtree(scope.viewerOrgPath) };
}

async function read<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(await runtimePool(), scopeForPrincipal(principal), run, { readOnly: true });
}
async function write<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(await runtimePool(), scopeForPrincipal(principal), run);
}

async function appendAudit(client: PoolClient, principal: Principal, requestId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, string | number | boolean | null>): Promise<void> {
  const scope = scopeForPrincipal(principal);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`osa.audit:${scope.tenantId}`]);
  const { rows } = await client.query(`SELECT a.id,a.tenant_id,a.actor_user_id,a.action,a.resource_type,a.resource_id,a.outcome,a.occurred_at,a.request_id,a.metadata,a.previous_hash,a.event_hash FROM osa.audit_events a ORDER BY a.sequence DESC LIMIT 1`);
  const event = signAuditEvent(rows[0] ? map.toAuditEvent(rows[0]) : null, {
    tenantId: scope.tenantId, actorUserId: scope.userId, action, resourceType, resourceId,
    outcome: "success", requestId, metadata,
  });
  await client.query(
    `INSERT INTO osa.audit_events (id,tenant_id,actor_user_id,action,resource_type,resource_id,outcome,request_id,metadata,occurred_at,previous_hash,event_hash)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::jsonb,$10::timestamptz,$11,$12)`,
    [event.id,event.tenantId,event.actorUserId,event.action,event.resourceType,event.resourceId,event.outcome,event.requestId,JSON.stringify(event.metadata),event.occurredAt,map.hashToBytes(event.previousHash),map.hashToBytes(event.hash)],
  );
}

export async function listQuestionBanks(principal: Principal): Promise<QuestionBank[]> {
  requireAuthor(principal);
  return read(principal, async (client) => {
    const { roots } = scopePaths(principal);
    const { rows } = await client.query(
      `SELECT b.id,b.tenant_id,b.org_unit_id,b.code,b.name,b.description,b.status,b.created_by,b.created_at,b.updated_at
         FROM osa.question_banks b JOIN osa.org_units ou ON ou.tenant_id=b.tenant_id AND ou.id=b.org_unit_id
        WHERE ou.path <@ ANY($1::ltree[]) ORDER BY b.name`, [roots]);
    return rows.map((row) => ({
      id:String(row.id),tenantId:String(row.tenant_id),orgUnitId:String(row.org_unit_id),code:String(row.code),name:String(row.name),
      description:String(row.description ?? ""),status:String(row.status) as QuestionBank["status"],createdBy:String(row.created_by),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
    }));
  });
}

export async function createQuestionBank(principal: Principal, input: CreateBankInput): Promise<QuestionBank> {
  requireAuthor(principal);
  return write(principal, async (client) => {
    const scope = scopeForPrincipal(principal); const { roots } = scopePaths(principal);
    const org = await client.query(`SELECT id FROM osa.org_units WHERE id=$1::uuid AND path <@ ANY($2::ltree[])`, [input.orgUnitId,roots]);
    if (!org.rowCount) throw forbidden("Organization is outside your delegated scope");
    const id = newId();
    const { rows } = await client.query(
      `INSERT INTO osa.question_banks (id,tenant_id,org_unit_id,code,name,description,status,created_by)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'active',$7::uuid)
       RETURNING id,tenant_id,org_unit_id,code,name,description,status,created_by,created_at,updated_at`,
      [id,scope.tenantId,input.orgUnitId,input.code,input.name,input.description,scope.userId]);
    await appendAudit(client,principal,input.requestId,"assessment.bank.create","question_bank",id,{code:input.code});
    const row=rows[0];
    return {id:String(row.id),tenantId:String(row.tenant_id),orgUnitId:String(row.org_unit_id),code:String(row.code),name:String(row.name),description:String(row.description),status:String(row.status) as QuestionBank["status"],createdBy:String(row.created_by),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};
  });
}

export async function createAssessmentQuestion(principal: Principal, input: CreateQuestionInput): Promise<AssessmentQuestion> {
  requireAuthor(principal);
  return write(principal, async (client) => {
    const scope=scopeForPrincipal(principal); const { roots }=scopePaths(principal);
    const bank=await client.query(`SELECT b.id FROM osa.question_banks b JOIN osa.org_units ou ON ou.tenant_id=b.tenant_id AND ou.id=b.org_unit_id WHERE b.id=$1::uuid AND ou.path <@ ANY($2::ltree[]) AND b.status<>'retired'`,[input.bankId,roots]);
    if(!bank.rowCount) throw forbidden("Question bank is outside your delegated scope");
    const reviewStatus=input.origin==="ai" ? "draft" : input.reviewStatus;
    const id=newId();
    const {rows}=await client.query(
      `INSERT INTO osa.assessment_questions
       (id,tenant_id,bank_id,question_type,prompt,options,answer_key,rationale,points,difficulty,bloom_level,skill_id,rubric_id,origin,review_status,created_by)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::uuid,$13::uuid,$14,$15,$16::uuid)
       RETURNING *`,
      [id,scope.tenantId,input.bankId,input.questionType,input.prompt,JSON.stringify(input.options),JSON.stringify(input.answerKey),input.rationale,input.points,input.difficulty,input.bloomLevel,input.skillId,input.rubricId,input.origin,reviewStatus,scope.userId]);
    await appendAudit(client,principal,input.requestId,"assessment.question.create","assessment_question",id,{type:input.questionType,origin:input.origin,reviewStatus});
    return toQuestion(rows[0]);
  });
}

export async function createAssessment(principal: Principal,input:CreateAssessmentInput):Promise<AssessmentSummary>{
  requireAuthor(principal);
  return write(principal,async(client)=>{
    const scope=scopeForPrincipal(principal); const {roots}=scopePaths(principal);
    const org=await client.query(`SELECT id FROM osa.org_units WHERE id=$1::uuid AND path <@ ANY($2::ltree[])`,[input.orgUnitId,roots]);
    if(!org.rowCount) throw forbidden("Organization is outside your delegated scope");
    if(input.courseId){const course=await client.query(`SELECT c.id FROM osa.courses c JOIN osa.org_units ou ON ou.tenant_id=c.tenant_id AND ou.id=c.org_unit_id WHERE c.id=$1::uuid AND (ou.path <@ ANY($2::ltree[]) OR ou.path @> $3::ltree)`,[input.courseId,roots,scopePaths(principal).viewer]);if(!course.rowCount)throw forbidden("Course is outside your delegated scope");}
    const id=newId();
    const {rows}=await client.query(
      `INSERT INTO osa.assessments
       (id,tenant_id,org_unit_id,course_id,code,title,description,assessment_type,status,duration_minutes,pass_percentage,attempt_limit,shuffle_questions,shuffle_options,feedback_mode,opens_at,closes_at,created_by)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17::uuid)
       RETURNING *`,
      [id,scope.tenantId,input.orgUnitId,input.courseId,input.code,input.title,input.description,input.assessmentType,input.durationMinutes,input.passPercentage,input.attemptLimit,input.shuffleQuestions,input.shuffleOptions,input.feedbackMode,input.opensAt,input.closesAt,scope.userId]);
    await appendAudit(client,principal,input.requestId,"assessment.create","assessment",id,{code:input.code,type:input.assessmentType});
    return {...toAssessment(rows[0]),itemCount:0,attemptCount:0,pendingMarking:0};
  });
}

export async function addQuestionToAssessment(principal:Principal,assessmentId:string,questionId:string,requestId:string):Promise<void>{
  requireAuthor(principal);
  await write(principal,async(client)=>{
    const {roots}=scopePaths(principal);
    const assessment=await client.query(`SELECT a.id FROM osa.assessments a JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id WHERE a.id=$1::uuid AND a.status='draft' AND ou.path <@ ANY($2::ltree[])`,[assessmentId,roots]);
    if(!assessment.rowCount)throw notFound("Draft assessment not found in your scope");
    const question=await client.query(`SELECT q.id FROM osa.assessment_questions q JOIN osa.question_banks b ON b.tenant_id=q.tenant_id AND b.id=q.bank_id JOIN osa.org_units ou ON ou.tenant_id=b.tenant_id AND ou.id=b.org_unit_id WHERE q.id=$1::uuid AND ou.path <@ ANY($2::ltree[])`,[questionId,roots]);
    if(!question.rowCount)throw notFound("Question not found in your scope");
    const pos=await client.query<{next:number}>(`SELECT coalesce(max(position),0)::int+1 AS next FROM osa.assessment_items WHERE assessment_id=$1::uuid`,[assessmentId]);
    await client.query(`INSERT INTO osa.assessment_items (tenant_id,assessment_id,question_id,position) VALUES (osa.current_tenant_id(),$1::uuid,$2::uuid,$3) ON CONFLICT (tenant_id,assessment_id,question_id) DO NOTHING`,[assessmentId,questionId,pos.rows[0].next]);
    await client.query(`UPDATE osa.assessments SET updated_at=now() WHERE id=$1::uuid`,[assessmentId]);
    await appendAudit(client,principal,requestId,"assessment.question.attach","assessment",assessmentId,{questionId});
  });
}

export async function publishAssessment(principal:Principal,assessmentId:string,requestId:string):Promise<void>{
  requireAuthor(principal);
  await write(principal,async(client)=>{
    const {roots}=scopePaths(principal);
    // `status` is SELECTED, not filtered on. Requiring `a.status='draft'` in the
    // predicate made an already-published assessment indistinguishable from one
    // in another organization: both returned no row and both were reported as
    // "Draft assessment not found in your scope" — telling the legitimate owner
    // they could not see their own assessment when in fact it was already live.
    // Existence and scope are one question; lifecycle state is another.
    const result=await client.query(
      `SELECT a.id, a.status,
              count(i.question_id)::int AS items,
              count(i.question_id) FILTER (WHERE q.review_status<>'approved')::int AS unapproved
         FROM osa.assessments a
         JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
         LEFT JOIN osa.assessment_items i ON i.tenant_id=a.tenant_id AND i.assessment_id=a.id
         LEFT JOIN osa.assessment_questions q ON q.tenant_id=i.tenant_id AND q.id=i.question_id
        WHERE a.id=$1::uuid AND ou.path <@ ANY($2::ltree[])
        GROUP BY a.id, a.status`,[assessmentId,roots]);
    const row=result.rows[0]; if(!row)throw notFound("Assessment not found in your scope");
    if(String(row.status)==="published")throw conflict("This assessment is already published");
    if(String(row.status)!=="draft")throw conflict(`A ${String(row.status)} assessment cannot be published. Return it to draft first.`);
    if(num(row.items)<1)throw conflict("Add at least one question before publishing");
    if(num(row.unapproved)>0)throw conflict("Every assessment question must be approved before publishing");
    await client.query(`UPDATE osa.assessments SET status='published',updated_at=now() WHERE id=$1::uuid`,[assessmentId]);
    await appendAudit(client,principal,requestId,"assessment.publish","assessment",assessmentId,{items:num(row.items)});
  });
}


/* ---------------------------------------------------------------------------
 * Deterministic delivery shuffle.
 *
 * A shuffle that used Math.random would reorder the paper on every render and
 * on every resume, so a learner returning to "question 3" would find a
 * different question - and their saved answers, which are keyed by question id,
 * would appear against the wrong prompts. The order therefore has to be a pure
 * function of something stable and per-attempt: the attempt's uuid.
 *
 * This is presentation only. Scoring, the marking queue and the required-item
 * gate all work from `assessment_items.position` and are unaffected by what
 * order a learner happened to see.
 * ------------------------------------------------------------------------- */

/** FNV-1a over the seed, then xorshift32. Small, fast, and identical everywhere. */
function seededOrder<T>(items: readonly T[], seed: string): T[] {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const next = (): number => {
    hash ^= hash << 13; hash >>>= 0;
    hash ^= hash >>> 17;
    hash ^= hash << 5; hash >>>= 0;
    return hash / 0x100000000;
  };
  // Fisher-Yates, so every permutation is equally likely.
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function orderQuestions(questions: LearnerQuestion[], shuffle: boolean, attemptId: string): LearnerQuestion[] {
  if (!shuffle || questions.length < 2) return questions;
  return seededOrder(questions, `questions:${attemptId}`);
}

/**
 * Reorders a choice-style question's options.
 *
 * Only the `choices` array is touched, and each choice keeps its `id` - which
 * is what the answer key and the saved response both reference - so a shuffled
 * paper scores identically to an unshuffled one. A question with no `choices`
 * array (numeric, free text, matching) is returned untouched.
 */
function shuffleOptionsFor(options: unknown, shuffle: boolean, seed: string): unknown {
  if (!shuffle || !options || typeof options !== "object" || Array.isArray(options)) return options;
  const record = options as { choices?: unknown };
  if (!Array.isArray(record.choices) || record.choices.length < 2) return options;
  return { ...record, choices: seededOrder(record.choices, `options:${seed}`) };
}

async function learnerAttemptWorkspace(client:PoolClient,principal:Principal,attemptId:string):Promise<AttemptWorkspace>{
  const {viewer}=scopePaths(principal); const scope=scopeForPrincipal(principal);
  const {rows}=await client.query(
    // `deadline_at` and `server_now` come from the database, not the browser.
    // The player used to compute its countdown from `Date.now()` against
    // `startedAt`, so a learner whose clock was wrong - or deliberately set
    // back - got a different amount of time than the exam allowed. The server
    // is the only clock that decides when an attempt is over; the countdown is
    // rendered from these two values and is now only a display of it.
    `SELECT x.*,a.code,a.title,a.assessment_type,a.duration_minutes,a.pass_percentage,a.feedback_mode,a.shuffle_questions,a.shuffle_options,
            least(
              CASE WHEN a.duration_minutes IS NULL THEN NULL
                   ELSE x.started_at + make_interval(mins => a.duration_minutes) END,
              a.closes_at
            ) AS deadline_at,
            now() AS server_now
       FROM osa.assessment_attempts x JOIN osa.assessments a ON a.tenant_id=x.tenant_id AND a.id=x.assessment_id
       JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
      WHERE x.id=$1::uuid AND x.subject_user_id=$2::uuid AND ou.path @> $3::ltree`,[attemptId,scope.userId,viewer]);
  if(!rows[0])throw notFound("Attempt not found");
  const attempt=toAttempt(rows[0]);
  const questions=await client.query(
    `SELECT q.id,i.position,q.question_type,q.prompt,q.options,
            coalesce(i.points_override,q.points)::float8 AS points,i.required
       FROM osa.assessment_items i JOIN osa.assessment_questions q ON q.tenant_id=i.tenant_id AND q.id=i.question_id
      WHERE i.assessment_id=$1::uuid ORDER BY i.position`,[attempt.assessmentId]);
  const responses=await client.query(`SELECT question_id,response,final_score::float8 AS final_score,feedback FROM osa.assessment_responses WHERE attempt_id=$1::uuid`,[attemptId]);
  return {
    attempt,
    deadlineAt:rows[0].deadline_at===null||rows[0].deadline_at===undefined?null:new Date(rows[0].deadline_at as string|Date).toISOString(),
    serverNow:new Date(rows[0].server_now as string|Date).toISOString(),
    assessment:{id:attempt.assessmentId,code:String(rows[0].code),title:String(rows[0].title),assessmentType:String(rows[0].assessment_type) as Assessment["assessmentType"],durationMinutes:rows[0].duration_minutes===null?null:num(rows[0].duration_minutes),passPercentage:num(rows[0].pass_percentage),feedbackMode:String(rows[0].feedback_mode) as Assessment["feedbackMode"]},
    // `shuffle_questions` and `shuffle_options` were stored, validated and never
    // read: delivery always used the authored order, so both settings were
    // decorative. Shuffling is seeded from the ATTEMPT id, so the order is
    // stable across a resume, a reconnect and a re-render - a learner who
    // navigates back to question 3 must find the same question 3 - while
    // differing between learners and between attempts, which is the point.
    questions:orderQuestions(
      questions.rows.map((q)=>({id:String(q.id),position:num(q.position),questionType:String(q.question_type) as QuestionType,prompt:String(q.prompt),options:shuffleOptionsFor(q.options,bool(rows[0].shuffle_options),`${attemptId}:${String(q.id)}`),points:num(q.points),required:bool(q.required)})),
      bool(rows[0].shuffle_questions),
      attemptId,
    ),
    responses:responses.rows.map((r)=>({questionId:String(r.question_id),response:r.response,finalScore:r.final_score===null?null:num(r.final_score),feedback:String(r.feedback??"")})),
  };
}

export async function startAssessmentAttempt(principal:Principal,assessmentId:string,requestId:string):Promise<AttemptWorkspace>{
  requireLearner(principal);
  return write(principal,async(client)=>{
    const scope=scopeForPrincipal(principal); const {viewer}=scopePaths(principal);
    const assessment=await client.query(
      `SELECT a.* FROM osa.assessments a JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
        WHERE a.id=$1::uuid AND a.status='published' AND ou.path @> $2::ltree
          AND (a.opens_at IS NULL OR a.opens_at<=now()) AND (a.closes_at IS NULL OR a.closes_at>now())`,[assessmentId,viewer]);
    if(!assessment.rows[0])throw notFound("Assessment is not available");
    const existing=await client.query<{id:string}>(`SELECT id::text FROM osa.assessment_attempts WHERE assessment_id=$1::uuid AND subject_user_id=$2::uuid AND status='in_progress' ORDER BY attempt_number DESC LIMIT 1`,[assessmentId,scope.userId]);
    if(existing.rows[0])return learnerAttemptWorkspace(client,principal,existing.rows[0].id);
    const counts=await client.query<{used:number;next:number}>(`SELECT count(*)::int AS used,coalesce(max(attempt_number),0)::int+1 AS next FROM osa.assessment_attempts WHERE assessment_id=$1::uuid AND subject_user_id=$2::uuid AND status<>'void'`,[assessmentId,scope.userId]);
    if(num(counts.rows[0].used)>=num(assessment.rows[0].attempt_limit))throw conflict("Attempt limit reached");
    const id=newId();
    await client.query(`INSERT INTO osa.assessment_attempts (id,tenant_id,assessment_id,subject_user_id,attempt_number,status) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'in_progress')`,[id,scope.tenantId,assessmentId,scope.userId,counts.rows[0].next]);
    await appendAudit(client,principal,requestId,"assessment.attempt.start","assessment_attempt",id,{assessmentId,attemptNumber:counts.rows[0].next});
    return learnerAttemptWorkspace(client,principal,id);
  });
}

export async function gradeAssessmentResponse(principal:Principal,responseId:string,score:number,feedback:string,requestId:string):Promise<AssessmentAttempt>{
  requireGrader(principal);
  return write(principal,async(client)=>{
    const scope=scopeForPrincipal(principal); const {roots}=scopePaths(principal);
    const response=await client.query(
      // The SAME authority rule the marking queue uses: the learner must be in
      // the marker's delegated scope, and the assessment must be one they can
      // see. If these two ever diverge, the queue lists work that grading then
      // refuses — a queue item nobody can clear.
      `SELECT r.id,r.attempt_id,r.question_id,coalesce(i.points_override,q.points)::float8 AS max_points,x.assessment_id
       FROM osa.assessment_responses r JOIN osa.assessment_attempts x ON x.tenant_id=r.tenant_id AND x.id=r.attempt_id
       JOIN osa.assessments a ON a.tenant_id=x.tenant_id AND a.id=x.assessment_id
       JOIN osa.org_units ou ON ou.tenant_id=a.tenant_id AND ou.id=a.org_unit_id
       JOIN osa.users u ON u.tenant_id=x.tenant_id AND u.id=x.subject_user_id
       JOIN osa.org_units lou ON lou.tenant_id=u.tenant_id AND lou.id=u.org_unit_id
       JOIN osa.assessment_items i ON i.tenant_id=x.tenant_id AND i.assessment_id=x.assessment_id AND i.question_id=r.question_id
       JOIN osa.assessment_questions q ON q.tenant_id=r.tenant_id AND q.id=r.question_id
       WHERE r.id=$1::uuid AND x.status='submitted'
         AND lou.path <@ ANY($2::ltree[])
         AND (ou.path <@ ANY($2::ltree[]) OR ou.path @> $3::ltree)
       FOR UPDATE OF r`,[responseId,roots,scopePaths(principal).viewer]);
    const row=response.rows[0]; if(!row)throw notFound("Response is not available for marking");
    const maxPoints=num(row.max_points); if(!Number.isFinite(score)||score<0||score>maxPoints)throw outOfRange(`Score must be between 0 and ${maxPoints}`);
    await client.query(`UPDATE osa.assessment_responses SET manual_score=$2,final_score=$2,feedback=$3,graded_by=$4::uuid,graded_at=now() WHERE id=$1::uuid`,[responseId,score,feedback,scope.userId]);
    const remaining=await client.query<{count:number}>(
      `SELECT count(*)::int AS count FROM osa.assessment_items i
       LEFT JOIN osa.assessment_responses r ON r.tenant_id=i.tenant_id AND r.attempt_id=$1::uuid AND r.question_id=i.question_id
       WHERE i.assessment_id=$2::uuid AND i.required AND (r.id IS NULL OR r.final_score IS NULL)`,[row.attempt_id,row.assessment_id]);
    if(num(remaining.rows[0].count)>0){
      const attempt=await client.query(`SELECT * FROM osa.assessment_attempts WHERE id=$1::uuid`,[row.attempt_id]);
      await appendAudit(client,principal,requestId,"assessment.response.grade","assessment_response",responseId,{score,maxPoints,finalized:false});
      return toAttempt(attempt.rows[0]);
    }
    const totals=await client.query<{earned:number;max:number}>(
      `SELECT coalesce(sum(r.final_score),0)::float8 AS earned,coalesce(sum(coalesce(i.points_override,q.points)),0)::float8 AS max
       FROM osa.assessment_items i JOIN osa.assessment_questions q ON q.tenant_id=i.tenant_id AND q.id=i.question_id
       LEFT JOIN osa.assessment_responses r ON r.tenant_id=i.tenant_id AND r.attempt_id=$1::uuid AND r.question_id=i.question_id
       WHERE i.assessment_id=$2::uuid`,[row.attempt_id,row.assessment_id]);
    const assessment=await client.query<{pass_percentage:number}>(`SELECT pass_percentage::float8 AS pass_percentage FROM osa.assessments WHERE id=$1::uuid`,[row.assessment_id]);
    const earned=num(totals.rows[0].earned),max=num(totals.rows[0].max),pct=percentage(earned,max);
    const updated=await client.query(`UPDATE osa.assessment_attempts SET status='graded',graded_at=now(),grader_user_id=$2::uuid,score_points=$3::numeric,max_points=$4::numeric,percentage=$5::numeric,passed=$5::numeric >= $6::numeric WHERE id=$1::uuid RETURNING *`,[row.attempt_id,scope.userId,earned,max,pct,num(assessment.rows[0].pass_percentage)]);
    await appendAudit(client,principal,requestId,"assessment.response.grade","assessment_response",responseId,{score,maxPoints,finalized:true,attemptId:String(row.attempt_id),percentage:pct});

    // The manual-marking twin of the auto-scored path. Both must call this or a
    // course whose assessment contains one essay would never complete, however
    // well the learner did. `subject_user_id` is the LEARNER's, read from the
    // attempt - the marker is the actor here, not the subject.
    const attemptRow=updated.rows[0];
    await recordAssessmentCourseProgress(client,principal,{
      assessmentId:String(row.assessment_id),
      subjectUserId:String(attemptRow.subject_user_id),
      percentage:pct,
      requestId,
      attemptId:String(row.attempt_id),
    });

    return toAttempt(updated.rows[0]);
  });
}

export function assessmentCapabilities(principal:Principal){return {author:canAuthor(principal),grader:canGrade(principal),learner:canAttempt(principal)};}
