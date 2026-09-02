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

export async function readDatabase(): Promise<Database> {
  await writeQueue;
  await ensureDatabase();
  const raw = await readFile(dataFile, "utf8");
  return migrate(JSON.parse(raw) as Record<string, unknown>);
}

export function mutateDatabase<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
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
