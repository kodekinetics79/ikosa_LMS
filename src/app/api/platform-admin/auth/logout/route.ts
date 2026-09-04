import { NextResponse } from "next/server";
import {
  PlatformAdminError,
  assertPlatformCsrf,
  clearPlatformCookie,
  platformLogout,
  platformPrincipalFromToken,
  PLATFORM_SESSION_COOKIE,
} from "@/lib/server/platform-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await platformPrincipalFromToken(cookieValue(request, PLATFORM_SESSION_COOKIE));
    assertPlatformCsrf(request, principal);
    await platformLogout(principal);
    const response = NextResponse.json({ ok: true });
    response.headers.set("set-cookie", clearPlatformCookie());
    return response;
  } catch (error) {
    const status = error instanceof PlatformAdminError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Logout failed" }, { status });
  }
}
