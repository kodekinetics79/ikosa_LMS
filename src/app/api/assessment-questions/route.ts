import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { createAssessmentQuestion } from "@/lib/server/assessment-store";
import { reviewQuestion } from "@/lib/server/assessment/authoring";
import { validateQuestionShape } from "@/lib/server/assessment/question-schema";
import { listAuthorQuestions } from "@/lib/server/assessment-list-store";
import type { BloomLevel, QuestionType } from "@/lib/server/domain";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUESTION_TYPES = ["single_choice","multiple_choice","true_false","short_text","long_text","numeric","matching","ordering"] as const satisfies readonly QuestionType[];
const BLOOM = ["remember","understand","apply","analyze","evaluate","create"] as const satisfies readonly BloomLevel[];

function requireAuthor(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "tna_analyst")) throw new AuthError(403, "Assessment authoring permission required");
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    return json({ items: await listAuthorQuestions(principal), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const points = Number(body.points ?? 1);
    const difficulty = Number(body.difficulty ?? 2);
    if (!Number.isFinite(points) || points <= 0 || points > 10000) throw new ValidationError("Validation failed", { points: "Points must be greater than zero" });
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) throw new ValidationError("Validation failed", { difficulty: "Difficulty must be 1-5" });
    const origin = optionalEnum(body, "origin", ["manual","ai","import"] as const, "manual");
    const requestedReview = optionalEnum(body, "reviewStatus", ["draft","approved","rejected"] as const, origin === "manual" ? "approved" : "draft");
    const questionType = optionalEnum(body, "questionType", QUESTION_TYPES, "single_choice");
    const options = body.options ?? [];
    const answerKey = body.answerKey ?? {};

    // The options and the answer key must agree with the question type BEFORE
    // the row is written. The scoring kernel reads specific shapes out of this
    // JSON and treats anything it does not recognise as a wrong answer, so a
    // malformed key does not fail here — it produces a question every learner
    // gets wrong, discovered when someone disputes a mark.
    const shapeIssues = validateQuestionShape(questionType, options, answerKey);
    if (shapeIssues.length > 0) {
      throw new ValidationError(
        "This question is not answerable as written",
        Object.fromEntries(shapeIssues.map((issue) => [issue.field, issue.message])),
      );
    }

    const question = await createAssessmentQuestion(principal, {
      bankId: requiredString(body, "bankId", 100),
      questionType,
      prompt: requiredString(body, "prompt", 10000),
      options,
      answerKey,
      rationale: typeof body.rationale === "string" ? body.rationale.trim().slice(0, 5000) : "",
      points,
      difficulty,
      bloomLevel: optionalEnum(body, "bloomLevel", BLOOM, "understand"),
      skillId: typeof body.skillId === "string" && body.skillId.trim() ? body.skillId.trim() : null,
      rubricId: typeof body.rubricId === "string" && body.rubricId.trim() ? body.rubricId.trim() : null,
      origin,
      reviewStatus: requestedReview,
      requestId: rid,
    });
    return json(question, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

/**
 * The review gate. Approving or rejecting a question is the human step the
 * publish rule already depended on and nothing could perform: the authoring UI
 * hardcoded `reviewStatus: "approved"`, so an AI-generated question — which the
 * store forces to `draft` — had no route to ever become publishable.
 */
export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    if (action !== "review") throw new ValidationError("Validation failed", { action: "Unsupported question action" });
    const reviewStatus = optionalEnum(body, "reviewStatus", ["approved","rejected"] as const, "approved");
    await reviewQuestion(principal, requiredString(body, "questionId", 100), reviewStatus, rid);
    return json({ ok: true, action, reviewStatus });
  } catch (error) { return problem(error, rid); }
}
