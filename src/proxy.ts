import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server/session-cookie";

/**
 * Optimistic edge-of-render gate for CUSTOMER tenant routes only. It only checks
 * that a tenant session cookie is present so anonymous visitors never reach an
 * authenticated tenant shell.
 *
 * `/platform-admin/*` is intentionally excluded: the SaaS control plane uses a
 * separate platform session, separate credentials and a dedicated database
 * connection. Mixing the two auth domains would either strand the owner behind
 * a tenant cookie or, worse, give a tenant administrator a path into global
 * customer administration.
 *
 * This is deliberately NOT the authorization decision: the cookie is not
 * validated here. Every protected tenant route group re-resolves the principal
 * on the server and every API route authorizes independently.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)) return NextResponse.next();

  const destination = new URL("/login", request.url);
  const { pathname, search } = request.nextUrl;
  if (pathname !== "/") destination.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(destination);
}

export const config = {
  // Protect customer application routes only. The platform-admin control plane
  // owns its own session/auth checks; APIs authorize themselves and must return
  // 401 rather than a redirect.
  matcher: ["/((?!login|platform-admin|api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
