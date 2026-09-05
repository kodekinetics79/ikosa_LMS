import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * A new identifier.
 *
 * Returns a uuid, not the old `"<prefix>_<24 hex>"` form. This is the cutover
 * step `src/lib/server/db/ids.ts` describes and nothing had taken.
 *
 * Every id column in the schema is `uuid`, so a minted `tna_9f3c…` had to be
 * translated by `toStorageId` on the way in. The row was therefore stored under
 * a uuid v5 derived from the prefixed string, while the API had already
 * returned the prefixed string to the caller — so `POST /api/tna` answered 201
 * with an id that no subsequent `GET /api/tna` would ever report, the Location
 * header pointed at a form of the id the list did not use, and every optimistic
 * client update silently failed to match. Caught by the live integration suite
 * creating a study and then not finding it in the list.
 *
 * `toStorageId` passes a uuid through untouched, so this is correct for both
 * datastores. Nothing anywhere parses the prefix — it was a readability
 * convention in the development JSON file, and it cost a real identity bug.
 */
export function id(): string {
  return randomUUID();
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
