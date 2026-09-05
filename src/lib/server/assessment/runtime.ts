import "server-only";

/**
 * Shared plumbing for every assessment module.
 *
 * The pool, the transaction wrappers, the ltree scope derivation, the role
 * predicates, the row coercions and the audit append were each written out
 * again in five files: assessment-store, assessment-list-store, the two attempt
 * write stores and the submit store. Five copies of an authorization predicate
 * is five places for one of them to drift, and a drifted copy is not a bug you
 * find by reading — it is one you find when a marker sees a queue item they are
 * then refused permission to grade.
 *
 * Everything here is the single definition. A module that needs a different
 * rule should say so explicitly at its call site rather than keeping a private
 * near-copy of this one.
 */

import type { Principal } from "../auth";
import { signAuditEvent } from "../db/audit-chain";
import {
  assertRuntimeRoleIsSafe, inspectRuntimeRole, loadPgModule, withTenantTransaction,
  type Pool, type PoolClient,
} from "../db/driver";
import { pathToLtree, pathsToLtree } from "../db/ids";
import * as map from "../db/mapping";
import { scopeForPrincipal } from "../tenant-runtime";

let poolPromise: Promise<Pool> | null = null;

/**
 * One pool per process, created on first use.
 *
 * `assertRuntimeRoleIsSafe` runs once here and throws if the connected role has
 * BYPASSRLS, is a superuser, or owns a table in the schema — any of which turns
 * every tenant_isolation policy off. That is a fatal condition, not a warning.
 */
export async function assessmentPool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required: the assessment engine has no local-fixture implementation.");
  }
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await loadPgModule();
      if (!pg) throw new Error("PostgreSQL driver is unavailable");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
      assertRuntimeRoleIsSafe(await inspectRuntimeRole(pool));
      return pool;
    })();
  }
  return poolPromise;
}

/** Read inside a READ ONLY transaction that has already set the tenant context. */
export async function readTx<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(await assessmentPool(), scopeForPrincipal(principal), run, { readOnly: true });
}

/** Write inside a transaction that has already set the tenant context. */
export async function writeTx<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(await assessmentPool(), scopeForPrincipal(principal), run);
}

/**
 * The two ltree forms every scoped query needs.
 *
 * `roots` are the delegated subtrees the caller administers: a row is theirs
 * when `path <@ ANY(roots)`. `viewer` is their own organization: content owned
 * at or above it is delivered to them, which is `path @> viewer`. Authoring
 * scope and delivery scope are different questions and both are needed.
 */
export function scopePaths(principal: Principal): { roots: string[]; viewer: string } {
  const scope = scopeForPrincipal(principal);
  return { roots: pathsToLtree(scope.orgScopes), viewer: pathToLtree(scope.viewerOrgPath) };
}

/* ---------------------------------------------------------------------------
 * Role predicates.
 *
 * Named for what the holder may DO, not for the role string, so a call site
 * reads as a permission check rather than as a membership test — and so adding
 * `instructor` or `learning_admin` to the vocabulary is one edit here.
 * ------------------------------------------------------------------------- */

export const canAuthorAssessments = (principal: Principal): boolean =>
  principal.roles.some((role) => role === "tenant_admin" || role === "tna_analyst");

export const canGradeAssessments = (principal: Principal): boolean =>
  principal.roles.some((role) => role === "tenant_admin" || role === "assessor");

export const canAttemptAssessments = (principal: Principal): boolean =>
  principal.roles.includes("learner");

/* ---------------------------------------------------------------------------
 * Row coercions.
 *
 * node-postgres returns `numeric` as a string and `timestamptz` as a Date, so
 * every mapper needs these and every mapper had its own copy.
 * ------------------------------------------------------------------------- */

export const num = (value: unknown): number => (typeof value === "number" ? value : Number(value));
export const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
export const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
export const bool = (value: unknown): boolean => value === true || value === "true" || value === "t";
export const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));

/**
 * Appends one hash-chained audit event inside the caller's transaction.
 *
 * The advisory lock serialises writers on this tenant's chain head. Two
 * concurrent appends that both read the same head would fork the ledger, and a
 * forked ledger cannot be repaired: the table is append-only by trigger.
 */
export async function appendAssessmentAudit(
  client: PoolClient,
  principal: Principal,
  requestId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  const scope = scopeForPrincipal(principal);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`osa.audit:${scope.tenantId}`]);
  const { rows } = await client.query(
    "SELECT a.id,a.tenant_id,a.actor_user_id,a.action,a.resource_type,a.resource_id,a.outcome,a.occurred_at,a.request_id,a.metadata,a.previous_hash,a.event_hash FROM osa.audit_events a ORDER BY a.sequence DESC LIMIT 1",
  );
  const event = signAuditEvent(rows[0] ? map.toAuditEvent(rows[0]) : null, {
    tenantId: scope.tenantId, actorUserId: scope.userId, action, resourceType, resourceId,
    outcome: "success", requestId, metadata,
  });
  await client.query(
    `INSERT INTO osa.audit_events (id,tenant_id,actor_user_id,action,resource_type,resource_id,outcome,request_id,metadata,occurred_at,previous_hash,event_hash)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::jsonb,$10::timestamptz,$11,$12)`,
    [event.id, event.tenantId, event.actorUserId, event.action, event.resourceType, event.resourceId,
     event.outcome, event.requestId, JSON.stringify(event.metadata), event.occurredAt,
     map.hashToBytes(event.previousHash), map.hashToBytes(event.hash)],
  );
}
