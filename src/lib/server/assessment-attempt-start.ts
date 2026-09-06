import "server-only";

import type { Principal } from "./auth";
import type { AttemptWorkspace } from "./assessment-store";
import { startAssessmentAttempt } from "./assessment-store";

/**
 * The partial unique index from migration 006 is the authority for concurrent
 * starts. If two requests race, one insert wins and the other receives 23505;
 * retrying then follows the normal "resume active attempt" path and returns the
 * winner. No duplicate attempt and no conflict leaks into learner UX.
 */
export async function startAssessmentAttemptIdempotent(
  principal: Principal,
  assessmentId: string,
  requestId: string,
): Promise<AttemptWorkspace> {
  try {
    return await startAssessmentAttempt(principal, assessmentId, requestId);
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    return startAssessmentAttempt(principal, assessmentId, requestId);
  }
}
