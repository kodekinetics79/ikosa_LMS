import { login, serializeSessionCookie } from "@/lib/server/auth";
import { json, objectBody, problem, requestId, requiredString } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const body = await objectBody(request);
    const tenantSlug = typeof body.tenantSlug === "string" ? body.tenantSlug : undefined;
    const result = await login(requiredString(body, "email", 254), requiredString(body, "password", 256), id, tenantSlug);
    return json({ user: result.user, csrfToken: result.session.csrfToken, expiresAt: result.session.expiresAt }, { headers: { "set-cookie": serializeSessionCookie(result.session, request) } });
  } catch (error) { return problem(error, id); }
}
