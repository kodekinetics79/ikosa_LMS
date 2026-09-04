import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { createAssessmentQuestion } from "@/lib/server/assessment-store";
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
    const question = await createAssessmentQuestion(principal, {
      bankId: requiredString(body, "bankId", 100),
      questionType: optionalEnum(body, "questionType", QUESTION_TYPES, "single_choice"),
      prompt: requiredString(body, "prompt", 10000),
      options: body.options ?? [],
      answerKey: body.answerKey ?? {},
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
