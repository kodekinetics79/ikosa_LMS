import { appendAudit, appendAuditWithin } from "@/lib/server/audit";
import { assertCsrf, AuthError, principalFromRequest, type Principal } from "@/lib/server/auth";
import { assertScoped } from "@/lib/server/domain-service";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { refreshGapsForEvidence } from "@/lib/server/learning";
import { mutateDatabase } from "@/lib/server/store";

/**
 * Independent verification of a competence claim.
 *
 * This is the control that makes the evidence register defensible: until an
 * authorized assessor other than the subject confirms it, a `pending` record is
 * a claim, not proof. The decision, the domain write and the ledger entry all
 * run inside one mutation, so a crash can never leave a competence record
 * changed with nothing in the audit trail.
 *
 *   POST /api/evidence/:id/verify
 *   { "decision": "verified" }
 *   { "decision": "revoked", "reason": "Rubric was applied to the wrong asset class" }
 */

const DECISIONS = ["verified", "revoked"] as const;

/**
 * Refusals are named for the ledger. A denial an auditor cannot classify is
 * barely better than no entry at all, so every path that declines the request
 * sets the code it will be recorded under before it throws.
 */
type RefusalCode =
  | "csrf_rejected"
  | "invalid_request"
  | "authorization_denied"
  | "separation_of_duties"
  | "evidence_not_found"
  | "already_verified"
  | "already_revoked"
  | "revoked_is_terminal";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const rid = requestId(request);
  // Held outside the try so a refusal can still be attributed in the ledger.
  let principal: Principal | null = null;
  let evidenceId: string | null = null;
  let refusal: RefusalCode = "authorization_denied";

  try {
    // A request with no usable session is refused before this point and is not
    // audited here: there is no tenant to attribute the entry to, and the
    // session layer already records authentication outcomes.
    const actor = await principalFromRequest(request);
    principal = actor;

    refusal = "csrf_rejected";
    assertCsrf(request, actor);

    refusal = "invalid_request";
    const { id } = await context.params;
    evidenceId = id;
    const body = await objectBody(request);
    const decision = optionalEnum(body, "decision", DECISIONS, "verified");
    // Evidence carries no field for a revocation reason and this route must not
    // invent one, so the reason is mandatory and lives in the audit ledger.
    // An unexplained withdrawal of a capability claim is not defensible.
    const reason = decision === "revoked" ? requiredString(body, "reason", 300) : null;

    refusal = "authorization_denied";
    const result = await mutateDatabase((state) => {
      const row = state.evidence.find((candidate) => candidate.id === id && candidate.tenantId === actor.tenantId);
      if (!row) {
        refusal = "evidence_not_found";
        throw new ValidationError("Validation failed", { id: "Evidence not found in tenant" });
      }

      // Tenant boundary, the assessor-only `evidence:verify` action, and the
      // delegated organizational scope, evaluated against the row itself.
      assertScoped(state, actor, "evidence:verify", row);

      // ADR-001 separation of duties, and a release blocker.
      //
      // Holding `evidence:verify` is not enough: an assessor signing off their
      // own competence is self-certification, which is precisely the failure an
      // independent verification step exists to prevent. Checked here, on the
      // resolved row inside the mutation, so no caller can reach the status
      // change while skipping it - `authorize` cannot enforce this, because it
      // waives the subject check for every broad-scope role by design.
      if (row.subjectUserId === actor.user.id) {
        refusal = "separation_of_duties";
        throw new AuthError(403, "Separation of duties: evidence about yourself must be decided by a different assessor");
      }

      const previousStatus = row.status;

      if (decision === "verified") {
        // Refuse rather than re-apply. A second verification of the same record
        // would write a second ledger entry for a decision that was already
        // taken, so the trail would show two independent sign-offs where only
        // one occurred.
        if (previousStatus === "verified") {
          refusal = "already_verified";
          throw new ValidationError("Validation failed", { decision: "This evidence is already verified" });
        }
        if (previousStatus === "revoked") {
          refusal = "revoked_is_terminal";
          throw new ValidationError("Validation failed", { decision: "Revoked evidence cannot be re-verified. Record new evidence instead." });
        }
        row.status = "verified";
      } else {
        if (previousStatus === "revoked") {
          refusal = "already_revoked";
          throw new ValidationError("Validation failed", { decision: "This evidence is already revoked" });
        }
        row.status = "revoked";
      }

      // Capability is derived from evidence, so a status change must move the
      // gap cases that depended on it. Without this, evidence revoked for cause
      // would keep a gap reading as closed.
      const gapIds = refreshGapsForEvidence(state, row);

      appendAuditWithin(state, {
        tenantId: actor.tenantId,
        actorUserId: actor.user.id,
        action: "evidence.verify",
        resourceType: "evidence",
        resourceId: row.id,
        outcome: "success",
        requestId: rid,
        metadata: {
          decision,
          previousStatus,
          subjectUserId: row.subjectUserId,
          skillId: row.skillId,
          proficiencyLevel: row.proficiencyLevel,
          // Named here because the record itself cannot hold it.
          reason,
          gapCasesRecalculated: gapIds.length,
        },
      });

      return { evidence: { ...row }, gapIds, previousStatus };
    });

    return json({
      evidence: result.evidence,
      previousStatus: result.previousStatus,
      gapCasesRecalculated: result.gapIds,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    // A refused decision changes no state, so the mutation above was discarded
    // along with any entry it wrote. The refusal is appended separately - a
    // denied verification attempt is exactly what an auditor needs to see.
    if (principal) {
      await appendAudit({
        tenantId: principal.tenantId,
        actorUserId: principal.user.id,
        action: "evidence.verify",
        resourceType: "evidence",
        resourceId: evidenceId,
        outcome: error instanceof AuthError ? "denied" : "failure",
        requestId: rid,
        metadata: { reason: refusal, detail: error instanceof Error ? error.message : "Unknown error" },
      }).catch((auditError) => {
        // Never let a ledger failure replace the refusal the caller must see.
        console.error("Failed to record a refused evidence verification", { requestId: rid, evidenceId, auditError });
      });
    }
    return problem(error, rid);
  }
}
