import "server-only";

/**
 * What a well-formed question of each type looks like.
 *
 * `POST /api/assessment-questions` accepted `options: body.options ?? []` and
 * `answerKey: body.answerKey ?? {}` — arbitrary JSON, unchecked against the
 * question type. The scoring kernel then reads specific shapes out of that JSON
 * and scores anything it does not recognise as wrong. So a malformed key did
 * not fail at authoring time; it produced a question that every learner gets
 * wrong, discovered only when someone disputes a mark.
 *
 * Two concrete cases the authoring UI could already produce:
 *   * an answer index outside the option list, which `buildQuestionPayload`
 *     filtered out, leaving `answerKey.value === ""` — a single-choice question
 *     no learner can answer correctly;
 *   * `Number("abc")` for a numeric answer, serialised as `null`.
 *
 * Validated with zod, which is already a dependency. The failure is a
 * ValidationError naming the field, not a 500 and not a silently broken item.
 */

import { z } from "zod";
import type { QuestionType } from "../domain";

const choice = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(2000),
});

/** Choice-style questions carry `{ choices: [...] }`; everything else is free-form. */
const choiceOptions = z.object({
  choices: z.array(choice).min(2, "A choice question needs at least two options").max(40),
});

const orderingOptions = z.object({
  choices: z.array(choice).min(2, "An ordering question needs at least two items").max(40),
});

const matchingOptions = z.object({
  left: z.array(choice).min(1).max(40),
  right: z.array(choice).min(1).max(40),
});

const emptyish = z.union([z.object({}).passthrough(), z.array(z.unknown()), z.null(), z.undefined()]);

export type QuestionShapeIssue = { field: "options" | "answerKey"; message: string };

/**
 * Checks one question's options and answer key against its type, and — for
 * choice-style types — that every id the key names actually exists in the
 * options. That cross-field check is the one that catches the unanswerable
 * question, and no schema alone can express it.
 */
export function validateQuestionShape(
  questionType: QuestionType,
  options: unknown,
  answerKey: unknown,
): QuestionShapeIssue[] {
  const issues: QuestionShapeIssue[] = [];
  const fail = (field: QuestionShapeIssue["field"], message: string) => issues.push({ field, message });

  const idsOf = (parsed: { choices: Array<{ id: string }> }) => new Set(parsed.choices.map((item) => item.id));

  switch (questionType) {
    case "single_choice": {
      const parsed = choiceOptions.safeParse(options);
      if (!parsed.success) { fail("options", parsed.error.issues[0]?.message ?? "Invalid options"); break; }
      const key = z.object({ value: z.string().min(1) }).safeParse(answerKey);
      if (!key.success) { fail("answerKey", "Select which option is correct"); break; }
      if (!idsOf(parsed.data).has(key.data.value)) fail("answerKey", "The correct answer is not one of the options");
      break;
    }
    case "multiple_choice": {
      const parsed = choiceOptions.safeParse(options);
      if (!parsed.success) { fail("options", parsed.error.issues[0]?.message ?? "Invalid options"); break; }
      const key = z.object({ values: z.array(z.string().min(1)).min(1) }).safeParse(answerKey);
      if (!key.success) { fail("answerKey", "Select at least one correct option"); break; }
      const available = idsOf(parsed.data);
      const unknown = key.data.values.filter((value) => !available.has(value));
      if (unknown.length > 0) fail("answerKey", "A correct answer is not one of the options");
      if (new Set(key.data.values).size !== key.data.values.length) fail("answerKey", "The same option is marked correct more than once");
      break;
    }
    case "true_false": {
      // Scored with `typeof response.value === "boolean" && response.value === key.value`,
      // so the string "false" is not an acceptable key: it would never match.
      const key = z.object({ value: z.boolean() }).safeParse(answerKey);
      if (!key.success) fail("answerKey", "Choose true or false as the correct answer");
      break;
    }
    case "short_text": {
      const key = z.object({
        accepted: z.array(z.string().min(1).max(500)).min(1, "Give at least one accepted answer"),
        caseSensitive: z.boolean().optional(),
      }).safeParse(answerKey);
      if (!key.success) fail("answerKey", key.error?.issues[0]?.message ?? "Give at least one accepted answer");
      break;
    }
    case "numeric": {
      const key = z.object({
        value: z.number().finite(),
        tolerance: z.number().finite().min(0).optional(),
      }).safeParse(answerKey);
      if (!key.success) fail("answerKey", "Give a numeric answer, and optionally a tolerance");
      break;
    }
    case "ordering": {
      const parsed = orderingOptions.safeParse(options);
      if (!parsed.success) { fail("options", parsed.error.issues[0]?.message ?? "Invalid options"); break; }
      const key = z.object({ order: z.array(z.string().min(1)).min(2) }).safeParse(answerKey);
      if (!key.success) { fail("answerKey", "Give the correct order"); break; }
      const available = idsOf(parsed.data);
      if (key.data.order.length !== available.size) fail("answerKey", "The correct order must list every item exactly once");
      else if (new Set(key.data.order).size !== key.data.order.length) fail("answerKey", "The correct order lists an item twice");
      else if (key.data.order.some((id) => !available.has(id))) fail("answerKey", "The correct order names an item that is not an option");
      break;
    }
    case "matching": {
      const parsed = matchingOptions.safeParse(options);
      if (!parsed.success) { fail("options", "A matching question needs a left and a right list"); break; }
      const key = z.object({ pairs: z.record(z.string(), z.string()) }).safeParse(answerKey);
      if (!key.success) { fail("answerKey", "Give the correct pairing"); break; }
      const left = new Set(parsed.data.left.map((item) => item.id));
      const right = new Set(parsed.data.right.map((item) => item.id));
      const entries = Object.entries(key.data.pairs);
      if (entries.length !== left.size) fail("answerKey", "Every item on the left needs a match");
      if (entries.some(([from]) => !left.has(from))) fail("answerKey", "The pairing names a left item that does not exist");
      // The right list may legitimately be longer than the left — the extras are
      // distractors — so only membership is checked, never count equality.
      if (entries.some(([, to]) => !right.has(to))) fail("answerKey", "The pairing names a right item that does not exist");
      break;
    }
    case "long_text": {
      // Marked by a human. An answer key would be marker guidance, and that is
      // what `rationale` is for, so anything object-shaped is accepted here.
      if (!emptyish.safeParse(answerKey).success) fail("answerKey", "A written-response question has no answer key");
      break;
    }
    default: {
      // A type the kernel does not auto-score falls to manual marking, which is
      // safe. Refusing an unknown type outright would block adding one.
      break;
    }
  }
  return issues;
}
