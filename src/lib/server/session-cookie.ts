/**
 * The session cookie name is shared by the proxy gate and the auth module.
 * It is kept in its own dependency-free module so src/proxy.ts does not pull
 * the persistence layer into the pre-render path.
 */
export const SESSION_COOKIE = "ik_session";

/**
 * Should this response's cookie carry `Secure`?
 *
 * It used to be `NODE_ENV === "production"`, which is the wrong question in two
 * directions. Next.js forces NODE_ENV=production inside the standalone bundle,
 * so a production build served over plain http on a developer's machine or a CI
 * runner emitted `Secure` and the browser silently discarded the cookie — the
 * whole browser suite failed at the first sign-in, and had never been run
 * against a production bundle for exactly that reason. In the other direction, a
 * deployment that reported anything but "production" would have shipped session
 * cookies without `Secure` over the public internet.
 *
 * The question that actually matters is whether the connection is a trustworthy
 * origin. It is when the scheme is https — directly, or at a TLS-terminating
 * proxy that sets `x-forwarded-proto` — and, by definition, when the client is
 * on the same machine. Everything else gets `Secure`, so the failure mode of an
 * unrecognised deployment shape is a cookie that refuses to travel in clear
 * text rather than one that will.
 */
export function cookieIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  let host: string;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return true;
  }
  if (new URL(request.url).protocol === "https:") return true;
  // Loopback is a trustworthy origin: there is no network to intercept. A real
  // deployment is never loopback from the client's point of view.
  return !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]");
}

/** `; Secure` or the empty string, for appending to a Set-Cookie value. */
export function secureAttribute(request: Request): string {
  return cookieIsSecure(request) ? "; Secure" : "";
}
