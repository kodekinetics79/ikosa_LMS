import type { Database } from "./domain";
import { hashPassword } from "./security";

const createdAt = "2026-08-01T12:00:00.000Z";

export function seedDatabase(): Database {
  return {
    schemaVersion: 2,
    tenants: [
      { id: "ten_northstar", slug: "northstar", name: "Northstar Utilities", homeRegion: "us-east", locale: "en-US", createdAt },
      { id: "ten_gulf", slug: "gulf-energy", name: "Gulf Energy Services", homeRegion: "me-central", locale: "en-SA", createdAt },
    ],
    orgUnits: [
      { id: "org_ns", tenantId: "ten_northstar", parentId: null, code: "NS", name: "Northstar Utilities", path: "/org_ns" },
      { id: "org_ns_ops", tenantId: "ten_northstar", parentId: "org_ns", code: "OPS", name: "Field Operations", path: "/org_ns/org_ns_ops" },
      { id: "org_ns_south", tenantId: "ten_northstar", parentId: "org_ns_ops", code: "SOUTH", name: "South Region", path: "/org_ns/org_ns_ops/org_ns_south" },
      { id: "org_ge", tenantId: "ten_gulf", parentId: null, code: "GES", name: "Gulf Energy Services", path: "/org_ge" },
    ],
    users: [
      { id: "usr_admin", tenantId: "ten_northstar", orgUnitId: "org_ns", email: "admin@northstar.example", displayName: "Avery Morgan", passwordHash: hashPassword("Demo!2026"), roles: ["tenant_admin"], delegatedOrgPaths: ["/org_ns"], active: true, createdAt },
      { id: "usr_analyst", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", email: "analyst@northstar.example", displayName: "Maya Chen", passwordHash: hashPassword("Demo!2026"), roles: ["tna_analyst"], delegatedOrgPaths: ["/org_ns/org_ns_ops"], active: true, createdAt },
      { id: "usr_manager", tenantId: "ten_northstar", orgUnitId: "org_ns_south", email: "manager@northstar.example", displayName: "Jordan Ellis", passwordHash: hashPassword("Demo!2026"), roles: ["manager", "assessor"], delegatedOrgPaths: ["/org_ns/org_ns_ops/org_ns_south"], active: true, createdAt },
      // A supervisor who records observations but does NOT hold `assessor`.
      // Without this, every seeded evidence author was also an assessor, so
      // POST /api/evidence always stamped `verified` and the verification step
      // had no reachable inbox - the control existed but could never be shown.
      { id: "usr_supervisor", tenantId: "ten_northstar", orgUnitId: "org_ns_south", email: "supervisor@northstar.example", displayName: "Priya Raman", passwordHash: hashPassword("Demo!2026"), roles: ["manager"], delegatedOrgPaths: ["/org_ns/org_ns_ops/org_ns_south"], active: true, createdAt },
      { id: "usr_learner", tenantId: "ten_northstar", orgUnitId: "org_ns_south", email: "technician@northstar.example", displayName: "Sam Rivera", passwordHash: hashPassword("Demo!2026"), roles: ["learner"], delegatedOrgPaths: ["/org_ns/org_ns_ops/org_ns_south"], active: true, createdAt },
      { id: "usr_gulf", tenantId: "ten_gulf", orgUnitId: "org_ge", email: "admin@gulf.example", displayName: "Noor Al-Farsi", passwordHash: hashPassword("Demo!2026"), roles: ["tenant_admin"], delegatedOrgPaths: ["/org_ge"], active: true, createdAt },
    ],
    sessions: [],
    jobRoles: [
      { id: "role_field_tech", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", code: "FT-II", title: "Field Technician II", purpose: "Safely inspect, isolate and restore distribution assets.", version: 3, status: "active", effectiveFrom: "2026-01-01" },
      { id: "role_gulf_eng", tenantId: "ten_gulf", orgUnitId: "org_ge", code: "ENG-I", title: "Operations Engineer", purpose: "Operate energy assets safely.", version: 1, status: "active", effectiveFrom: "2026-01-01" },
    ],
    skills: [
      { id: "skill_loto", tenantId: "ten_northstar", code: "SAFE-LOTO", name: "Lockout/Tagout execution", description: "Applies the authorized energy isolation procedure in the field.", scale: "awareness-to-expert" },
      { id: "skill_diag", tenantId: "ten_northstar", code: "OPS-DIAG", name: "Distribution fault diagnosis", description: "Diagnoses distribution faults using approved instruments and procedures.", scale: "awareness-to-expert" },
      { id: "skill_gulf_safe", tenantId: "ten_gulf", code: "GES-SAFE", name: "Process safety", description: "Applies site process safety controls.", scale: "awareness-to-expert" },
    ],
    requirements: [
      { id: "req_loto", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", jobRoleId: "role_field_tech", skillId: "skill_loto", sourceType: "regulation", sourceReference: "OSHA 29 CFR 1910.147 / NSU-SOP-104 v7", requiredLevel: 4, criticality: "mandatory", effectiveFrom: "2026-01-01", effectiveTo: null, version: 7 },
      { id: "req_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", jobRoleId: "role_field_tech", skillId: "skill_diag", sourceType: "incident", sourceReference: "CAPA-2026-017", requiredLevel: 3, criticality: "important", effectiveFrom: "2026-04-01", effectiveTo: null, version: 2 },
      { id: "req_gulf", tenantId: "ten_gulf", orgUnitId: "org_ge", jobRoleId: "role_gulf_eng", skillId: "skill_gulf_safe", sourceType: "policy", sourceReference: "GES-HSE-01", requiredLevel: 4, criticality: "mandatory", effectiveFrom: "2026-01-01", effectiveTo: null, version: 1 },
    ],
    tnaStudies: [
      { id: "tna_field_2026", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", title: "2026 Field Operations Readiness Review", objective: "Close safety-critical and fault-diagnosis gaps before storm season.", status: "analysis", ownerUserId: "usr_analyst", targetRoleIds: ["role_field_tech"], dueDate: "2026-09-15", createdAt },
    ],
    evidence: [
      { id: "ev_loto_obs", tenantId: "ten_northstar", orgUnitId: "org_ns_south", subjectUserId: "usr_learner", skillId: "skill_loto", type: "observation", proficiencyLevel: 2, strength: 0.85, observedAt: "2026-07-18T14:30:00.000Z", expiresAt: "2027-07-18T00:00:00.000Z", assessorUserId: "usr_manager", sourceReference: "OBS-8472", status: "verified" },
      { id: "ev_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_south", subjectUserId: "usr_learner", skillId: "skill_diag", type: "assessment", proficiencyLevel: 2, strength: 0.72, observedAt: "2026-07-10T10:00:00.000Z", expiresAt: null, assessorUserId: "usr_manager", sourceReference: "ASM-2341", status: "verified" },
    ],
    gapCases: [
      { id: "gap_loto", tenantId: "ten_northstar", orgUnitId: "org_ns_south", tnaStudyId: "tna_field_2026", subjectUserId: "usr_learner", requirementId: "req_loto", requiredLevel: 4, evidencedLevel: 2, gap: 2, priority: "critical", causeHypothesis: "Field practice is infrequent and supervisor observation found procedural sequencing errors.", status: "actioned" },
      { id: "gap_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_south", tnaStudyId: "tna_field_2026", subjectUserId: "usr_learner", requirementId: "req_diag", requiredLevel: 3, evidencedLevel: 2, gap: 1, priority: "high", causeHypothesis: "The current job aid omits the new meter diagnostic branch.", status: "triaged" },
    ],
    interventions: [
      { id: "int_loto", tenantId: "ten_northstar", orgUnitId: "org_ns_south", gapCaseId: "gap_loto", type: "coaching", title: "LOTO field rehearsal and reassessment", ownerUserId: "usr_manager", dueDate: "2026-09-05", status: "active" },
      { id: "int_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_south", gapCaseId: "gap_diag", type: "job_aid", title: "Publish revised diagnostic decision card", ownerUserId: "usr_analyst", dueDate: "2026-08-30", status: "planned" },
      { id: "int_loto_course", tenantId: "ten_northstar", orgUnitId: "org_ns_south", gapCaseId: "gap_loto", type: "learning", title: "LOTO authorized-person requalification", ownerUserId: "usr_analyst", dueDate: "2026-09-10", status: "active" },
    ],
    courses: [
      { id: "crs_loto", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", code: "LOTO-401", title: "Lockout/Tagout authorized person", description: "Energy isolation to the authorized-person standard, including the NSU-SOP-104 sequence and field verification.", skillId: "skill_loto", targetLevel: 4, evidenceRule: "assessed", passingScore: 0.8, validityMonths: 12, version: 3, status: "published", createdAt },
      { id: "crs_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", code: "DIAG-210", title: "Distribution fault diagnosis", description: "Instrument-led fault diagnosis on distribution assets, including the revised meter diagnostic branch.", skillId: "skill_diag", targetLevel: 3, evidenceRule: "assessed", passingScore: 0.75, validityMonths: 24, version: 2, status: "published", createdAt },
      { id: "crs_storm", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", code: "BRIEF-STORM", title: "Storm season safety briefing", description: "Annual awareness briefing. Attendance is recorded; it does not evidence competence.", skillId: "skill_loto", targetLevel: 1, evidenceRule: "attendance_only", passingScore: 0, validityMonths: null, version: 1, status: "published", createdAt },
      { id: "crs_gulf", tenantId: "ten_gulf", orgUnitId: "org_ge", code: "GES-PS-100", title: "Process safety fundamentals", description: "Site process safety controls.", skillId: "skill_gulf_safe", targetLevel: 4, evidenceRule: "assessed", passingScore: 0.8, validityMonths: 12, version: 1, status: "published", createdAt },
    ],
    courseModules: [
      { id: "mod_loto_1", tenantId: "ten_northstar", courseId: "crs_loto", position: 1, title: "Energy isolation principles", kind: "lesson", durationMinutes: 25, required: true },
      { id: "mod_loto_2", tenantId: "ten_northstar", courseId: "crs_loto", position: 2, title: "NSU-SOP-104 v7 procedure walkthrough", kind: "document", durationMinutes: 20, required: true },
      { id: "mod_loto_3", tenantId: "ten_northstar", courseId: "crs_loto", position: 3, title: "Isolation sequence simulation", kind: "scorm", durationMinutes: 35, required: true },
      { id: "mod_loto_4", tenantId: "ten_northstar", courseId: "crs_loto", position: 4, title: "Authorized person assessment", kind: "assessment", durationMinutes: 30, required: true },
      { id: "mod_diag_1", tenantId: "ten_northstar", courseId: "crs_diag", position: 1, title: "Meter diagnostic decision branch", kind: "lesson", durationMinutes: 30, required: true },
      { id: "mod_diag_2", tenantId: "ten_northstar", courseId: "crs_diag", position: 2, title: "Fault diagnosis assessment", kind: "assessment", durationMinutes: 25, required: true },
      { id: "mod_storm_1", tenantId: "ten_northstar", courseId: "crs_storm", position: 1, title: "Storm season briefing", kind: "video", durationMinutes: 15, required: true },
      { id: "mod_gulf_1", tenantId: "ten_gulf", courseId: "crs_gulf", position: 1, title: "Process safety controls", kind: "lesson", durationMinutes: 40, required: true },
      { id: "mod_gulf_2", tenantId: "ten_gulf", courseId: "crs_gulf", position: 2, title: "Process safety assessment", kind: "assessment", durationMinutes: 30, required: true },
    ],
    enrollments: [
      { id: "enr_sam_loto", tenantId: "ten_northstar", orgUnitId: "org_ns_south", courseId: "crs_loto", subjectUserId: "usr_learner", source: "intervention", interventionId: "int_loto_course", gapCaseId: "gap_loto", status: "in_progress", assignedByUserId: "usr_analyst", dueDate: "2026-09-10", startedAt: "2026-08-20T09:00:00.000Z", completedAt: null, score: null, evidenceId: null, createdAt },
      { id: "enr_sam_diag", tenantId: "ten_northstar", orgUnitId: "org_ns_south", courseId: "crs_diag", subjectUserId: "usr_learner", source: "assigned", interventionId: null, gapCaseId: "gap_diag", status: "enrolled", assignedByUserId: "usr_manager", dueDate: "2026-09-20", startedAt: null, completedAt: null, score: null, evidenceId: null, createdAt },
    ],
    moduleCompletions: [
      { id: "mcp_seed_1", tenantId: "ten_northstar", enrollmentId: "enr_sam_loto", moduleId: "mod_loto_1", completedAt: "2026-08-20T09:35:00.000Z", score: null },
      { id: "mcp_seed_2", tenantId: "ten_northstar", enrollmentId: "enr_sam_loto", moduleId: "mod_loto_2", completedAt: "2026-08-21T10:05:00.000Z", score: null },
    ],
    signals: [
      { id: "sig_ess14", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", source: "regulation", sourceReference: "ESS-14 §4.3 switching sequence, revision 3.1", title: "Revised high-voltage switching authorization standard", summary: "ESS-14 revision 3.1 tightens the authorized switching sequence and adds a mandatory field verification step before energization.", detectedAt: "2026-08-12T08:00:00.000Z", effectiveAt: "2026-09-14", severity: "critical", status: "new", affectedJobRoleIds: ["role_field_tech"], affectedSkillIds: ["skill_loto"], linkedStudyId: null, triagedByUserId: null, triagedAt: null, dismissedReason: null },
      { id: "sig_capa17", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", source: "incident", sourceReference: "CAPA-2026-017", title: "Repeat fault-diagnosis errors on the new meter platform", summary: "Three corrective actions in eight weeks trace to the same missing diagnostic branch on the replacement meter platform.", detectedAt: "2026-07-28T09:30:00.000Z", effectiveAt: null, severity: "high", status: "linked", affectedJobRoleIds: ["role_field_tech"], affectedSkillIds: ["skill_diag"], linkedStudyId: "tna_field_2026", triagedByUserId: "usr_analyst", triagedAt: "2026-08-01T10:00:00.000Z", dismissedReason: null },
      { id: "sig_audit9", tenantId: "ten_northstar", orgUnitId: "org_ns_south", source: "audit", sourceReference: "INT-AUD-2026-09", title: "Observation evidence older than policy allows in South Region", summary: "Internal audit found observed-practice evidence beyond the 90-day freshness policy for part of the South Region crew.", detectedAt: "2026-08-19T13:15:00.000Z", effectiveAt: "2026-10-01", severity: "medium", status: "new", affectedJobRoleIds: ["role_field_tech"], affectedSkillIds: ["skill_loto", "skill_diag"], linkedStudyId: null, triagedByUserId: null, triagedAt: null, dismissedReason: null },
      { id: "sig_vendor", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", source: "workforce", sourceReference: "HRIS-CHG-4471", title: "Contractor crew onboarding in South Region", summary: "Eleven contract technicians scheduled to start before storm season; qualification route not yet defined.", detectedAt: "2026-08-22T07:45:00.000Z", effectiveAt: "2026-09-08", severity: "high", status: "new", affectedJobRoleIds: ["role_field_tech"], affectedSkillIds: ["skill_loto"], linkedStudyId: null, triagedByUserId: null, triagedAt: null, dismissedReason: null },
      { id: "sig_dismissed", tenantId: "ten_northstar", orgUnitId: "org_ns_ops", source: "policy", sourceReference: "NSU-POL-221", title: "Expense policy refresh", summary: "Finance policy update circulated to all staff.", detectedAt: "2026-08-05T11:00:00.000Z", effectiveAt: null, severity: "low", status: "dismissed", affectedJobRoleIds: [], affectedSkillIds: [], linkedStudyId: null, triagedByUserId: "usr_analyst", triagedAt: "2026-08-06T09:00:00.000Z", dismissedReason: "No operational competence implication; handled by finance communications." },
      { id: "sig_gulf", tenantId: "ten_gulf", orgUnitId: "org_ge", source: "regulation", sourceReference: "GES-HSE-01 rev 2", title: "Process safety competency refresh", summary: "Regulator requires refreshed process safety competency evidence for operating engineers.", detectedAt: "2026-08-15T06:00:00.000Z", effectiveAt: "2026-11-01", severity: "high", status: "new", affectedJobRoleIds: ["role_gulf_eng"], affectedSkillIds: ["skill_gulf_safe"], linkedStudyId: null, triagedByUserId: null, triagedAt: null, dismissedReason: null },
    ],
    notifications: [],
    auditEvents: [],
  };
}
