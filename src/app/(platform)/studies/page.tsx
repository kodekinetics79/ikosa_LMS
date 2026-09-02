import Link from "next/link";
import { Badge, PageHeader, Progress } from "@/components/ui";
import { principalFromCookies } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "TNA studies" };

/**
 * TNA study register.
 *
 * Every row is a real `tnaStudies` record read through the same scoping the
 * API enforces, and every figure on a card is derived from that record or from
 * the gap cases that belong to it. Nothing here is illustrative: a study that
 * does not exist in the tenant does not appear, and a tenant with no studies is
 * told so rather than shown a plausible portfolio.
 */

const STAGES = ["draft", "collecting", "analysis", "approved"] as const;
const STAGE_LABEL = { draft: "Draft", collecting: "Collecting evidence", analysis: "Analysis", approved: "Approved" } as const;
const STAGE_TONE = { draft: "neutral", collecting: "info", analysis: "warning", approved: "success" } as const;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export default async function Studies() {
  const principal = await principalFromCookies();
  const database = await readDatabase();

  // Tenant boundary, delegated organizational scope and learner self-scope are
  // applied here, so an unreadable study is absent rather than redacted.
  const studies = visibleRows(database, principal, "tna:read", database.tnaStudies);
  const studyIds = new Set(studies.map((study) => study.id));

  // Only the gap cases belonging to a study on this page are scoped. Passing
  // the whole table would do work for studies that are not shown and would
  // couple this register to the integrity of records it never displays.
  const gapCases = visibleRows(database, principal, "gap:read", database.gapCases.filter((gap) => studyIds.has(gap.tnaStudyId)));

  const tenantName = database.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? "This workspace";
  const today = new Date().toISOString().slice(0, 10);

  const rows = studies
    .map((study) => {
      const studyGaps = gapCases.filter((gap) => gap.tnaStudyId === study.id);
      const openGaps = studyGaps.filter((gap) => gap.status !== "verified");
      return {
        study,
        stage: STAGES.indexOf(study.status) + 1,
        owner: database.users.find((user) => user.id === study.ownerUserId && user.tenantId === principal.tenantId)?.displayName ?? "Owner is no longer an active account",
        unit: database.orgUnits.find((unit) => unit.id === study.orgUnitId && unit.tenantId === principal.tenantId)?.name ?? "Unknown organizational unit",
        roleTitles: study.targetRoleIds.map((roleId) => database.jobRoles.find((role) => role.id === roleId && role.tenantId === principal.tenantId)?.title ?? roleId),
        totalGaps: studyGaps.length,
        openGaps: openGaps.length,
        criticalGaps: openGaps.filter((gap) => gap.priority === "critical").length,
        overdue: study.status !== "approved" && study.dueDate < today,
      };
    })
    // Urgency, stated on the page so the ordering is inspectable: an approved
    // study needs nothing, then the weight of unresolved critical findings,
    // then the deadline the study is working to.
    .sort((a, b) =>
      Number(a.study.status === "approved") - Number(b.study.status === "approved") ||
      b.criticalGaps - a.criticalGaps ||
      a.study.dueDate.localeCompare(b.study.dueDate) ||
      b.openGaps - a.openGaps ||
      a.study.title.localeCompare(b.study.title));

  const openTotal = rows.reduce((total, row) => total + row.openGaps, 0);
  const criticalTotal = rows.reduce((total, row) => total + row.criticalGaps, 0);
  const overdueTotal = rows.filter((row) => row.overdue).length;

  return <div className="page fade-in">
    <PageHeader
      eyebrow={`${tenantName} · ${plural(rows.length, "study", "studies")} readable in your scope`}
      title="TNA studies"
      description="Each study carries one objective from a business decision to verified readiness. Every figure below is computed from your tenant's records at request time."
    />

    {rows.length === 0
      ? <section className="panel">
        <p className="eyebrow">No studies</p>
        <h2>No TNA study is readable in your scope</h2>
        <p className="muted">
          {tenantName} has no training needs analysis recorded that your delegated organizational scope covers. Studies appear here once one is created
          through the TNA API for an organizational unit you administer; nothing is shown in the meantime because an empty register is the truthful state.
        </p>
      </section>
      : <>
        <section className="stat-strip" aria-label="Study register totals">
          <div><span>Studies in scope</span><strong>{rows.length}</strong></div>
          <div><span>Open gap cases</span><strong>{openTotal}</strong></div>
          <div><span>Critical open gap cases</span><strong>{criticalTotal}</strong></div>
          <div><span>Studies past their due date</span><strong>{overdueTotal}</strong></div>
        </section>

        <p className="muted">
          <small>Ordered by urgency: studies still in progress first, then the number of critical open gap cases, then the earliest due date. Gap counts cover only the gap cases you are authorized to read.</small>
        </p>

        <div className="study-grid">
          {rows.map(({ study, stage, owner, unit, roleTitles, totalGaps, openGaps, criticalGaps, overdue }) =>
            <Link className="study-card" href={`/studies/${study.id}`} key={study.id}>
              <div className="mini-meta">
                <Badge tone={STAGE_TONE[study.status]}>{STAGE_LABEL[study.status]}</Badge>
                {criticalGaps > 0 && <Badge tone="danger">{plural(criticalGaps, "critical gap case", "critical gap cases")}</Badge>}
                {overdue && <Badge tone="warning">Past due date</Badge>}
              </div>
              <h2>{study.title}</h2>
              <p>{study.objective}</p>
              <div className="study-stage">
                <span>Stage {stage} of 4 · {STAGE_LABEL[study.status]}</span>
                <strong>{totalGaps === 0 ? "No gap cases yet" : `${openGaps} open of ${plural(totalGaps, "gap case", "gap cases")}`}</strong>
              </div>
              <Progress value={stage * 25} label={`${study.title} stage ${stage} of 4`} />
              <dl>
                <div><dt>Study owner</dt><dd>{owner}</dd></div>
                <div><dt>Organizational unit</dt><dd>{unit}</dd></div>
                <div><dt>Due date</dt><dd>{study.dueDate}{overdue ? " · past due" : ""}</dd></div>
                <div><dt>Target roles</dt><dd>{roleTitles.length > 0 ? roleTitles.join(", ") : "No target role recorded"}</dd></div>
              </dl>
            </Link>)}
        </div>

        <p className="inline-note">
          A study card shows only what the record supports: its own status, owner, organizational unit, due date and target roles, plus gap cases counted from
          the study&rsquo;s own findings. Population size, sponsorship and completion forecasts are not held against a study, so they are not shown.
        </p>
      </>}
  </div>;
}
