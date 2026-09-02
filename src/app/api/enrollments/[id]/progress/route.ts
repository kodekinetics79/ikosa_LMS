import { appendAuditWithin } from "@/lib/server/audit";
import { assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { assertScoped } from "@/lib/server/domain-service";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { courseProgress, recordModuleCompletion, refreshGapsForEvidence } from "@/lib/server/learning";
import { mutateDatabase } from "@/lib/server/store";

/**
 * Records progress through an enrolled course.
 *
 * Completing the final required module is the moment learning becomes an
 * assurance claim, so the whole decision runs inside one datastore mutation:
 * completion, the evidence rule, gap recalculation and the audit entry either
 * all land or none do.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const { id } = await context.params;
    const body = await objectBody(request);
    const moduleId = requiredString(body, "moduleId", 100);

    const rawScore = body.score;
    let score: number | null = null;
    if (rawScore !== undefined && rawScore !== null) {
      score = Number(rawScore);
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new ValidationError("Validation failed", { score: "Score must be between 0 and 1" });
      }
    }

    const result = await mutateDatabase((state) => {
      const enrollment = state.enrollments.find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
      if (!enrollment) throw new ValidationError("Validation failed", { id: "Enrollment not found in tenant" });

      // Tenant, delegated-org and self-scope authorization on the row itself.
      assertScoped(state, principal, "enrollment:update", enrollment);

      if (enrollment.status === "completed") {
        throw new ValidationError("Validation failed", { id: "This enrollment is already complete" });
      }
      if (enrollment.status === "withdrawn") {
        throw new ValidationError("Validation failed", { id: "This enrollment has been withdrawn" });
      }

      const outcome = recordModuleCompletion(state, enrollment, moduleId, score);
      const gapIds = outcome.evidence ? refreshGapsForEvidence(state, outcome.evidence) : [];

      // Recorded inside the same mutation as the completion. Writing the ledger
      // entry afterwards left a window where a competence record could change
      // with nothing in the audit trail.
      appendAuditWithin(state, {
        tenantId: principal.tenantId, actorUserId: principal.user.id, action: "learning.module.complete",
        resourceType: "enrollment", resourceId: enrollment.id, outcome: "success", requestId: rid,
        metadata: { moduleId, score, enrollmentStatus: outcome.enrollment.status },
      });

      if (outcome.evidence) {
        appendAuditWithin(state, {
          tenantId: principal.tenantId, actorUserId: principal.user.id, action: "evidence.create",
          resourceType: "evidence", resourceId: outcome.evidence.id, outcome: "success", requestId: rid,
          metadata: {
            origin: "learning_completion",
            enrollmentId: outcome.enrollment.id,
            skillId: outcome.evidence.skillId,
            proficiencyLevel: outcome.evidence.proficiencyLevel,
            strength: outcome.evidence.strength,
            subjectUserId: outcome.evidence.subjectUserId,
            gapCasesRecalculated: gapIds.length,
          },
        });
      } else if (outcome.enrollment.status === "completed") {
        appendAuditWithin(state, {
          tenantId: principal.tenantId, actorUserId: principal.user.id, action: "learning.evidence.withheld",
          resourceType: "enrollment", resourceId: outcome.enrollment.id, outcome: "success", requestId: rid,
          metadata: { reason: outcome.evidenceWithheldReason },
        });
      }

      return { outcome, gapIds, progress: courseProgress(state, enrollment) };
    });

    const { outcome, gapIds, progress } = result;

    return json({
      enrollment: outcome.enrollment,
      progress,
      evidence: outcome.evidence,
      evidenceWithheldReason: outcome.evidenceWithheldReason,
      gapCasesRecalculated: gapIds,
      asOf: new Date().toISOString(),
    });
  } catch (error) { return problem(error, rid); }
}
