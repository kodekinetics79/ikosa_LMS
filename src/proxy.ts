import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server/session-cookie";

/**
 * Optimistic edge-of-render gate. It only checks that a session cookie is
 * present so anonymous visitors never reach an authenticated shell.
 *
 * It is deliberately NOT the authorization decision: the cookie is not
 * validated here. Every protected route group re-resolves the principal on the
 * server (see src/app/(platform)/layout.tsx) and every API route authorizes
 * independently. Next.js documents proxy as unsuitable for full session
 * management, and ADR-001 forbids an authorization decision that exists only
 * in front-end code.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)) return NextResponse.next();

  const destination = new URL("/login", request.url);
  const { pathname, search } = request.nextUrl;
  if (pathname !== "/") destination.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(destination);
}

export const config = {
  // Protect application routes only. /login, /api/* (which authorize
  // themselves and must return 401 rather than a redirect), Next internals and
  // static assets are excluded.
  matcher: ["/((?!login|api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
