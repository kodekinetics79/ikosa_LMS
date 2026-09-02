import { clearSessionCookie, logout } from "@/lib/server/auth";
import { json, problem, requestId } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    await logout(request, id);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
  } catch (error) { return problem(error, id); }
}
