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

  if (!process.env.AUTH_SECRET) {
    // auth.ts refuses to issue a session without this, so an instance missing it
    // boots cleanly, serves every page, and then returns 500 from POST
    // /api/auth/login - nobody can sign in and the reason is only in a server
    // log. Found by running the production bundle against a real database with
    // AUDIT_HASH_SECRET and DATABASE_URL set and AUTH_SECRET not.
    failures.push("AUTH_SECRET is not set; no session can be issued and every sign-in would fail.");
  }

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

  const controlPlaneUrl = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (controlPlaneUrl) {
    try {
      // The SaaS control plane crosses tenant boundaries only to provision the
      // minimum customer identity records. It must therefore use its own
      // deliberately restricted login and never a migration owner, Neon
      // `neon_superuser` member, or any BYPASSRLS connection.
      const { assertControlPlaneConnectionSafe } = await import("./lib/server/control-plane-readiness");
      await assertControlPlaneConnectionSafe(controlPlaneUrl);
    } catch (error) {
      failures.push(`Control-plane database role is unusable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Refusing to start:\n  - ${failures.join("\n  - ")}`);
  }
}
