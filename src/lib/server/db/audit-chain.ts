import { createHmac } from "node:crypto";
import type { AuditEvent } from "../domain";
import { newId } from "./ids";

/**
 * Audit chain signing for the PostgreSQL path.
 *
 * WHY THIS IS NOT A CALL TO `audit.ts`
 * ------------------------------------
 * Everything else in this adapter reuses the domain functions rather than
 * reimplementing them. The audit chain cannot, and the reason is worth stating
 * because it is the sharpest incompatibility the migration has:
 *
 *   * `audit.ts::appendAuditWithin` mints the event id itself, via
 *     `security.ts::id("aud")`, which produces `aud_<24 hex>`.
 *   * `osa.audit_events.id` is `uuid`. `'aud_9f3c…'::uuid` is a syntax error.
 *   * The id is part of the HMAC input. So mapping it to a uuid AFTER signing
 *     produces a row whose stored hash cannot be recomputed from its own
 *     contents: the ledger would fail its own verification on the first read,
 *     and it would fail it silently, reported as `hash_mismatch` on data that
 *     was never actually tampered with.
 *
 * There is no way to inject an id into `appendAuditWithin`, so the digest is
 * computed here over the STORAGE-form event instead — identifiers already
 * mapped, before the HMAC, never after.
 *
 * This duplication is a defect, not a design: two implementations of "is this
 * ledger intact" is exactly the kind of divergence a compliance product must
 * not carry. It is guarded two ways:
 *
 *   1. `digestOf()` is exported, and
 *      tests/integration/postgres-repository.test.mjs asserts it reproduces the
 *      hash `audit.ts` produces for a byte-identical event. The two
 *      implementations cannot drift without that test failing.
 *   2. ADR-002 lists the removal of this file as a cutover task: once
 *      `security.ts::id()` mints uuids, `appendAuditWithin` can be called
 *      directly and this module deletes.
 *
 * Every constant below is copied verbatim from `audit.ts`. Changing one without
 * changing the other invalidates every signature written by the other path.
 */

const DEVELOPMENT_SECRET = "development-audit-secret-replace-me";

function chainSecret(): string {
  const secret = process.env.AUDIT_HASH_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUDIT_HASH_SECRET must be configured before the audit ledger can be written in production");
  }
  return DEVELOPMENT_SECRET;
}

/** Per-tenant key derivation stops a digest from one tenant being replayed into another's chain. */
function tenantKey(tenantId: string): Buffer {
  return createHmac("sha256", chainSecret()).update(`audit-chain:v2:${tenantId}`).digest();
}

/** Key-order-independent serialization, so a field reorder cannot invalidate history. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** Exported solely so the integration test can prove agreement with `audit.ts`. */
export function digestOf(event: Omit<AuditEvent, "hash">): string {
  return createHmac("sha256", tenantKey(event.tenantId)).update(canonical(event)).digest("hex");
}

export type UnsignedAuditInput = Pick<
  AuditEvent, "tenantId" | "actorUserId" | "action" | "resourceType" | "resourceId" | "outcome" | "requestId"
> & { metadata?: AuditEvent["metadata"]; occurredAt?: string };

/**
 * Signs one event onto the tenant's chain.
 *
 * `previous` is the chain head read from `osa.audit_events` ordered by
 * `sequence` — not by `occurred_at`, which ties inside a millisecond and would
 * make the chain order ambiguous under load.
 */
export function signAuditEvent(previous: AuditEvent | null, input: UnsignedAuditInput): AuditEvent {
  const unsigned: Omit<AuditEvent, "hash"> = {
    id: newId(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    requestId: input.requestId,
    metadata: input.metadata ?? {},
    previousHash: previous?.hash ?? "GENESIS",
  };
  return { ...unsigned, hash: digestOf(unsigned) };
}
