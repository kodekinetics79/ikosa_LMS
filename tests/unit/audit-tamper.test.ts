import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-tamper-"));
process.env.IK_DATA_DIR = isolatedDataDir;
process.env.AUDIT_HASH_SECRET = "test-audit-secret-not-the-published-default";

const modules = Promise.all([
  import("../../src/lib/server/audit"),
  import("../../src/lib/server/store"),
]);

async function seedEvents(count: number, tenantId = "ten_northstar") {
  const [audit] = await modules;
  for (let index = 0; index < count; index += 1) {
    await audit.appendAudit({
      tenantId,
      actorUserId: "usr_admin",
      action: "test.event",
      resourceType: "test",
      resourceId: `res_${index}`,
      outcome: "success",
      requestId: `req_${index}`,
    });
  }
}

test("a clean chain verifies for the tenant slice an auditor can actually see", async () => {
  const [audit] = await modules;
  await seedEvents(4);
  const result = await audit.verifyAuditChain("ten_northstar");
  assert.equal(result.valid, true);
  assert.equal(result.scope, "ten_northstar");
  assert.ok(result.checked >= 4);
});

test("interleaved traffic from another tenant does not break a tenant's chain", async () => {
  const [audit] = await modules;
  // The previous implementation chained to the globally-last event, so any
  // other tenant writing between two of yours left your slice unverifiable.
  await seedEvents(1, "ten_northstar");
  await seedEvents(1, "ten_gulf");
  await seedEvents(1, "ten_northstar");
  await seedEvents(1, "ten_gulf");
  await seedEvents(1, "ten_northstar");

  assert.equal((await audit.verifyAuditChain("ten_northstar")).valid, true);
  assert.equal((await audit.verifyAuditChain("ten_gulf")).valid, true);
  assert.equal((await audit.verifyAuditChain()).valid, true);
});

test("editing a recorded event's content is detected as a hash mismatch", async () => {
  const [audit, store] = await modules;
  await seedEvents(3);

  const targetId = await store.mutateDatabase((database) => {
    const target = database.auditEvents.find((event) => event.tenantId === "ten_northstar" && event.outcome === "success");
    assert.ok(target);
    // Rewrite history without touching the digest, exactly what an attacker
    // with datastore write access would attempt.
    target.outcome = "denied";
    return target.id;
  });

  const result = await audit.verifyAuditChain("ten_northstar");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "hash_mismatch");
  assert.equal(result.invalidEventId, targetId);
});

test("deleting an event from the middle of the chain is detected as a broken link", async () => {
  const [audit, store] = await modules;
  await store.resetDevelopmentDatabase();
  await seedEvents(5);

  await store.mutateDatabase((database) => {
    const events = database.auditEvents.filter((event) => event.tenantId === "ten_northstar");
    const victim = events[2];
    database.auditEvents = database.auditEvents.filter((event) => event.id !== victim.id);
  });

  const result = await audit.verifyAuditChain("ten_northstar");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "broken_link");
});

test("a forged event cannot be signed without the chain secret", async () => {
  const [audit, store] = await modules;
  await store.resetDevelopmentDatabase();
  await seedEvents(3);

  await store.mutateDatabase((database) => {
    const events = database.auditEvents.filter((event) => event.tenantId === "ten_northstar");
    const last = events.at(-1)!;
    // Forge a plausible entry chained onto the real tip. Under the previous
    // plain SHA-256 scheme this was trivially computable from the rows alone.
    database.auditEvents.push({
      ...last,
      id: "aud_forged",
      action: "evidence.create",
      resourceId: "ev_forged",
      occurredAt: new Date().toISOString(),
      previousHash: last.hash,
      hash: "0".repeat(64),
    });
  });

  const result = await audit.verifyAuditChain("ten_northstar");
  assert.equal(result.valid, false);
  assert.equal(result.invalidEventId, "aud_forged");
  assert.equal(result.reason, "hash_mismatch");
});
