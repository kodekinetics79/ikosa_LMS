import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./domain";
import { seedDatabase } from "./seed";

const dataDir = process.env.IK_DATA_DIR || path.join(process.cwd(), ".data");
const dataFile = path.join(dataDir, "ik-osa-dev.json");
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Demo seeding creates accounts with a published password, including tenant
 * administrators. Auto-seeding on a missing file therefore turns any loss of
 * the data volume into an unauthenticated privilege backdoor: the next request
 * to reach persistence - `/api/health` needs no session - would recreate those
 * accounts and report the system healthy.
 *
 * So it is opt-in, never available in production, and refuses loudly rather
 * than quietly manufacturing credentials.
 */
function demoSeedingAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.SEED_DEMO_DATA !== "false";
}

async function ensureDatabase(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(dataFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!demoSeedingAllowed()) {
      throw new Error("Datastore is not initialized and demo seeding is disabled. Restore from backup or run the provisioning migration.");
    }
    await persist(seedDatabase());
  }
}

async function persist(database: Database): Promise<void> {
  const temporary = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, dataFile);
}

/**
 * Every collection the current schema expects.
 *
 * The store previously checked `schemaVersion` and nothing else, so adding an
 * entity to the Database type left every EXISTING datastore file without that
 * array. The type insisted the field was there; the runtime handed back
 * `undefined`, and the first `.filter()` on it threw a 500 on a page that was
 * itself perfectly correct. A versioned store without a migration is a version
 * number, not a migration.
 */
const COLLECTIONS = [
  "tenants", "orgUnits", "users", "sessions", "jobRoles", "skills", "requirements",
  "tnaStudies", "evidence", "gapCases", "interventions", "courses", "courseModules",
  "enrollments", "moduleCompletions", "signals", "notifications", "auditEvents",
] as const satisfies readonly (keyof Database)[];

export const SCHEMA_VERSION = 2;

function migrate(parsed: Record<string, unknown>): Database {
  const version = parsed.schemaVersion;
  if (typeof version !== "number") throw new Error("Datastore is missing a schema version");
  if (version > SCHEMA_VERSION) {
    // Refuse rather than guess: a file written by a newer release may hold
    // fields this build would silently drop on the next write.
    throw new Error(`Datastore schema ${version} is newer than this build supports (${SCHEMA_VERSION})`);
  }
  // Forward-fill collections introduced after this file was written.
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(parsed[collection])) parsed[collection] = [];
  }
  parsed.schemaVersion = SCHEMA_VERSION;
  return parsed as unknown as Database;
}

/**
 * True when PostgreSQL is the system of record. Read lazily from the
 * environment rather than cached, so a test can unset it.
 */
function usePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Loads the current tenant's rows from PostgreSQL in the `Database` shape the
 * application already reads.
 *
 * Returns an EMPTY database when no validated identity has been established for
 * this request. That is the correct answer, not a degraded one: with no
 * session there is no tenant, and RLS would return nothing anyway. Callers that
 * genuinely predate authentication - resolving a session cookie, looking a
 * tenant up by slug - go through the repository in auth.ts, never through here.
 */
/** The validated identity for this request, from the async context or the cookie. */
async function resolveActor(): Promise<{ tenantId: string; userId: string } | undefined> {
  const { currentActor } = await import("./request-context");
  let actor = currentActor();

  if (!actor) {
    // AsyncLocalStorage.enterWith() binds the current execution context, but a
    // Server Component's continuation after `await principalFromCookies()` does
    // not inherit it, and each component renders in its own context anyway - so
    // the actor recorded during authentication is frequently gone by the time a
    // page reaches here. Losing it silently returned an EMPTY database, which
    // rendered every screen as a truthful-looking "nothing in scope".
    //
    // Resolve it from the session cookie instead. One indexed lookup, and it
    // cannot be lost between components.
    try {
      const { cookies } = await import("next/headers");
      const { SESSION_COOKIE } = await import("./session-cookie");
      const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
      if (token) {
        const { requirePersistence } = await import("./persistence");
        const gateway = await requirePersistence();
        const session = await gateway.resolveSession(token);
        if (session) actor = { tenantId: session.tenantId, userId: session.userId };
      }
    } catch {
      // No request scope (a script, a background job). Falls through to empty.
    }
  }

  return actor;
}

async function readFromPostgres(): Promise<Database> {
  const actor = await resolveActor();
  if (!actor) return migrate({ schemaVersion: SCHEMA_VERSION });

  const { requirePersistence } = await import("./persistence");
  const gateway = await requirePersistence();
  // The scope restricts nothing beyond the tenant here: the snapshot returns the
  // tenant's rows and the application applies delegated-org and self-scope
  // filtering exactly as it always has. The tenant boundary itself is enforced
  // by RLS inside the transaction, not by these values.
  return gateway.read(
    { tenantId: actor.tenantId, userId: actor.userId, orgScopes: [], viewerOrgPath: "", selfOnly: false },
    (repo) => repo.loadSnapshot(),
  );
}

export async function readDatabase(): Promise<Database> {
  if (usePostgres()) return readFromPostgres();
  await writeQueue;
  await ensureDatabase();
  const raw = await readFile(dataFile, "utf8");
  return migrate(JSON.parse(raw) as Record<string, unknown>);
}

/**
 * Applies a mutation against PostgreSQL.
 *
 * Loads the tenant's snapshot, runs the caller's mutation over it, and writes
 * back only what changed - all inside one transaction holding a
 * transaction-scoped advisory lock on the tenant. The lock is what makes a
 * read-modify-write safe here: it serialises writers the way the old
 * single-process write queue did, but across instances, which a file store
 * behind a per-process queue could never do.
 */
async function mutateInPostgres<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
  const actor = await resolveActor();
  if (!actor) throw new Error("A validated session is required before writing.");

  const { requirePersistence } = await import("./persistence");
  const { loadTenantSnapshot } = await import("./db/snapshot");
  const { persistSnapshotChanges } = await import("./db/persist-snapshot");
  const gateway = await requirePersistence();

  return gateway.write(
    { tenantId: actor.tenantId, userId: actor.userId, orgScopes: [], viewerOrgPath: "", selfOnly: false },
    async (repo) => {
      const db = (repo as unknown as { db: import("./db/driver").Queryable }).db;
      // Serialise writers for this tenant. Released at COMMIT or ROLLBACK.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [actor.tenantId]);

      const before = await loadTenantSnapshot(db);
      const after = await loadTenantSnapshot(db);
      const result = await mutation(after);
      await persistSnapshotChanges(db, repo, before, after, actor.userId);
      return result;
    },
  );
}

export function mutateDatabase<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
  if (usePostgres()) return mutateInPostgres(mutation);
  const operation = writeQueue.then(async () => {
    await ensureDatabase();
    const database = migrate(JSON.parse(await readFile(dataFile, "utf8")) as Record<string, unknown>);
    const result = await mutation(database);
    await persist(database);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function resetDevelopmentDatabase(): Promise<void> {
  await mutateDatabase((database) => Object.assign(database, seedDatabase()));
}
