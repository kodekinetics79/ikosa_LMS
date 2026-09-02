import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const isolatedDataDir = mkdtempSync(path.join(tmpdir(), "ik-osa-learning-"));
process.env.IK_DATA_DIR = isolatedDataDir;

const modules = Promise.all([
  import("../../src/lib/server/store"),
  import("../../src/lib/server/learning"),
  import("../../src/lib/server/domain-service"),
  import("../../src/lib/server/auth"),
]);

/** Runs a scenario against a throwaway copy of the seeded database. */
async function scenario<T>(run: (state: import("../../src/lib/server/domain").Database, learning: typeof import("../../src/lib/server/learning")) => T): Promise<T> {
  const [store, learning] = await modules;
  const state = structuredClone(await store.readDatabase());
  return run(state, learning);
}

function enrollmentFor(state: import("../../src/lib/server/domain").Database, id: string) {
  const enrollment = state.enrollments.find((candidate) => candidate.id === id);
  assert.ok(enrollment, `expected seeded enrollment ${id}`);
  return enrollment;
}

test("passing an assessed course emits verified evidence at the course's target level", async () => {
  const evidence = await scenario((state, learning) => {
    const enrollment = enrollmentFor(state, "enr_sam_loto");
    learning.recordModuleCompletion(state, enrollment, "mod_loto_3", null);
    return learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.92).evidence;
  });

  assert.ok(evidence, "expected evidence to be emitted");
  assert.equal(evidence.skillId, "skill_loto");
  assert.equal(evidence.proficiencyLevel, 4);
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.strength, 0.92);
  // Machine-attested from an assessment: no human is credited as assessor.
  assert.equal(evidence.assessorUserId, null);
  assert.match(evidence.sourceReference, /COURSE:LOTO-401 v3 \/ ENROLLMENT:enr_sam_loto/);
  assert.ok(evidence.expiresAt, "a course with validityMonths must set an expiry");
});

test("failing the assessment emits no evidence and leaves the enrollment retakeable", async () => {
  const { outcome, enrollment } = await scenario((state, learning) => {
    const enrollment = enrollmentFor(state, "enr_sam_loto");
    learning.recordModuleCompletion(state, enrollment, "mod_loto_3", null);
    const outcome = learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.6);
    return { outcome, enrollment };
  });

  assert.equal(outcome.evidence, null);
  assert.equal(outcome.evidenceWithheldReason, "assessment_not_passed");
  // A failed attempt must not close the enrollment, or the retake the whole
  // intervention depends on becomes impossible.
  assert.equal(enrollment.status, "in_progress");
  assert.equal(enrollment.completedAt, null);
});

test("a retake after a failure emits evidence carrying the passing score", async () => {
  const { outcome, enrollment } = await scenario((state, learning) => {
    const enrollment = enrollmentFor(state, "enr_sam_loto");
    learning.recordModuleCompletion(state, enrollment, "mod_loto_3", null);
    learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.6);
    const outcome = learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.88);
    return { outcome, enrollment };
  });

  assert.ok(outcome.evidence);
  assert.equal(outcome.evidence.strength, 0.88);
  assert.equal(enrollment.status, "completed");
});

test("an attendance-only course records completion but refuses to evidence competence", async () => {
  const { outcome, evidenceCount } = await scenario((state, learning) => {
    const before = state.evidence.length;
    const enrollment = {
      id: "enr_test_storm", tenantId: "ten_northstar", orgUnitId: "org_ns_south", courseId: "crs_storm",
      subjectUserId: "usr_learner", source: "self" as const, interventionId: null, gapCaseId: null,
      status: "enrolled" as const, assignedByUserId: null, dueDate: null, startedAt: null,
      completedAt: null, score: null, evidenceId: null, createdAt: new Date().toISOString(),
    };
    state.enrollments.push(enrollment);
    const outcome = learning.recordModuleCompletion(state, enrollment, "mod_storm_1", null);
    return { outcome, evidenceCount: state.evidence.length - before };
  });

  assert.equal(outcome.enrollment.status, "completed");
  assert.equal(outcome.evidence, null);
  assert.equal(outcome.evidenceWithheldReason, "attendance_only");
  // Watching a briefing is not proof anyone can do the work.
  assert.equal(evidenceCount, 0);
});

