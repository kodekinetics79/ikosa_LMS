import { appendAuditWithin } from "@/lib/server/audit";
import { assertCsrf, principalFromRequest } from "@/lib/server/auth";
import type { Principal } from "@/lib/server/auth";
import type { Database, Signal } from "@/lib/server/domain";
import { assertScoped } from "@/lib/server/domain-service";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { mutateDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A triage decision. Modelled as a discriminated union so "linked to a study"
 * and "dismissed for a stated reason" cannot both be half-supplied: there is no
 * representable value that dismisses a signal without saying why, and none that
 * links one without naming the study.
 */
export type TriageDecision =
  | { outcome: "link"; linkedStudyId: string }
  | { outcome: "dismiss"; dismissedReason: string };

/** Longest dismissal reason accepted. Long enough for a real justification. */
export const MAX_DISMISSAL_REASON = 500;

/**
 * Applies a triage decision to one signal inside an already-loaded database.
 *
 * The rules live here rather than in the HTTP handler so they hold for every
 * caller, and so they can be tested as rules instead of as status codes:
 *
 *  - the signal must exist inside the caller's tenant and delegated org scope,
 *    and the caller must hold `signal:triage`;
 *  - a signal may be triaged once. Re-triaging a linked or dismissed signal is
 *    refused rather than silently overwritten, so the decision trail cannot be
 *    rewritten after the fact;
 *  - a dismissal must carry a non-empty reason. This is the invariant the
 *    product exists to protect - a change that is dropped without a stated
 *    reason is indistinguishable from one nobody looked at;
 *  - a link must name a study that exists in the tenant AND is readable by the
 *    caller, so triage cannot attach work to a study outside their scope.
 *
 * Mutates and returns the row in `state`; persistence is the caller's job.
 */
export function applyTriage(
  state: Database,
  principal: Principal,
  signalId: string,
  decision: TriageDecision,
  occurredAt: string = new Date().toISOString(),
): Signal {
  const signal = state.signals.find((candidate) => candidate.id === signalId && candidate.tenantId === principal.tenantId);
  // Tenant mismatch is reported as "not found": whether another tenant holds a
  // given signal id is not this caller's information.
  if (!signal) throw new ValidationError("Validation failed", { id: "Signal not found in tenant" });

  // Tenant boundary, `signal:triage` and delegated organizational scope.
  assertScoped(state, principal, "signal:triage", signal);

  if (signal.status !== "new") {
    throw new ValidationError("Validation failed", {
      id: `This signal was already triaged as ${signal.status}${signal.triagedAt ? ` on ${signal.triagedAt.slice(0, 10)}` : ""} and cannot be triaged again`,
    });
  }

  if (decision.outcome === "link") {
    const study = state.tnaStudies.find((candidate) => candidate.id === decision.linkedStudyId && candidate.tenantId === principal.tenantId);
    if (!study) throw new ValidationError("Validation failed", { linkedStudyId: "TNA study not found in tenant" });
    // Readable by this caller, not merely present in the tenant.
    assertScoped(state, principal, "tna:read", study);

    signal.status = "linked";
    signal.linkedStudyId = study.id;
    signal.dismissedReason = null;
  } else {
    const dismissedReason = decision.dismissedReason.trim();
    if (!dismissedReason) throw new ValidationError("Validation failed", { dismissedReason: "A dismissal must state a reason" });
    if (dismissedReason.length > MAX_DISMISSAL_REASON) {
      throw new ValidationError("Validation failed", { dismissedReason: `Must be ${MAX_DISMISSAL_REASON} characters or fewer` });
    }

    signal.status = "dismissed";
    signal.dismissedReason = dismissedReason;
    signal.linkedStudyId = null;
  }

  signal.triagedByUserId = principal.user.id;
  signal.triagedAt = occurredAt;
  return signal;
}

/**
 * Reads the decision out of a request body.
 *
 * The outcome is explicit and never inferred. Inferring "dismiss" from the mere
 * presence of a reason field would let a malformed request drop a signal, which
 * is precisely the silent loss this endpoint exists to prevent. Supplying both
 * payloads is refused rather than resolved by precedence.
 */
function decisionFromBody(body: Record<string, unknown>): TriageDecision {
  const outcome = body.outcome;
  if (outcome !== "link" && outcome !== "dismiss") {
    throw new ValidationError("Validation failed", { outcome: "Must be one of: link, dismiss" });
  }

  const suppliedStudy = typeof body.linkedStudyId === "string" && body.linkedStudyId.trim() !== "";
  const suppliedReason = typeof body.dismissedReason === "string" && body.dismissedReason.trim() !== "";

  if (outcome === "link") {
    if (suppliedReason) throw new ValidationError("Validation failed", { dismissedReason: "A signal linked to a study cannot also carry a dismissal reason" });
    if (!suppliedStudy) throw new ValidationError("Validation failed", { linkedStudyId: "Choose the TNA study this signal belongs to" });
    return { outcome, linkedStudyId: requiredString(body, "linkedStudyId", 100) };
  }

  if (suppliedStudy) throw new ValidationError("Validation failed", { linkedStudyId: "A dismissed signal cannot also be linked to a study" });
  // Worded identically to the rule applyTriage enforces, so the person reading
  // the refusal on screen is told what is actually required rather than that a
  // field was blank.
  if (!suppliedReason) throw new ValidationError("Validation failed", { dismissedReason: "A dismissal must state a reason" });
  return { outcome, dismissedReason: requiredString(body, "dismissedReason", MAX_DISMISSAL_REASON) };
}

/**
 * Records the triage decision for one signal.
 *
 * The read, the rule checks and the write run inside a single datastore
 * mutation, so two concurrent triages of the same signal cannot both observe
 * `status: "new"` and both write a decision.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const { id } = await context.params;
    const decision = decisionFromBody(await objectBody(request));

    const signal = await mutateDatabase((state) => {
      const triaged = applyTriage(state, principal, id, decision);

      // Written inside the same mutation as the decision. A decision that
      // persists without its ledger entry is indistinguishable from a change
      // nobody looked at, which is the exact failure this endpoint prevents.
      appendAuditWithin(state, {
        tenantId: principal.tenantId,
        actorUserId: principal.user.id,
        action: "signal.triage",
        resourceType: "signal",
        resourceId: triaged.id,
        outcome: "success",
        requestId: rid,
        // The decision itself, including the stated reason: this entry is the
        // record an auditor reads to see what was declined and on what grounds.
        metadata: {
          outcome: decision.outcome,
          status: triaged.status,
          linkedStudyId: triaged.linkedStudyId,
          dismissedReason: triaged.dismissedReason,
          severity: triaged.severity,
          source: triaged.source,
          sourceReference: triaged.sourceReference,
        },
      });

      return structuredClone(triaged);
    });

    return json({ signal, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
