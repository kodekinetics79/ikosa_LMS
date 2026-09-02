/**
 * The login throttle must slow guessing without ever locking an account out.
 *
 * The regression this pins: the throttle used to count every ATTEMPT before the
 * password was checked and then refuse outright, so ten wrong guesses against
 * an address denied its owner service for fifteen minutes — with the correct
 * password. `clearThrottle` ran only after a successful login, which the refusal
 * had made unreachable, so nothing but the window expiring released it. Anyone
 * who knew an address could lock it, and the shared dev server was locked out
 * of `analyst@northstar.example` exactly this way.
 *
 * These run against the JSON store on purpose. The throttle is per-process and
 * datastore-independent, and this file must pin the property in the default
 * `npm test` run, where no database is configured.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-throttle-"));
process.env.IK_DATA_DIR = isolatedDataDir;
// The JSON store is the system of record for this file even if the developer
// running it has a database configured in their shell.
delete process.env.DATABASE_URL;

const modules = Promise.all([
  import("../../src/lib/server/auth"),
  import("../../src/lib/server/store"),
]);

/** A seeded account, and the password `seed.ts` gives every demo identity. */
const EMAIL = "manager@northstar.example";
const PASSWORD = "Demo!2026";
const TENANT = "northstar";

async function failLogin(email: string, times: number): Promise<string[]> {
  const [auth] = await modules;
  const messages: string[] = [];
  for (let attempt = 0; attempt < times; attempt += 1) {
    const error = await auth.login(email, "not-the-password", crypto.randomUUID(), TENANT).then(() => null, (thrown: unknown) => thrown);
    assert.ok(error instanceof auth.AuthError, "a failed sign-in must reject with an AuthError");
    assert.equal(error.status, 401);
    messages.push(error.message);
  }
  return messages;
}

test("the correct password still authenticates after the throttle has engaged", async () => {
  const [auth] = await modules;

  // Comfortably past LOGIN_MAX_ATTEMPTS, so the brake is definitely on.
  const messages = await failLogin(EMAIL, 13);
  assert.ok(
    messages.some((message) => /Too many sign-in attempts/.test(message)),
    "expected the throttle to engage on repeated failures",
  );

  // The property. Before the fix this threw "Too many sign-in attempts".
  const result = await auth.login(EMAIL, PASSWORD, crypto.randomUUID(), TENANT);
  assert.equal(result.user.email, EMAIL);
  assert.ok(result.session.id);

  // And the success released the brake rather than leaving it armed.
  const next = await auth.login(EMAIL, PASSWORD, crypto.randomUUID(), TENANT);
  assert.ok(next.session.id);
  assert.notEqual(next.session.id, result.session.id);
});

test("a failure past the limit is delayed rather than refused for free", async () => {
  const email = "backoff-probe@northstar.example";

  // Up to and including the limit the answer is the ordinary refusal, and it is
  // not slowed: a legitimate typo must not be punished.
  const early = await failLogin(email, 10);
  assert.deepEqual([...new Set(early)], ["Invalid credentials"]);

  const started = Date.now();
  const [message] = await failLogin(email, 1);
  const elapsed = Date.now() - started;
  assert.match(message, /Too many sign-in attempts/);
  // Bounded: escalating, but never an outright refusal and never unbounded.
  assert.ok(elapsed >= 150, `expected a backoff on the failure response, took ${elapsed}ms`);
  assert.ok(elapsed < 10_000, `the backoff must stay bounded, took ${elapsed}ms`);
});

test("failures against one address do not throttle another", async () => {
  const [auth] = await modules;
  await failLogin("noisy-neighbour@northstar.example", 12);

  const result = await auth.login("analyst@northstar.example", PASSWORD, crypto.randomUUID(), TENANT);
  assert.equal(result.user.email, "analyst@northstar.example");
});

test("a failed sign-in is still audited, unknown accounts included", async () => {
  const [, store] = await modules;
  const unknown = `ghost-${crypto.randomUUID().slice(0, 8)}@northstar.example`;
  await failLogin(unknown, 1);

  const events = (await store.readDatabase()).auditEvents.filter((event) => event.action === "auth.login" && event.outcome === "failure");
  assert.ok(events.length > 0, "failed sign-ins must reach the ledger");
  assert.ok(
    events.some((event) => (event.metadata as { reason?: string }).reason === "unknown_account"),
    "an attempt against an address that does not exist must still be recorded",
  );
  assert.ok(
    events.some((event) => (event.metadata as { reason?: string }).reason === "invalid_credentials"),
    "a wrong password against a real account must be distinguishable in the ledger",
  );
  // The ledger must never carry the address or the password material.
  for (const event of events) {
    assert.equal(JSON.stringify(event.metadata).includes("@"), false);
  }
});
