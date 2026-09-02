import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
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