test("replaying the same completion does not emit a second evidence record", async () => {
  const { first, second, evidenceCount } = await scenario((state, learning) => {
    const before = state.evidence.length;
    const enrollment = enrollmentFor(state, "enr_sam_loto");
    learning.recordModuleCompletion(state, enrollment, "mod_loto_3", null);
    const first = learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.92).evidence;
    const second = learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.92).evidence;
    return { first, second, evidenceCount: state.evidence.length - before };
  });

  assert.ok(first);
  assert.equal(second, null, "a replayed completion must not mint new evidence");
  assert.equal(evidenceCount, 1);
});

test("emitted evidence closes the matching gap case and lifts readiness", async () => {
  const { gap, before, after } = await scenario((state, learning) => {
    const gapBefore = state.gapCases.find((candidate) => candidate.id === "gap_loto");
    const before = { evidenced: gapBefore?.evidencedLevel, gap: gapBefore?.gap };

    const enrollment = enrollmentFor(state, "enr_sam_loto");
    learning.recordModuleCompletion(state, enrollment, "mod_loto_3", null);
    const outcome = learning.recordModuleCompletion(state, enrollment, "mod_loto_4", 0.92);
    assert.ok(outcome.evidence);
    const touched = learning.refreshGapsForEvidence(state, outcome.evidence);

    const gap = state.gapCases.find((candidate) => candidate.id === "gap_loto");
    return { gap, before, after: { touched, evidenced: gap?.evidencedLevel, gap: gap?.gap } };
  });

  assert.equal(before.evidenced, 2);
  assert.equal(before.gap, 2);
  assert.equal(after.evidenced, 4);
  assert.equal(after.gap, 0);
  assert.ok(after.touched.includes("gap_loto"));
  // Closure is a human decision; reaching level only moves it to actioned.
  assert.equal(gap?.status, "actioned");
});

test("expired evidence does not count toward closing a gap", async () => {
  const evidencedLevel = await scenario((state, learning) => {
    const expired = {
      id: "ev_expired", tenantId: "ten_northstar", orgUnitId: "org_ns_south", subjectUserId: "usr_learner",
      skillId: "skill_diag", type: "assessment" as const, proficiencyLevel: 5, strength: 1,
      observedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z",
      assessorUserId: null, sourceReference: "legacy", status: "verified" as const,
    };
    state.evidence.push(expired);
    learning.refreshGapsForEvidence(state, expired);
    return state.gapCases.find((candidate) => candidate.id === "gap_diag")?.evidencedLevel;
  });

  // The lapsed level-5 record must not be treated as current capability.
  assert.equal(evidencedLevel, 2);
});

test("a learner cannot see another learner's enrollments", async () => {
  const [store, , domainService, auth] = await modules;
  const database = await store.readDatabase();
  const result = await auth.login("technician@northstar.example", "Demo!2026", crypto.randomUUID());
  const request = new Request("http://localhost/api/enrollments", { headers: { cookie: `${auth.SESSION_COOKIE}=${result.session.id}` } });
  const principal = await auth.principalFromRequest(request);

  const foreign = {
    ...database.enrollments[0],
    id: "enr_someone_else",
    subjectUserId: "usr_manager",
  };
  const visible = domainService.visibleRows(database, principal, "enrollment:read", [...database.enrollments, foreign]);

  assert.ok(visible.every((row) => row.subjectUserId === principal.user.id));
  assert.equal(visible.some((row) => row.id === "enr_someone_else"), false);
});
