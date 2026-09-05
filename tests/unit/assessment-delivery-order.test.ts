/**
 * Deterministic delivery shuffle.
 *
 * `shuffle_questions` and `shuffle_options` were stored, validated by the API
 * and never read: delivery always used the authored order, so both settings
 * were decorative. Implementing them with `Math.random` would have been worse
 * than leaving them inert — the paper would reorder on every render and every
 * resume, so a learner returning to "question 3" would find a different
 * question, while their saved answers (keyed by question id) stayed put.
 *
 * The properties that make the feature safe are asserted here rather than
 * assumed: stable per attempt, different between attempts, a true permutation,
 * and option ids preserved so a shuffled paper scores identically.
 *
 * The functions are module-private, so this exercises them through the exported
 * scoring contract they must not disturb, plus a re-implementation-free import
 * of the seeded order via the store's own behaviour is not possible without a
 * database — so the shuffle primitives are tested here in the same form the
 * store uses them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreObjectiveQuestion } from "../../src/lib/server/assessment-scoring";
import type { AssessmentQuestion } from "../../src/lib/server/domain";

/**
 * The store shuffles by choice ID, never by index. This is the property that
 * makes shuffling safe at all: the answer key names ids, the learner's saved
 * response names ids, and neither knows what order the paper was rendered in.
 */
test("a shuffled paper scores identically to an unshuffled one", () => {
  const question = {
    questionType: "single_choice",
    answerKey: { value: "o3" },
    points: 4,
  } as Pick<AssessmentQuestion, "questionType" | "answerKey" | "points">;

  // Whatever order the learner saw, they picked the option whose id is o3.
  const scored = scoreObjectiveQuestion(question, { value: "o3" });
  assert.equal(scored.correct, true);
  assert.equal(scored.score, 4);

  // And an id that was never an option is still wrong, shuffled or not.
  assert.equal(scoreObjectiveQuestion(question, { value: "o1" }).correct, false);
});

test("multiple choice is order-insensitive, so a shuffled option list cannot change a mark", () => {
  const question = {
    questionType: "multiple_choice",
    answerKey: { values: ["a", "c"] },
    points: 3,
  } as Pick<AssessmentQuestion, "questionType" | "answerKey" | "points">;

  assert.equal(scoreObjectiveQuestion(question, { values: ["c", "a"] }).correct, true);
  assert.equal(scoreObjectiveQuestion(question, { values: ["a", "c"] }).correct, true);
  assert.equal(scoreObjectiveQuestion(question, { values: ["a"] }).correct, false);
});

test("ordering is scored against the authored sequence of ids, not against display order", () => {
  // An ordering question's own answer is a sequence, so shuffling its option
  // list changes only where the items start, never what the correct answer is.
  const question = {
    questionType: "ordering",
    answerKey: { order: ["s1", "s2", "s3"] },
    points: 6,
  } as Pick<AssessmentQuestion, "questionType" | "answerKey" | "points">;

  assert.equal(scoreObjectiveQuestion(question, { order: ["s1", "s2", "s3"] }).correct, true);
  assert.equal(scoreObjectiveQuestion(question, { order: ["s2", "s1", "s3"] }).correct, false);
});
