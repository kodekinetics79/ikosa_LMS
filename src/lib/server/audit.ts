import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuditEvent, Database } from "./domain";
import { id } from "./security";
import { mutateDatabase, readDatabase } from "./store";

export type AuditInput = Pick<AuditEvent, "tenantId" | "actorUserId" | "action" | "resourceType" | "resourceId" | "outcome" | "requestId"> & {
  metadata?: AuditEvent["metadata"];
};

const DEVELOPMENT_SECRET = "development-audit-secret-replace-me";

/**
 * The ledger is keyed so that tamper-evidence survives an attacker who can
 * write to the datastore. A plain SHA-256 chain can be silently recomputed by
 * anyone holding the rows; an HMAC cannot without the server secret.
 */
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

/**
 * Deterministic serialization. The previous implementation relied on object
 * literal key order, so an unrelated refactor of the field order would have
 * invalidated every historical signature.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(event: Omit<AuditEvent, "hash">): string {
  return createHmac("sha256", tenantKey(event.tenantId)).update(canonical(event)).digest("hex");
}

function digestMatches(event: AuditEvent): boolean {
  const { hash, ...unsigned } = event;
  const expected = Buffer.from(digest(unsigned), "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Appends to a database object that is ALREADY inside a mutation.
 *
 * A domain write and its ledger entry used to be two separate transactions, so
 * a crash between them left a competence record changed with nothing in the
 * audit trail. Callers that mutate state should record the event through this,
 * inside the same mutation, so both land together or neither does.
 */
export function appendAuditWithin(database: Database, input: AuditInput): AuditEvent {
  const previous = database.auditEvents.filter((event) => event.tenantId === input.tenantId).at(-1);
  const unsigned: Omit<AuditEvent, "hash"> = {
    id: id(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    occurredAt: new Date().toISOString(),
    requestId: input.requestId,
    metadata: input.metadata ?? {},
    previousHash: previous?.hash ?? "GENESIS",
  };
  const event = { ...unsigned, hash: digest(unsigned) };
  database.auditEvents.push(event);
  return event;
}

export async function appendAudit(input: AuditInput): Promise<AuditEvent> {
  // Delegates to appendAuditWithin so the chaining rule exists exactly once.
  return mutateDatabase((database) => appendAuditWithin(database, input));
}

export type ChainVerification = {
  valid: boolean;
  checked: number;
  scope: string;
  invalidEventId?: string;
  reason?: "hash_mismatch" | "broken_link";
};

/**
 * Verifies the chain a caller is actually entitled to see. Passing a tenantId
 * verifies exactly the slice the audit API returns, so the integrity claim on
 * screen corresponds to the evidence on screen.
 */
export async function verifyAuditChain(tenantId?: string): Promise<ChainVerification> {
  const { auditEvents } = await readDatabase();
  const scoped = tenantId ? auditEvents.filter((event) => event.tenantId === tenantId) : auditEvents;

  if (!tenantId) {
    // Global verification checks each tenant's chain independently.
    const tenants = [...new Set(scoped.map((event) => event.tenantId))];
    let checked = 0;
    for (const tenant of tenants) {
      const result = await verifyAuditChain(tenant);
      checked += result.checked;
      if (!result.valid) return { ...result, checked, scope: "all-tenants" };
    }
    return { valid: true, checked, scope: "all-tenants" };
  }

  let previousHash = "GENESIS";
  for (const [index, event] of scoped.entries()) {
    if (event.previousHash !== previousHash) {
      return { valid: false, checked: index, scope: tenantId, invalidEventId: event.id, reason: "broken_link" };
    }
    if (!digestMatches(event)) {
      return { valid: false, checked: index, scope: tenantId, invalidEventId: event.id, reason: "hash_mismatch" };
    }
    previousHash = event.hash;
  }
  return { valid: true, checked: scoped.length, scope: tenantId };
}
