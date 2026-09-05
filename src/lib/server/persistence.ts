import "server-only";
import type { OsaPersistence } from "./db/repository";
import { createPostgresPersistence } from "./db/postgres";
import { isManagedRuntime } from "./runtime-mode";

/**
 * The single place the application obtains durable storage.
 *
 * Two datastores exist during the migration and they must never both be
 * authoritative for the same request. `DATABASE_URL` is the switch: when it is
 * set, PostgreSQL is the system of record and the JSON store in `store.ts` is
 * not consulted at all. When it is absent, the JSON store serves local
 * development and the test suite.
 *
 * Production has no third option. The JSON store rewrites a whole file per
 * write behind a per-process queue, so on more than one instance it silently
 * loses writes - and Vercel's filesystem is read-only besides. A production
 * deployment without `DATABASE_URL` therefore refuses to start rather than
 * appearing to work.
 */
let gateway: Promise<OsaPersistence | null> | null = null;

export function postgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function persistence(): Promise<OsaPersistence | null> {
  // The pool is created once per process and reused. `createPostgresPersistence`
  // asserts the runtime role satisfies ADR-001 (no BYPASSRLS, not a superuser,
  // owns no table) and throws if it does not - a fatal condition, not a warning.
  gateway ??= createPostgresPersistence();
  return gateway;
}

export async function requirePersistence(): Promise<OsaPersistence> {
  const resolved = await persistence();
  if (!resolved) {
    throw new Error(
      "DATABASE_URL is not configured. PostgreSQL is the system of record; the local JSON datastore cannot be used in a deployed environment.",
    );
  }
  return resolved;
}

/**
 * Fails fast at startup in production. Called from instrumentation so a
 * misconfigured deployment surfaces immediately instead of on the first
 * request a user happens to make.
 */
export async function assertPersistenceReady(): Promise<void> {
  if (!isManagedRuntime()) return;
  if (!postgresConfigured()) {
    throw new Error("DATABASE_URL must be configured on a managed instance.");
  }
  await requirePersistence();
}
