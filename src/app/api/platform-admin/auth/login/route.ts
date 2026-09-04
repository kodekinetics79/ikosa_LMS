import { NextResponse } from "next/server";
import { PlatformAdminError, platformLogin, serializePlatformCookie } from "@/lib/server/platform-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const email = body.email?.trim() ?? "";
    const password = body.password ?? "";
    if (!email || !password) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });

    const principal = await platformLogin(email, password);
    const response = NextResponse.json({
      operator: principal.operator,
      csrfToken: principal.csrfToken,
    });
    response.headers.set("set-cookie", serializePlatformCookie(principal.sessionToken));
    return response;
  } catch (error) {
    const status = error instanceof PlatformAdminError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Platform login failed";
    return NextResponse.json({ error: message }, { status });
  }
}
