/**
 * The managed/fixture boundary.
 *
 * This is the switch that decides whether a missing datastore is a refusal to
 * start or a supported local configuration. Getting it wrong in one direction
 * breaks CI; getting it wrong in the other serves seeded accounts with a
 * published password from a real deployment. So the direction of every default
 * is asserted here rather than trusted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assertFixtureModeIsPermitted, isManagedRuntime, resolveRuntimeMode } from "../../src/lib/server/runtime-mode";

test("a production bundle is managed unless fixture mode is asked for by name", () => {
  assert.equal(resolveRuntimeMode({ NODE_ENV: "production" }), "managed");
  assert.equal(resolveRuntimeMode({ NODE_ENV: "production", IK_RUNTIME_MODE: "fixture" }), "fixture");
});

test("anything other than the exact word 'fixture' is managed", () => {
  // A configuration mistake must fail closed. Each of these is a plausible
  // typo, and every one of them must leave the instance managed.
  for (const value of ["", " ", "Fixture", "FIXTURE", "fixtures", "true", "1", "development", "test", undefined]) {
    assert.equal(
      resolveRuntimeMode({ NODE_ENV: "production", IK_RUNTIME_MODE: value }),
      "managed",
      `IK_RUNTIME_MODE=${JSON.stringify(value)} must not select fixture mode`,
    );
  }
});

test("fixture mode tolerates surrounding whitespace, which a shell can add", () => {
  assert.equal(resolveRuntimeMode({ NODE_ENV: "production", IK_RUNTIME_MODE: " fixture " }), "fixture");
});

test("a non-production NODE_ENV is fixture without ceremony", () => {
  assert.equal(resolveRuntimeMode({ NODE_ENV: "development" }), "fixture");
  assert.equal(resolveRuntimeMode({}), "fixture");
  assert.equal(isManagedRuntime({ NODE_ENV: "development" }), false);
});

test("fixture mode is refused on anything that looks like a real deployment", () => {
  const deployments = [
    { VERCEL_ENV: "production" },
    { APP_ENV: "production" },
    { DATABASE_URL: "postgresql://user:pw@host/db" },
    { CONTROL_PLANE_DATABASE_URL: "postgresql://user:pw@host/db" },
  ];
  for (const signal of deployments) {
    assert.throws(
      () => assertFixtureModeIsPermitted({ NODE_ENV: "production", IK_RUNTIME_MODE: "fixture", ...signal }),
      /Refusing to start/,
      `fixture mode must be refused alongside ${Object.keys(signal)[0]}`,
    );
  }
});

test("a DATABASE_URL alongside fixture mode is refused as ambiguous, not silently preferred", () => {
  // The dangerous outcome is not an error; it is two reachable datastores and a
  // silent choice between them.
  assert.throws(
    () => assertFixtureModeIsPermitted({ NODE_ENV: "production", IK_RUNTIME_MODE: "fixture", DATABASE_URL: "postgresql://u:p@h/d" }),
    /must never run against a real datastore/,
  );
});

test("an empty DATABASE_URL is an absent one", () => {
  // Shell scripts clear a variable by assigning "". That must read as "no
  // database", not as an ambiguous configuration.
  assert.doesNotThrow(() => assertFixtureModeIsPermitted({ NODE_ENV: "production", IK_RUNTIME_MODE: "fixture", DATABASE_URL: "" }));
});

test("a managed instance is never blocked by the fixture guard", () => {
  assert.doesNotThrow(() => assertFixtureModeIsPermitted({ NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@h/d" }));
  assert.equal(isManagedRuntime({ NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@h/d" }), true);
});

test("plain `next dev` is not treated as a requested fixture mode", () => {
  // Developers routinely run `next dev` against a local database. That must not
  // trip the deployment guard.
  assert.doesNotThrow(() => assertFixtureModeIsPermitted({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@127.0.0.1/d" }));
});

/* -------------------------------------------------------------------------
 * Session cookie transport security.
 *
 * `Secure` used to be decided by `NODE_ENV === "production"`, which is the
 * wrong question in both directions: Next.js forces NODE_ENV=production inside
 * the standalone bundle (so a local production build over http emitted a
 * cookie the browser silently discarded, which is why the browser suite had
 * never run against one), and a deployment reporting anything else would have
 * shipped session cookies without `Secure` over the public internet.
 * ---------------------------------------------------------------------- */

import { cookieIsSecure } from "../../src/lib/server/session-cookie";

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("a plain-http request to a real host still gets a Secure cookie", () => {
  // The important direction: an unrecognised deployment shape must fail towards
  // a cookie that refuses to travel in clear text.
  assert.equal(cookieIsSecure(get("http://app.example.com/api/auth/login")), true);
  assert.equal(cookieIsSecure(get("http://10.0.0.5/api/auth/login")), true);
});

test("https is secure however it is reported", () => {
  assert.equal(cookieIsSecure(get("https://app.example.com/api/auth/login")), true);
  assert.equal(cookieIsSecure(get("http://app.example.com/api/auth/login", { "x-forwarded-proto": "https" })), true);
  // A proxy chain reports a list; the first entry is the client's scheme.
  assert.equal(cookieIsSecure(get("http://app.example.com/api/auth/login", { "x-forwarded-proto": "https, http" })), true);
});

test("a proxy that reports plain http is believed, and is not secure", () => {
  assert.equal(cookieIsSecure(get("https://internal/api/auth/login", { "x-forwarded-proto": "http" })), false);
});

test("loopback is a trustworthy origin", () => {
  // There is no network to intercept, and a real deployment is never loopback
  // from the client's point of view. This is what lets the browser suite run
  // against a production bundle.
  for (const url of ["http://127.0.0.1:3000/api/auth/login", "http://localhost:3000/api/auth/login", "http://[::1]:3000/api/auth/login"]) {
    assert.equal(cookieIsSecure(get(url)), false, url);
  }
});
