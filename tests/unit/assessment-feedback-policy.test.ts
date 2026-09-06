/**
 * When a learner may see their per-question marks.
 *
 * `feedback_mode` was stored, validated by the API, transported to the player
 * and never read. An `immediate` assessment and an `after_close` one gave the
 * learner the identical (empty) treatment, so the setting was decorative in
 * both directions — nothing was revealed early and nothing was revealed late.
 *
 * The rule is small enough to state and therefore small enough to test
 * exhaustively, which matters because both failure directions are bad: too
 * early lets a learner who finished brief one who has not started, too late
 * withholds a mark somebody is entitled to.
 *
 * Note what the policy does NOT cover, and what these tests do not assert:
 * answer keys, rationales and grading notes are never disclosed by any of this,
 * in any mode. That is a select-list boundary in the query, not a policy toggle.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseDecision } from "../../src/lib/server/assessment/feedback-policy";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PAST = "2026-09-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";

test("immediate releases marks even while the attempt is still open", () => {
  const decision = releaseDecision("immediate", "in_progress", null, NOW);
  assert.equal(decision.released, true);
  assert.equal(decision.reason, "released");
});

test("after_submit withholds until the learner has submitted", () => {
  assert.equal(releaseDecision("after_submit", "in_progress", null, NOW).released, false);
  assert.equal(releaseDecision("after_submit", "in_progress", null, NOW).reason, "awaiting_submission");
  assert.equal(releaseDecision("after_submit", "submitted", null, NOW).released, true);
  assert.equal(releaseDecision("after_submit", "graded", null, NOW).released, true);
});

test("after_close withholds until the assessment has closed, even after grading", () => {
  // This is the anti-collusion case: a learner who finished early must not be
  // able to tell one who has not started which answers were right.
  const early = releaseDecision("after_close", "graded", FUTURE, NOW);
  assert.equal(early.released, false);
  assert.equal(early.reason, "awaiting_close");

  assert.equal(releaseDecision("after_close", "graded", PAST, NOW).released, true);
  assert.equal(releaseDecision("after_close", "submitted", PAST, NOW).released, true);
});

test("after_close on an assessment with no closing time still releases", () => {
  // "After a moment that never arrives" is not a policy, it is a mark withheld
  // for ever. It degrades to after_submit rather than to silence.
  assert.equal(releaseDecision("after_close", "graded", null, NOW).released, true);
  assert.equal(releaseDecision("after_close", "in_progress", null, NOW).released, false, "but still not mid-attempt");
});

test("an in-progress attempt never releases marks except under immediate", () => {
  for (const mode of ["after_submit", "after_close"] as const) {
    assert.equal(releaseDecision(mode, "in_progress", PAST, NOW).released, false, mode);
  }
});

test("the closing instant itself releases", () => {
  // A boundary that is off by one direction leaves a mark withheld for the
  // lifetime of the assessment; the other direction discloses a second early.
  const closesNow = NOW.toISOString();
  assert.equal(releaseDecision("after_close", "graded", closesNow, NOW).released, true);
  const closesInAMillisecond = new Date(NOW.getTime() + 1).toISOString();
  assert.equal(releaseDecision("after_close", "graded", closesInAMillisecond, NOW).released, false);
});
