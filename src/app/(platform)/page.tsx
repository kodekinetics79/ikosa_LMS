import Link from "next/link";
import { Badge, Confidence, Metric, PageHeader, Progress } from "@/components/ui";
import { Icons } from "@/components/icons";
import { principalFromCookies } from "@/lib/server/auth";
import { readinessSummary, visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Readiness home" };

/**
 * Readiness home.
 *
 * Every figure on this screen is derived from the tenant's own records at
 * request time and passed through the same scoping the API enforces, so the
 * dashboard cannot disagree with the system of record. Anything the store
 * cannot support - dollar exposure, historical trajectory, composite risk
 * scores - is absent rather than estimated: a defensibility product that
 * publishes a plausible-looking invented number has already failed.
 */

const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const PRIORITY_CHIP = { critical: "critical", high: "high", medium: "medium", low: "" } as const;
const PRIORITY_TONE = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;
const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

const GAP_STATUS_LABEL = { open: "Awaiting triage", triaged: "Triaged", actioned: "Action under way", verified: "Verified closed" } as const;

const INTERVENTION_RANK = { active: 1, planned: 2, completed: 3, verified: 4 } as const;
const INTERVENTION_STATUS_LABEL = { planned: "Planned", active: "Active", completed: "Completed", verified: "Verified" } as const;
const INTERVENTION_STATUS_TONE = { planned: "neutral", active: "info", completed: "success", verified: "success" } as const;
const INTERVENTION_TYPE_LABEL = { learning: "Learning", coaching: "Coaching", job_aid: "Job aid", process: "Process", tooling: "Tooling", staffing: "Staffing" } as const;

const ENROLLMENT_RANK = { in_progress: 1, enrolled: 2, completed: 3, withdrawn: 4 } as const;
const ENROLLMENT_STATUS_LABEL = { enrolled: "Not started", in_progress: "In progress", completed: "Completed", withdrawn: "Withdrawn" } as const;
const ENROLLMENT_STATUS_TONE = { enrolled: "neutral", in_progress: "info", completed: "success", withdrawn: "neutral" } as const;

const MAX_ROWS = 6;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export default async function ReadinessHome() {
  const principal = await principalFromCookies();
  const database = await readDatabase();
  const summary = await readinessSummary(principal);

  // Same scoping the API applies: tenant boundary, delegated organizational
  // paths, and learner self-scope. What is not readable is not counted.
  const gapCases = visibleRows(database, principal, "gap:read", database.gapCases);
  const evidence = visibleRows(database, principal, "evidence:read", database.evidence);
  const interventions = visibleRows(database, principal, "intervention:read", database.interventions);
  const enrollments = visibleRows(database, principal, "enrollment:read", database.enrollments);

  const openGaps = gapCases.filter((gap) => gap.status !== "verified");
  const verifiedEvidence = evidence.filter((item) => item.status === "verified");
  const tenantName = database.tenants.find((tenant) => tenant.id === principal.tenantId)?.name ?? "This workspace";

  const personName = (userId: string) => database.users.find((user) => user.id === userId && user.tenantId === principal.tenantId)?.displayName ?? "Unknown person";
  const unitName = (orgUnitId: string) => database.orgUnits.find((unit) => unit.id === orgUnitId && unit.tenantId === principal.tenantId)?.name ?? "Unknown unit";
  const requirementOf = (requirementId: string) => database.requirements.find((requirement) => requirement.id === requirementId && requirement.tenantId === principal.tenantId);
  const skillName = (requirementId: string) => {
    const requirement = requirementOf(requirementId);
    const skill = requirement && database.skills.find((candidate) => candidate.id === requirement.skillId && candidate.tenantId === principal.tenantId);
    return skill?.name ?? "Requirement without a named skill";
  };

  // Highest remaining gap first, then priority. Stated in the panel so the
  // ordering is inspectable rather than an unexplained "risk score".
  const rankedGaps = [...openGaps].sort((a, b) =>
    b.gap - a.gap ||
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    b.requiredLevel - a.requiredLevel ||
    a.id.localeCompare(b.id));
  const shownGaps = rankedGaps.slice(0, MAX_ROWS);
  const gapExplorerHref = rankedGaps[0] ? `/studies/${rankedGaps[0].tnaStudyId}/gaps` : "/studies";

  // Readiness is only meaningful against a denominator. With no open gap case
  // there is nothing to measure, and readinessSummary's vacuous 100% would
  // read as an achievement the records do not support.
  const readinessMeasurable = openGaps.length > 0;
  const requiredLevels = openGaps.reduce((total, gap) => total + gap.requiredLevel, 0);
  const evidencedLevels = openGaps.reduce((total, gap) => total + Math.min(gap.evidencedLevel, gap.requiredLevel), 0);

  const unitTotals = new Map<string, { required: number; evidenced: number; gaps: number }>();
  for (const gap of openGaps) {
    const totals = unitTotals.get(gap.orgUnitId) ?? { required: 0, evidenced: 0, gaps: 0 };
    totals.required += gap.requiredLevel;
    totals.evidenced += Math.min(gap.evidencedLevel, gap.requiredLevel);
    totals.gaps += 1;
    unitTotals.set(gap.orgUnitId, totals);
  }
  const unitRows = [...unitTotals.entries()]
    .map(([orgUnitId, totals]) => ({ orgUnitId, name: unitName(orgUnitId), gaps: totals.gaps, percent: totals.required ? Math.round((totals.evidenced / totals.required) * 100) : 0 }))
    .sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name));

  const rankedInterventions = [...interventions].sort((a, b) =>
    INTERVENTION_RANK[a.status] - INTERVENTION_RANK[b.status] ||
    a.dueDate.localeCompare(b.dueDate) ||
    a.id.localeCompare(b.id));

  const rankedEnrollments = [...enrollments].sort((a, b) =>
    ENROLLMENT_RANK[a.status] - ENROLLMENT_RANK[b.status] ||
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
    a.id.localeCompare(b.id));

  // Evidence carries a recorded strength; the mean of it is a real figure, and
  // it is labelled with its own derivation rather than presented as a score.
  const meanStrength = verifiedEvidence.length ? Math.round((verifiedEvidence.reduce((total, item) => total + item.strength, 0) / verifiedEvidence.length) * 100) : null;
  const latestObservation = verifiedEvidence.map((item) => item.observedAt).sort().at(-1)?.slice(0, 10);

  return <div className="page fade-in">
    <PageHeader
      eyebrow={`${tenantName} · ${plural(summary.studies, "TNA study", "TNA studies")} in scope`}
      title="Workforce readiness, at a glance"
      description="Every figure below is computed from your tenant's records at request time and limited to what you are authorized to see."
      actions={<Link className="button primary" href="/studies">Open TNA studies</Link>}
    />

    <section className="metrics-grid" aria-label="Readiness summary">
      <Metric
        label="Readiness"
        value={readinessMeasurable ? `${summary.readinessPercent}%` : "Not established"}
        meta={readinessMeasurable
          ? `${evidencedLevels} evidenced of ${requiredLevels} required proficiency levels across ${plural(openGaps.length, "open gap case", "open gap cases")}`
          : "No open gap case in scope, so there is nothing to measure readiness against"}
      />
      <Metric
        label="Open gap cases"
        value={`${summary.openGaps}`}
        tone={summary.criticalGaps > 0 ? "danger" : summary.openGaps > 0 ? "warning" : "default"}
        meta={summary.openGaps === 0
          ? "No gap case is open in your scope"
          : `${summary.criticalGaps} at critical priority${gapCases.length > openGaps.length ? ` · ${gapCases.length - openGaps.length} verified closed` : ""}`}
      />
      <Metric
        label="Verified evidence"
        value={`${summary.verifiedEvidence}`}
        meta={`of ${plural(evidence.length, "evidence record", "evidence records")} readable in your scope`}
      />
      <Metric
        label="Active interventions"
        value={`${summary.activeInterventions}`}
        meta={`of ${plural(interventions.length, "intervention", "interventions")} in your scope`}
      />
    </section>

    <section className="dashboard-grid">
      <article className="panel risk-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">{shownGaps.length < rankedGaps.length ? `Decision queue · ${shownGaps.length} of ${rankedGaps.length} shown` : "Decision queue"}</p>
            <h2>Open gap cases</h2>
          </div>
          <Link href={gapExplorerHref}>Open Gap Explorer <Icons.chevron /></Link>
        </div>
        {shownGaps.length === 0
          ? <p className="muted">No gap case is open in your scope. Readiness findings appear here once a TNA study produces them.</p>
          : <>
            <p className="muted"><small>Ordered by remaining gap, then priority. Proficiency levels are on the requirement&apos;s own scale.</small></p>
            <div className="risk-list">
              {shownGaps.map((gap) => {
                const actions = interventions.filter((intervention) => intervention.gapCaseId === gap.id).length;
                return <Link className="risk-item" href={`/studies/${gap.tnaStudyId}/gaps`} key={gap.id}>
                  <span className={`risk-score ${PRIORITY_CHIP[gap.priority]}`} aria-hidden="true">{gap.gap}</span>
                  <div>
                    <strong>{skillName(gap.requirementId)}</strong>
                    <span>{personName(gap.subjectUserId)} · {unitName(gap.orgUnitId)}</span>
                    <div className="mini-meta">
                      <Badge tone={PRIORITY_TONE[gap.priority]}>{PRIORITY_LABEL[gap.priority]} priority</Badge>
                      <span>Gap {gap.gap} · evidenced {gap.evidencedLevel} of {gap.requiredLevel} · {GAP_STATUS_LABEL[gap.status]}</span>
                    </div>
                  </div>
                  <span className="risk-trend">{plural(actions, "intervention", "interventions")}</span>
                  <Icons.chevron />
                </Link>;
              })}
            </div>
          </>}
      </article>

      <article className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Response</p><h2>Interventions</h2></div>
          <Link href="/interventions">Open interventions <Icons.chevron /></Link>
        </div>
        {rankedInterventions.length === 0
          ? <p className="muted">No intervention is recorded in your scope.</p>
          : rankedInterventions.slice(0, MAX_ROWS).map((intervention) => <div className="decision-row" key={intervention.id}>
            <span>
              <strong>{intervention.title}</strong>
              <small>{INTERVENTION_TYPE_LABEL[intervention.type]} · {personName(intervention.ownerUserId)} · due {intervention.dueDate}</small>
            </span>
            <Badge tone={INTERVENTION_STATUS_TONE[intervention.status]}>{INTERVENTION_STATUS_LABEL[intervention.status]}</Badge>
          </div>)}
      </article>
    </section>

    <section className="dashboard-grid lower">
      <article className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Where the gaps sit</p><h2>Readiness by organizational unit</h2></div>
        </div>
        {unitRows.length === 0
          ? <p className="muted">No organizational unit in your scope has an open gap case.</p>
          : <>
            <div className="heat-list">
              {unitRows.map((unit) => <div className="heat-row" key={unit.orgUnitId}>
                <span>{unit.name}</span>
                <Progress value={unit.percent} label={`${unit.name} readiness`} />
                <strong>{unit.percent}%</strong>
                <small>{plural(unit.gaps, "open gap", "open gaps")}</small>
              </div>)}
            </div>
            <p className="muted"><small>A unit appears only where an open gap case exists; readiness is that unit&apos;s evidenced levels divided by its required levels.</small></p>
          </>}
      </article>

      <article className="panel">
        <div className="panel-header">
          <div><p className="eyebrow">Fulfilment</p><h2>Learning in flight</h2></div>
          <Link href="/learning">Open learning <Icons.chevron /></Link>
        </div>
        {rankedEnrollments.length === 0
          ? <p className="muted">No course enrollment is recorded in your scope.</p>
          : rankedEnrollments.slice(0, MAX_ROWS).map((enrollment) => {
            const course = database.courses.find((candidate) => candidate.id === enrollment.courseId && candidate.tenantId === principal.tenantId);
            const emitted = enrollment.evidenceId ? evidence.find((item) => item.id === enrollment.evidenceId) : undefined;
            return <div className="decision-row" key={enrollment.id}>
              <span>
                <strong>{course?.title ?? "Withdrawn course"}</strong>
                <small>
                  {personName(enrollment.subjectUserId)}
                  {enrollment.dueDate ? ` · due ${enrollment.dueDate}` : ""}
                  {emitted ? ` · evidenced level ${emitted.proficiencyLevel}` : course?.evidenceRule === "attendance_only" ? " · attendance only, emits no evidence" : " · no evidence emitted yet"}
                </small>
              </span>
              <Badge tone={ENROLLMENT_STATUS_TONE[enrollment.status]}>{ENROLLMENT_STATUS_LABEL[enrollment.status]}</Badge>
            </div>;
          })}
      </article>
    </section>

    <section className="data-trust">
      <Icons.shield />
      <div>
        <strong>What this view is built from</strong>
        <span>{plural(gapCases.length, "gap case", "gap cases")}, {plural(evidence.length, "evidence record", "evidence records")}, {plural(interventions.length, "intervention", "interventions")} and {plural(enrollments.length, "enrollment", "enrollments")} are readable in your delegated scope. No figure here is estimated, forecast or carried over from a previous period.</span>
      </div>
      {meanStrength !== null && <Confidence value={meanStrength} freshness={`Mean recorded strength of ${plural(verifiedEvidence.length, "verified record", "verified records")}${latestObservation ? ` · latest observed ${latestObservation}` : ""}`} />}
    </section>
  </div>;
}
