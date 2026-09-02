import type { Course, Database, Evidence, GapCase, Intervention, OrgUnit, TnaStudy } from "./domain";
import type { Action, Principal } from "./auth";
import { AuthError, authorize, isOrgInScope } from "./auth";
import { readDatabase } from "./store";

export function tenantRows<T extends { tenantId: string }>(principal: Principal, rows: T[]): T[] {
  return rows.filter((row) => row.tenantId === principal.tenantId);
}

export function orgFor(database: Database, tenantId: string, orgUnitId: string): OrgUnit | undefined {
  return database.orgUnits.find((org) => org.id === orgUnitId && org.tenantId === tenantId);
}

export function assertScoped<T extends { tenantId: string; orgUnitId: string; subjectUserId?: string }>(database: Database, principal: Principal, action: Action, row: T): T {
  const orgUnit = orgFor(database, row.tenantId, row.orgUnitId);
  if (!orgUnit) throw new Error("Organizational unit not found");
  authorize(principal, action, { tenantId: row.tenantId, orgUnit, subjectUserId: row.subjectUserId });
  return row;
}

export function visibleRows<T extends { tenantId: string; orgUnitId: string; subjectUserId?: string }>(database: Database, principal: Principal, action: Action, rows: T[]): T[] {
  return rows.filter((row) => {
    try {
      assertScoped(database, principal, action, row);
      return true;
    } catch (error) {
      // Only an authorization decision means "not yours to see". Swallowing
      // every exception also hid data-integrity faults - a row pointing at a
      // missing organizational unit silently vanished, which quietly REMOVED
      // open gaps and made readiness read higher than it truly is. A wrong
      // answer delivered silently is the one failure mode worth crashing over.
      if (error instanceof AuthError) return false;
      throw error;
    }
  });
}

export async function readinessSummary(principal: Principal): Promise<{
  studies: number;
  openGaps: number;
  criticalGaps: number;
  verifiedEvidence: number;
  activeInterventions: number;
  readinessPercent: number;
}> {
  const db = await readDatabase();
  const studies = visibleRows(db, principal, "tna:read", db.tnaStudies as TnaStudy[]);
  const gaps = visibleRows(db, principal, "gap:read", db.gapCases as GapCase[]).filter((gap) => gap.status !== "verified");
  const evidence = visibleRows(db, principal, "evidence:read", db.evidence as Evidence[]).filter((item) => item.status === "verified");
  const interventions = visibleRows(db, principal, "intervention:read", db.interventions as Intervention[]).filter((item) => item.status === "active");
  const required = gaps.reduce((sum, gap) => sum + gap.requiredLevel, 0);
  const evidenced = gaps.reduce((sum, gap) => sum + Math.min(gap.evidencedLevel, gap.requiredLevel), 0);
  return {
    studies: studies.length,
    openGaps: gaps.length,
    criticalGaps: gaps.filter((gap) => gap.priority === "critical").length,
    verifiedEvidence: evidence.length,
    activeInterventions: interventions.length,
    readinessPercent: required ? Math.round((evidenced / required) * 100) : 100,
  };
}

/**
 * Course availability runs in the opposite direction to record visibility.
 *
 * Records cascade DOWN a delegated scope: a manager sees evidence belonging to
 * their own unit and below. Catalogue content cascades the other way - a course
 * published at Field Operations is meant to be taken by the crews in the
 * regions beneath it. Reusing record scoping for the catalogue leaves every
 * front-line learner with nothing to enroll in, which is exactly the population
 * the product exists to qualify.
 *
 * So a course is available when it sits at or above the viewer's own unit
 * (inherited content), or at or below the scope they administer (content they
 * are responsible for).
 */
export function availableCourses(database: Database, principal: Principal, courses: Course[]): Course[] {
  const viewerOrg = database.orgUnits.find((unit) => unit.id === principal.user.orgUnitId && unit.tenantId === principal.tenantId);
  return courses.filter((course) => {
    if (course.tenantId !== principal.tenantId) return false;
    const courseOrg = orgFor(database, course.tenantId, course.orgUnitId);
    if (!courseOrg) return false;
    if (isOrgInScope(principal, courseOrg)) return true;
    if (!viewerOrg) return false;
    return viewerOrg.path === courseOrg.path || viewerOrg.path.startsWith(`${courseOrg.path}/`);
  });
}
