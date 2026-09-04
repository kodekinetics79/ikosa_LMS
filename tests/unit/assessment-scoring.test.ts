import test from "node:test";
import assert from "node:assert/strict";
import { percentage, scoreObjectiveQuestion } from "../../src/lib/server/assessment-scoring";

const question = (questionType: Parameters<typeof scoreObjectiveQuestion>[0]["questionType"], answerKey: unknown, points = 2) => ({ questionType, answerKey, points });

test("single choice scores only the exact option id", () => {
  assert.deepEqual(scoreObjectiveQuestion(question("single_choice", { value: "o2" }), { value: "o2" }), { score: 2, manualRequired: false, correct: true });
  assert.deepEqual(scoreObjectiveQuestion(question("single_choice", { value: "o2" }), { value: "o1" }), { score: 0, manualRequired: false, correct: false });
});

test("multiple choice compares sets rather than click order", () => {
  assert.equal(scoreObjectiveQuestion(question("multiple_choice", { values: ["a", "c"] }, 3), { values: ["c", "a"] }).score, 3);
  assert.equal(scoreObjectiveQuestion(question("multiple_choice", { values: ["a", "c"] }, 3), { values: ["a"] }).score, 0);
});

test("true false requires an actual boolean", () => {
  assert.equal(scoreObjectiveQuestion(question("true_false", { value: false }), { value: false }).score, 2);
  assert.equal(scoreObjectiveQuestion(question("true_false", { value: false }), { value: "false" }).score, 0);
});

test("short text normalizes whitespace and case across approved answers", () => {
  const item = question("short_text", { accepted: ["Role based access control", "RBAC"] });
  assert.equal(scoreObjectiveQuestion(item, { value: "  role   based ACCESS control " }).score, 2);
  assert.equal(scoreObjectiveQuestion(item, { value: "R-B-A-C" }).score, 0);
});

test("numeric answers honor explicit tolerance", () => {
  const item = question("numeric", { value: 10, tolerance: 0.25 }, 4);
  assert.equal(scoreObjectiveQuestion(item, { value: 10.2 }).score, 4);
  assert.equal(scoreObjectiveQuestion(item, { value: 10.3 }).score, 0);
});

test("matching requires the exact pair map", () => {
  const item = question("matching", { pairs: { a: "1", b: "2" } });
  assert.equal(scoreObjectiveQuestion(item, { pairs: { b: "2", a: "1" } }).score, 2);
  assert.equal(scoreObjectiveQuestion(item, { pairs: { a: "2", b: "1" } }).score, 0);
});

test("ordering requires exact sequence", () => {
  const item = question("ordering", { order: ["first", "second", "third"] }, 5);
  assert.equal(scoreObjectiveQuestion(item, { order: ["first", "second", "third"] }).score, 5);
  assert.equal(scoreObjectiveQuestion(item, { order: ["second", "first", "third"] }).score, 0);
});

test("long text cannot be auto-graded authoritatively", () => {
  assert.deepEqual(scoreObjectiveQuestion(question("long_text", {}, 10), { value: "A thoughtful essay" }), { score: null, manualRequired: true, correct: null });
});

test("point overrides are applied without changing the question definition", () => {
  assert.equal(scoreObjectiveQuestion(question("single_choice", { value: "x" }, 2), { value: "x" }, 7.5).score, 7.5);
});

test("percentage is bounded and rounded to two decimals", () => {
  assert.equal(percentage(2, 3), 66.67);
  assert.equal(percentage(8, 5), 100);
  assert.equal(percentage(-1, 5), 0);
  assert.equal(percentage(1, 0), 0);
});
