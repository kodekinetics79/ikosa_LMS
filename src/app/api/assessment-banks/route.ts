import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { createQuestionBank, listQuestionBanks } from "@/lib/server/assessment-store";
import { setBankStatus } from "@/lib/server/assessment/authoring";
import { json, objectBody, optionalEnum, problem, requestId, requiredString } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAuthor(roles: readonly string[]): void {
  if (!roles.some((role) => role === "tenant_admin" || role === "tna_analyst")) throw new AuthError(403, "Assessment authoring permission required");
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    return json({ items: await listQuestionBanks(principal), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireAuthor(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const bank = await createQuestionBank(principal, {
      orgUnitId: requiredString(body, "orgUnitId", 100),
      code: requiredString(body, "code", 40).toUpperCase(),
      name: requiredString(body, "name", 160),
      description: typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "",
      requestId: rid,
    });
    return json(bank, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

/**
 * Retires or reactivates a bank. `createAssessmentQuestion` already refused to
 * add a question to a retired bank, so the guard existed while nothing could
 * ever set the status it guarded against.
 */
export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const status = optionalEnum(body, "status", ["active","retired"] as const, "retired");
    return json(await setBankStatus(principal, requiredString(body, "bankId", 100), status, rid));
  } catch (error) { return problem(error, rid); }
}
