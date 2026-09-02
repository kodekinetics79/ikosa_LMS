import { authorize, principalFromRequest } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { json, problem, requestId } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The change-signal inbox.
 *
 * Scoped exactly like every other record collection: tenant boundary first,
 * then the caller's delegated organizational paths. The role check is explicit
 * rather than implied by an empty result, because "you may not read signals"
 * and "no signal exists" are different facts and a compliance product must not
 * conflate them - an empty inbox is read as "nothing to act on".
 *
 * Dismissed and linked signals are returned alongside new ones. Filtering them
 * out server-side would make a declined change invisible to the auditor whose
 * job is to ask why it was declined.
 */
export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    authorize(principal, "signal:read", { tenantId: principal.tenantId });
    const db = await readDatabase();

    const inTenant = <T extends { id: string; tenantId: string }>(rows: T[], id: string): T | undefined =>
      rows.find((row) => row.id === id && row.tenantId === principal.tenantId);

    const items = visibleRows(db, principal, "signal:read", db.signals).map((signal) => {
      const study = signal.linkedStudyId ? inTenant(db.tnaStudies, signal.linkedStudyId) : undefined;
      const triagedBy = signal.triagedByUserId ? inTenant(db.users, signal.triagedByUserId) : undefined;
      return {
        ...signal,
        // Names resolved from the tenant's own records so a caller never has to
        // guess what an identifier refers to. Unresolvable ids stay visible as
        // ids rather than being dropped.
        affectedJobRoles: signal.affectedJobRoleIds.map((id) => ({ id, title: inTenant(db.jobRoles, id)?.title ?? null })),
        affectedSkills: signal.affectedSkillIds.map((id) => ({ id, name: inTenant(db.skills, id)?.name ?? null })),
        linkedStudy: study ? { id: study.id, title: study.title, status: study.status } : null,
        triagedByDisplayName: triagedBy?.displayName ?? null,
        orgUnitName: db.orgUnits.find((unit) => unit.id === signal.orgUnitId && unit.tenantId === principal.tenantId)?.name ?? null,
      };
    });

    return json({ items, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}
