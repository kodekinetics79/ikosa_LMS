/**
 * Runs once when a server instance starts, before it accepts any request.
 *
 * A deployment missing its datastore or its ledger secret is misconfigured, and
 * the failure should surface at boot rather than as a 500 on whichever page a
 * user happens to open first. `register` must complete before the server is
 * ready, so throwing here keeps a broken instance from ever serving traffic.
 */
export async function register(): Promise<void> {
  // Only the Node.js runtime reaches persistence; other runtimes have no pool.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  const failures: string[] = [];

  if (!process.env.AUDIT_HASH_SECRET) {
    // audit.ts throws on the first append without this. Better to know now than
    // to discover it when someone records the first piece of evidence.
    failures.push("AUDIT_HASH_SECRET is not set; the audit ledger cannot be written.");
  }

  if (!process.env.DATABASE_URL) {
    failures.push("DATABASE_URL is not set; PostgreSQL is the system of record in production.");
  } else {
    try {
      // Imports the factory directly rather than going through
      // lib/server/persistence, which carries `server-only`. That guard keeps
      // the pool out of any client bundle, but instrumentation does not run in
      // a Server Component context, so importing it here throws
      // "This module cannot be imported from a Client Component module" and
      // takes down every dynamic route with an opaque 500.
      const { createPostgresPersistence } = await import("./lib/server/db/postgres");
      // Also asserts the connected role satisfies ADR-001: not a superuser, no
      // BYPASSRLS, owns no table in the schema.
      const gateway = await createPostgresPersistence();
      if (!gateway) failures.push("DATABASE_URL is set but no PostgreSQL connection could be created.");
    } catch (error) {
      failures.push(`PostgreSQL is unusable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Refusing to start:\n  - ${failures.join("\n  - ")}`);
  }
}
