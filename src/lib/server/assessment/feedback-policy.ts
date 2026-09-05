/**
 * When a learner may see their per-question marks.
 *
 * Pure, and deliberately free of the `server-only` guard for the same reason
 * `assessment-scoring.ts` is: a rule this consequential should be testable
 * without a database, a pool or a request. It reads nothing and writes nothing.
 *
 * WHAT THIS GOVERNS, AND WHAT IT DOES NOT
 *
 * It governs exactly two things: per-question marks, and the marker's written
 * feedback. It does NOT govern answer keys, rationales or grading notes —
 * those are never disclosed to a learner in any mode, which is enforced by the
 * select lists of the learner queries rather than by a toggle here.
 *
 * The overall score is also not gated. A learner is always entitled to know
 * whether they passed; the mode is about seeing the marking of individual
 * questions.
 */

export type FeedbackMode = "immediate" | "after_submit" | "after_close";
export type AttemptStatus = "in_progress" | "submitted" | "graded" | "void";
export type ReleaseReason = "released" | "awaiting_submission" | "awaiting_marking" | "awaiting_close";

export type ReleaseDecision = { released: boolean; reason: ReleaseReason };

/**
 * Returns the verdict AND the reason, because "we are not showing you your
 * marks" without a reason is the kind of silence learners escalate.
 */
export function releaseDecision(
  feedbackMode: FeedbackMode,
  attemptStatus: AttemptStatus,
  closesAt: string | null,
  now: Date,
): ReleaseDecision {
  if (feedbackMode === "immediate") {
    // Per-item as soon as each item has a score. Nothing to wait for.
    return { released: true, reason: "released" };
  }
  if (attemptStatus === "in_progress") return { released: false, reason: "awaiting_submission" };
  if (feedbackMode === "after_submit") return { released: true, reason: "released" };

  // after_close: a learner who finishes early must not be able to tell one who
  // has not started which answers were right.
  if (!closesAt) {
    // "After a moment that never arrives" is not a policy, it is a mark
    // withheld for ever. Degrade to after_submit rather than to silence.
    return { released: true, reason: "released" };
  }
  if (Date.parse(closesAt) <= now.getTime()) return { released: true, reason: "released" };
  return { released: false, reason: "awaiting_close" };
}
