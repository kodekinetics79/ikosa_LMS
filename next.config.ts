import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * The application shipped with no security headers at all: no CSP, no HSTS, and
 * nothing preventing it being framed. For a product that renders competence
 * records and an audit ledger, clickjacking and script injection are not
 * theoretical.
 *
 * Development needs `unsafe-eval` and a websocket origin for Turbopack HMR;
 * production gets neither. `unsafe-inline` for scripts remains because Next
 * injects an inline bootstrap - tightening that to a nonce requires generating
 * one per request in the proxy and is tracked as follow-up work rather than
 * claimed here.
 */
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ];
  if (isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  // Sent only over TLS in production; meaningless and unwanted on local http.
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  // "standalone" is for the Dockerfile in this repo. Vercel builds its own
  // output and reports `No Output Directory named "public"` when it sees a
  // standalone build, so leave the default in place there.
  output: process.env.VERCEL ? undefined : "standalone",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    typedEnv: true
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
