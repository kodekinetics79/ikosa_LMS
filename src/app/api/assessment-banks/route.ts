import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { createQuestionBank, listQuestionBanks } from "@/lib/server/assessment-store";
import { json, objectBody, problem, requestId, requiredString } from "@/lib/server/http";

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
