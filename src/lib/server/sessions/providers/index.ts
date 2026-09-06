/**
 * Where a live session is actually held.
 *
 * Deliberately free of the `server-only` guard, like assessment-scoring.ts and
 * the feedback policy: this is a pure derivation with no I/O, and the room-name
 * properties it guarantees are exactly the kind that must be testable without a
 * database or a request. It still only ever runs on the server, because
 * `AUTH_SECRET` is only defined there.
 *
 * Migration 009 admitted only 'manual' because nothing was integrated, and a
 * schema that offers a value the code cannot honour is a claim, not a column.
 * Migration 010 adds 'jitsi' — the one provider that needs no account, no OAuth
 * application and no API key. A Jitsi room is a URL; the instance is
 * self-hostable; there is nothing to authenticate against before a class can be
 * held.
 *
 * Zoom and Teams remain absent. Both require a registered application and tenant
 * credentials, so adding them here before an adapter exists would put us back to
 * describing capability the code does not have.
 *
 * WHAT A PROVIDER DOES AND DOES NOT DO HERE
 *
 * It supplies a room and a join URL. It does NOT supply attendance. Jitsi will
 * report who is in a room to a page that embeds it, but that is a signal from a
 * client the learner controls, and this product treats an attendance record as
 * evidence — `session_attendance.source` exists precisely so a provider-reported
 * presence can never be mistaken for a register a human signed.
 */

import { createHmac } from "node:crypto";

export const LIVE_PROVIDERS = ["manual", "jitsi"] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export function isLiveProvider(value: unknown): value is LiveProvider {
  return typeof value === "string" && (LIVE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The Jitsi instance to use.
 *
 * Defaults to the public `meet.jit.si`, which is what makes this work with no
 * setup at all. That default is fine for a pilot and wrong for regulated
 * training: a public instance is a third party sitting in the middle of a class
 * that may discuss incidents, named people or safety findings. `LIVE_JITSI_DOMAIN`
 * points at a self-hosted instance, which is the answer for anyone who cares —
 * and the reason this is a variable rather than a constant.
 */
export function jitsiDomain(env: Record<string, string | undefined> = process.env): string {
  const configured = env.LIVE_JITSI_DOMAIN?.trim();
  if (!configured) return "meet.jit.si";
  // A domain arriving from configuration still ends up inside a URL a browser
  // will navigate to, so anything that is not plainly a hostname is refused
  // rather than interpolated.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(configured)) {
    throw new Error(`LIVE_JITSI_DOMAIN is not a hostname: ${configured}`);
  }
  return configured;
}

/**
 * The room name for a session.
 *
 * Deliberately NOT the session id. On a public instance the room name is the
 * only thing standing between a stranger and the call — there is no lobby, no
 * password and no membership check by default — so a room named after a value
 * that appears in URLs, API payloads and audit exports is a room anyone who has
 * seen the id can walk into.
 *
 * It is an HMAC of the session id under the deployment's own secret: stable, so
 * the same session always resolves to the same room across restarts and across
 * instances; unguessable, because deriving it needs a secret that never leaves
 * the server; and per-deployment, so two environments sharing a public Jitsi
 * instance cannot collide into each other's classes.
 *
 * AUTH_SECRET is reused rather than adding another required variable. It is
 * already mandatory at boot, and this is exactly the kind of thing it is for.
 */
export function jitsiRoomFor(sessionId: string, env: Record<string, string | undefined> = process.env): string {
  const secret = env.AUTH_SECRET;
  if (!secret) {
    // The boot check already refuses to start without this. Failing loudly here
    // too means a missing secret can never silently degrade into a predictable
    // room name.
    throw new Error("AUTH_SECRET is required to derive a live-session room name");
  }
  const digest = createHmac("sha256", secret).update(`live-room:v1:${sessionId}`).digest("base64url");
  // Jitsi room names are path segments. base64url is already URL-safe; 32
  // characters is 192 bits of the digest, which is far past guessable while
  // staying a readable single segment.
  return `ik-${digest.slice(0, 32)}`;
}

/**
 * Where a participant goes.
 *
 * `#config.prejoinPageEnabled=true` keeps Jitsi's own pre-join screen, so
 * somebody following a link lands on a device check rather than being dropped
 * live into a class with their microphone open.
 */
export function joinUrlFor(provider: LiveProvider, room: string, env: Record<string, string | undefined> = process.env): string {
  if (provider !== "jitsi" || !room) return "";
  return `https://${jitsiDomain(env)}/${room}#config.prejoinPageEnabled=true`;
}

/** The room a session should carry, given its provider. Empty for 'manual'. */
export function roomFor(provider: LiveProvider, sessionId: string, env: Record<string, string | undefined> = process.env): string {
  return provider === "jitsi" ? jitsiRoomFor(sessionId, env) : "";
}
