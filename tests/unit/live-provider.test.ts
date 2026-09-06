/**
 * The live-session room derivation.
 *
 * On a public Jitsi instance the room name is the only thing between a stranger
 * and the call — no lobby, no password, no membership check by default. So the
 * properties asserted here are not cosmetic: a room named after the session id
 * would be a room anyone who has seen that id in a URL, an API payload or an
 * audit export could walk into.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { isLiveProvider, jitsiDomain, jitsiRoomFor, joinUrlFor, roomFor } from "../../src/lib/server/sessions/providers";

const env = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({ AUTH_SECRET: "unit-test-secret", ...extra });

test("a room is stable for a session, so a restart does not move the class", () => {
  const id = randomUUID();
  assert.equal(jitsiRoomFor(id, env()), jitsiRoomFor(id, env()));
});

test("a room never contains the session id", () => {
  // The whole point: the id is public, the room must not be derivable from it.
  const id = randomUUID();
  const room = jitsiRoomFor(id, env());
  assert.equal(room.includes(id), false);
  assert.equal(room.includes(id.split("-")[0]), false);
});

test("two sessions never share a room, and two deployments never collide", () => {
  const first = randomUUID();
  const second = randomUUID();
  assert.notEqual(jitsiRoomFor(first, env()), jitsiRoomFor(second, env()));
  // Same session, different deployment secret: different room. Two environments
  // pointed at the same public instance must not fall into each other's calls.
  assert.notEqual(jitsiRoomFor(first, env()), jitsiRoomFor(first, env({ AUTH_SECRET: "another-deployment" })));
});

test("a missing secret fails loudly instead of degrading to a predictable room", () => {
  assert.throws(() => jitsiRoomFor(randomUUID(), {}), /AUTH_SECRET/);
});

test("the room is a single URL-safe segment", () => {
  const room = jitsiRoomFor(randomUUID(), env());
  assert.match(room, /^ik-[A-Za-z0-9_-]{32}$/);
});

test("the domain defaults to the public instance and accepts only a hostname", () => {
  assert.equal(jitsiDomain(env()), "meet.jit.si");
  assert.equal(jitsiDomain(env({ LIVE_JITSI_DOMAIN: "meet.example.com" })), "meet.example.com");
  // A configured value still lands inside a URL a browser navigates to.
  for (const bad of ["https://meet.example.com", "meet.example.com/../evil", "meet example", "javascript:alert(1)"]) {
    assert.throws(() => jitsiDomain(env({ LIVE_JITSI_DOMAIN: bad })), /not a hostname/, bad);
  }
});

test("a manual session has no room and no join URL", () => {
  // The schema enforces this too (live_sessions_room_matches_provider). A manual
  // session that carried a room would be claiming a call exists.
  assert.equal(roomFor("manual", randomUUID(), env()), "");
  assert.equal(joinUrlFor("manual", "ik-whatever", env()), "");
});

test("the join URL keeps the pre-join screen", () => {
  // Otherwise a link drops somebody straight into a live class with their
  // microphone open.
  const url = joinUrlFor("jitsi", "ik-room", env());
  assert.match(url, /^https:\/\/meet\.jit\.si\/ik-room#config\.prejoinPageEnabled=true$/);
});

test("only the providers with an adapter are accepted", () => {
  assert.equal(isLiveProvider("manual"), true);
  assert.equal(isLiveProvider("jitsi"), true);
  // Both need a registered OAuth application. Admitting them here before an
  // adapter exists is how a schema starts describing capability the code
  // does not have.
  for (const absent of ["zoom", "teams", "webex", "", null, undefined, 42]) {
    assert.equal(isLiveProvider(absent), false, String(absent));
  }
});
