/**
 * PostgreSQL persistence layer — built, tested, and NOT wired in.
 *
 * `src/lib/server/store.ts` remains the default datastore. Nothing under
 * `src/app/**` imports this module: the point of this work is to de-risk the
 * migration by proving the layer, not to perform the cutover. See
 * `docs/ADR-002-persistence-migration.md` for the cutover plan and
 * `database/postgres/README-migration.md` for what must change in existing
 * files before the switch can be thrown.
 */

export type {
  ActorScope, AuditInput, CompletionResult, CourseWithModules, EnrollmentWithProgress,
  GapCaseWithContext, NotificationDraft, OsaPersistence, OsaRepository, PrincipalRecord,
  ReadinessSummary, SessionRef, Uuid,
} from "./repository";

export {
  assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, setTenantContext,
  TenantContextError, withTenantTransaction,
} from "./driver";
export type { Pool, PoolClient, Queryable, RuntimeRoleReport } from "./driver";

export { createPostgresPersistence, csrfMatches, PostgresPersistence, scopeFromPrincipal } from "./postgres";
export { digestOf, signAuditEvent } from "./audit-chain";

export {
  isUuid, LEGACY_ID_NAMESPACE, ltreeToPath, ltreeToPaths, newId, pathToLtree,
  pathsToLtree, toStorageId, toStorageIdOrNull, toStorageIds, uuidV5,
} from "./ids";
