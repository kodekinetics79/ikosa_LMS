/**
 * Business-rule failures, as distinct from bugs.
 *
 * Every rule in the assessment and tenant-admin stores used to throw a plain
 * `Error`, and `problem()` maps a plain `Error` to
 * `500 {"error":"An unexpected error occurred"}` — deliberately, because an
 * unexpected error must not leak its message. The consequence was that
 * "Attempt limit reached", "Add at least one question before publishing" and
 * "Score must be between 0 and 8" were all served to the browser as an opaque
 * 500. Both clients rendered that generic string, so no rule violation was ever
 * communicated to the person who hit it, and a genuine crash was
 * indistinguishable from a refusal.
 *
 * A `RuleError` is a refusal the caller is entitled to read: it carries a
 * message written for a user and a status that says what kind of refusal it is.
 * Anything that is NOT a RuleError keeps the opaque 500, which is the behaviour
 * that matters for real faults.
 *
 * Choosing a status:
 *   403  the caller lacks the permission or the record is outside their scope
 *   404  the record does not exist for this caller
 *   409  the request conflicts with the current state (limits, lifecycle gates)
 *   400  the request itself is out of range in a way validation did not catch
 */
export type RuleStatus = 400 | 403 | 404 | 409;

export class RuleError extends Error {
  constructor(message: string, public readonly status: RuleStatus = 409) {
    super(message);
    this.name = "RuleError";
  }
}

/** The caller may not do this at all. */
export function forbidden(message: string): RuleError {
  return new RuleError(message, 403);
}

/** No such record for this caller. Used in preference to 403 where confirming
 *  existence would itself disclose another tenant's or org's data. */
export function notFound(message: string): RuleError {
  return new RuleError(message, 404);
}

/** The state of the world refuses the request. */
export function conflict(message: string): RuleError {
  return new RuleError(message, 409);
}

/** The value supplied is outside the range the rule allows. */
export function outOfRange(message: string): RuleError {
  return new RuleError(message, 400);
}
