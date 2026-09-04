import type { AssessmentQuestion } from "./domain";

export type ObjectiveScore = {
  score: number | null;
  manualRequired: boolean;
  correct: boolean | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeText(value: unknown, caseSensitive = false): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return caseSensitive ? text : text.toLocaleLowerCase();
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function boundedPoints(points: number): number {
  if (!Number.isFinite(points) || points <= 0) throw new Error("Question points must be positive");
  return Math.round(points * 100) / 100;
}

/**
 * Deterministic objective scoring. No AI participates in authoritative scores.
 * Subjective/long-form responses return manualRequired=true; a future AI marking
 * copilot may propose a score, but human/policy approval remains a separate step.
 */
export function scoreObjectiveQuestion(
  question: Pick<AssessmentQuestion, "questionType" | "answerKey" | "points">,
  responseValue: unknown,
  pointsOverride?: number | null,
): ObjectiveScore {
  const points = boundedPoints(pointsOverride ?? question.points);
  const key = object(question.answerKey);
  const response = object(responseValue);
  let correct: boolean;

  switch (question.questionType) {
    case "single_choice": {
      correct = String(response.value ?? "") === String(key.value ?? "");
      break;
    }
    case "multiple_choice": {
      correct = sameSet(stringArray(response.values), stringArray(key.values));
      break;
    }
    case "true_false": {
      correct = typeof response.value === "boolean" && response.value === key.value;
      break;
    }
    case "short_text": {
      const caseSensitive = key.caseSensitive === true;
      const answer = normalizeText(response.value, caseSensitive);
      const accepted = stringArray(key.accepted).map((item) => normalizeText(item, caseSensitive));
      correct = accepted.includes(answer);
      break;
    }
    case "numeric": {
      const expected = Number(key.value);
      const actual = Number(response.value);
      const tolerance = Math.max(0, Number(key.tolerance ?? 0));
      correct = Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
      break;
    }
    case "matching": {
      const expected = object(key.pairs);
      const actual = object(response.pairs);
      const expectedKeys = Object.keys(expected).sort();
      const actualKeys = Object.keys(actual).sort();
      correct = expectedKeys.length === actualKeys.length && expectedKeys.every((item, index) =>
        item === actualKeys[index] && String(expected[item]) === String(actual[item]));
      break;
    }
    case "ordering": {
      const expected = stringArray(key.order);
      const actual = stringArray(response.order);
      correct = expected.length === actual.length && expected.every((item, index) => item === actual[index]);
      break;
    }
    case "long_text":
      return { score: null, manualRequired: true, correct: null };
    default:
      return { score: null, manualRequired: true, correct: null };
  }

  return { score: correct ? points : 0, manualRequired: false, correct };
}

export function percentage(score: number, max: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (score / max) * 100)) * 100) / 100;
}
