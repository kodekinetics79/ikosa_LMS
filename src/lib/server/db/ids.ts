import { createHash, randomUUID } from "node:crypto";

/**
 * Identifier translation between the JSON store and PostgreSQL.
 *
 * `security.ts::id()` mints `"<prefix>_<24 hex>"` (`ev_9f3c…`), and the seed
 * uses hand-written literals (`ten_northstar`, `usr_learner`). Every id column
 * in `001_initial.sql` is `uuid`. These are not compatible in either direction:
 *
 *     ik_osa=# select 'ten_northstar'::uuid;
 *     ERROR:  invalid input syntax for type uuid: "ten_northstar"
 *
 * The migration therefore has to assign a uuid to every existing row. Doing it
 * with `gen_random_uuid()` would be simplest and is wrong: the mapping would
 * exist only in whatever table the backfill happened to write, so a bookmarked
 * `/studies/tna_field_2026`, a `sourceReference` naming an enrollment id, or a
 * re-run of the backfill after a rollback would all break.
 *
 * Instead the uuid is *derived* from the legacy id: RFC 4122 version 5 (SHA-1)
 * under a fixed namespace. That makes it deterministic, so:
 *
 *   * the backfill is idempotent and re-runnable after a rollback;
 *   * a legacy id arriving in a URL resolves without a lookup table;
 *   * the same answer is computed in TypeScript here and in SQL, so an operator
 *     verifying a row by hand gets the value the application would.
 *
 * Ids minted *after* cutover are ordinary random uuids: `newId()`. Nothing
 * derives them from a prefix, so the prefix convention ends at the boundary.
 *
 * REQUIRED CHANGE TO AN EXISTING FILE (not made here): at cutover,
 * `src/lib/server/security.ts::id()` must return `randomUUID()`. Until it does,
 * the adapter is the only thing minting identifiers that PostgreSQL accepts.
 */

/** uuid v5 namespace for iK OSA legacy identifiers. Never change this value. */
export const LEGACY_ID_NAMESPACE = "6f0f8a1e-1c2f-5b3d-9a4c-7e1b2d3f4a5c";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * RFC 4122 §4.3 name-based uuid, SHA-1 variant.
 *
 * The SQL equivalent, for the backfill and for manual verification:
 *
 *   CREATE FUNCTION osa.legacy_uuid(p_legacy text) RETURNS uuid ...
 *     -- see database/postgres/README-migration.md
 */
export function uuidV5(name: string, namespace: string = LEGACY_ID_NAMESPACE): string {
  const digest = createHash("sha1").update(uuidToBytes(namespace)).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/**
 * Accepts either representation and returns the uuid PostgreSQL will store.
 * A value that is already a uuid passes through untouched, so this is safe to
 * apply to every id crossing the boundary during and after cutover.
 */
export function toStorageId(value: string): string {
  return isUuid(value) ? value.toLowerCase() : uuidV5(value);
}

export function toStorageIds(values: readonly string[]): string[] {
  return values.map(toStorageId);
}

export function toStorageIdOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : toStorageId(value);
}

/** A fresh identifier for a row created after cutover. */
export function newId(): string {
  return randomUUID();
}

/* ---------------------------------------------------------------------------
 * Organizational paths.
 *
 * `OrgUnit.path` is `/org_ns/org_ns_ops` — a leading separator and `/` between
 * segments. `001_initial.sql` types the column `ltree`, which accepts neither:
 *
 *     ik_osa=# select '/org_ns/org_ns_ops'::ltree;
 *     ERROR:  ltree syntax error at character 1
 *
 * ltree is worth keeping: `isOrgInScope()`'s `path.startsWith(scope + "/")` is
 * a linear string test that no index can serve, while `path <@ scope` is a GiST
 * index lookup on the index 001 already creates (`org_units_path_gist`). That
 * is the difference between a delegated-scope filter costing a scan of every
 * row and costing an index probe.
 *
 * PostgreSQL 16 accepts `-` in ltree labels, so a uuid is a valid label as-is
 * and no re-encoding of the identifier itself is needed — verified against
 * 16.4, which is the version compose pins.
 * ------------------------------------------------------------------------- */

/** `/a/b` (domain) -> `a.b` (ltree). Segments are translated to storage ids. */
export function pathToLtree(path: string): string {
  return path.split("/").filter(Boolean).map(toStorageId).join(".");
}

/** `a.b` (ltree) -> `/a/b` (domain). */
export function ltreeToPath(ltree: string): string {
  return ltree ? `/${ltree.split(".").join("/")}` : "";
}

export function pathsToLtree(paths: readonly string[]): string[] {
  return paths.map(pathToLtree);
}

export function ltreeToPaths(values: readonly string[]): string[] {
  return values.map(ltreeToPath);
}
