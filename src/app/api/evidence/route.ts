import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { orgFor, visibleRows } from "@/lib/server/domain-service";
import type { Evidence } from "@/lib/server/domain";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    return json({ items: visibleRows(db, principal, "evidence:read", db.evidence), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const db = await readDatabase();
    const subjectUserId = requiredString(body, "subjectUserId", 100);
    const skillId = requiredString(body, "skillId", 100);
    const subject = db.users.find((user) => user.id === subjectUserId && user.tenantId === principal.tenantId);
    // The organizational unit is taken from the SUBJECT, never from the request
    // body. Authorizing against a caller-supplied unit let anyone inside the
    // tenant assert evidence about a person outside their delegated scope by
    // naming a unit they happened to be entitled to.
    const orgUnitId = subject?.orgUnitId ?? "";
    const org = orgFor(db, principal.tenantId, orgUnitId);
    const skill = db.skills.find((item) => item.id === skillId && item.tenantId === principal.tenantId);
    if (!org || !subject || !skill) throw new ValidationError("Validation failed", { reference: "Organization, subject or skill not found in tenant" });
    authorize(principal, "evidence:create", { tenantId: principal.tenantId, orgUnit: org, subjectUserId });
    // Separation of duties, regardless of role. The guard previously only fired
    // for assessors, so anyone holding evidence:create without that role could
    // record competence evidence about themselves - and they are stamped as the
    // assessor on the record, which the production schema's
    // subject_user_id <> assessor_user_id CHECK refuses outright.
    if (principal.user.id === subjectUserId) throw new ValidationError("Separation of duties violation", { subjectUserId: "Evidence cannot be recorded about yourself" });
    const proficiencyLevel = Number(body.proficiencyLevel);
    const strength = Number(body.strength);
    if (!Number.isInteger(proficiencyLevel) || proficiencyLevel < 0 || proficiencyLevel > 5 || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new ValidationError("Validation failed", { score: "Proficiency must be 0-5 and strength 0-1" });
    const evidence: Evidence = { id: newId("ev"), tenantId: principal.tenantId, orgUnitId, subjectUserId, skillId, type: optionalEnum(body, "type", ["assessment", "observation", "work_product", "credential"] as const, "observation"), proficiencyLevel, strength, observedAt: new Date().toISOString(), expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null, assessorUserId: principal.user.id, sourceReference: requiredString(body, "sourceReference", 200), status: principal.roles.includes("assessor") ? "verified" : "pending" };
    await mutateDatabase((state) => state.evidence.push(evidence));
    await appendAudit({ tenantId: principal.tenantId, actorUserId: principal.user.id, action: "evidence.create", resourceType: "evidence", resourceId: evidence.id, outcome: "success", requestId: rid, metadata: { type: evidence.type, status: evidence.status, subjectUserId } });
    return json(evidence, { status: 201 });
  } catch (error) { return problem(error, rid); }
}
