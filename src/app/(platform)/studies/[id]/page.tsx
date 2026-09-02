import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader, Progress } from "@/components/ui";
import { Icons } from "@/components/icons";
import { AuthError, principalFromCookies } from "@/lib/server/auth";
import { assertScoped, visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "TNA study" };

/**
 * TNA study record.
 *
 * The route id selects the record: the page shows that study's own objective,
 * status, owner, target roles, findings and response, or nothing at all. The
 * record is authorized individually rather than by route, so an id guessed from
 * outside the tenant or outside a delegated organizational scope is
 * indistinguishable from an id that does not exist.
 */

const STAGES = ["draft", "collecting", "analysis", "approved"] as const;
const STAGE_LABEL = { draft: "Draft", collecting: "Collecting evidence", analysis: "Analysis", approved: "Approved" } as const;
const STAGE_TONE = { draft: "neutral", collecting: "info", analysis: "warning", approved: "success" } as const;

const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const PRIORITY_TONE = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;

const GAP_STATUS_LABEL = { open: "Awaiting triage", triaged: "Triaged", actioned: "Action under way", verified: "Verified closed" } as const;

const INTERVENTION_RANK = { active: 1, planned: 2, completed: 3, verified: 4 } as const;
const INTERVENTION_TYPE_LABEL = { learning: "Learning", coaching: "Coaching", job_aid: "Job aid", process: "Process", tooling: "Tooling", staffing: "Staffing" } as const;
const INTERVENTION_STATUS_LABEL = { planned: "Planned", active: "Active", completed: "Completed", verified: "Verified" } as const;
const INTERVENTION_STATUS_TONE = { planned: "neutral", active: "info", completed: "success", verified: "success" } as const;

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const SEVERITY_TONE = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;
const SIGNAL_SOURCE_LABEL = { regulation: "Regulation", policy: "Policy", incident: "Incident", audit: "Audit", workforce: "Workforce", performance: "Performance" } as const;

const REQUIREMENT_SOURCE_LABEL = { policy: "Policy", regulation: "Regulation", risk: "Risk", strategy: "Strategy", incident: "Incident" } as const;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export default async function StudyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await principalFromCookies();
  const database = await readDatabase();

  const study = database.tnaStudies.find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
  if (!study) notFound();

  // Authorize the record, not the route. A study inside the tenant but outside
  // the viewer's delegated organizational scope must answer exactly as a
  // non-existent id does, or the 403 itself confirms the study exists.
  try {
    assertScoped(database, principal, "tna:read", study);
  } catch (error) {
    if (error instanceof AuthError) notFound();
    throw error;
  }

  const personName = (userId: string) =>
    database.users.find((user) => user.id === userId && user.tenantId === principal.tenantId)?.displayName ?? "No longer an active account";

  const unitName = (orgUnitId: string) =>
    database.orgUnits.find((unit) => unit.id === orgUnitId && unit.tenantId === principal.tenantId)?.name ?? "Unknown organizational unit";

  const roleTitles = study.targetRoleIds.map((roleId) =>
    database.jobRoles.find((role) => role.id === roleId && role.tenantId === principal.tenantId)?.title ?? roleId);

  // Narrow to this study's own records BEFORE scoping them. Scoping the whole
  // tenant's evidence and enrollment tables to answer a question about one
  // study is both wasted work and needless coupling: `visibleRows` now
  // (rightly) refuses to hide a row whose organizational unit is missing, so a
  // broken record belonging to some other study would otherwise take this
  // study's record down with it.
  const gapCases = visibleRows(database, principal, "gap:read", database.gapCases.filter((gap) => gap.tnaStudyId === study.id));
  const gapCaseIds = new Set(gapCases.map((gap) => gap.id));

  const interventions = visibleRows(database, principal, "intervention:read",
    database.interventions.filter((intervention) => gapCaseIds.has(intervention.gapCaseId)));
  const interventionIds = new Set(interventions.map((intervention) => intervention.id));

  const enrollments = visibleRows(database, principal, "enrollment:read",
    database.enrollments.filter((enrollment) => enrollment.interventionId !== null && interventionIds.has(enrollment.interventionId)));

  const gapSubjectIds = new Set(gapCases.map((gap) => gap.subjectUserId));
  const gapSkillIds = new Set(gapCases
    .map((gap) => database.requirements.find((candidate) => candidate.id === gap.requirementId && candidate.tenantId === principal.tenantId)?.skillId)
    .filter((skillId): skillId is string => Boolean(skillId)));
  const evidence = visibleRows(database, principal, "evidence:read",
    database.evidence.filter((item) => gapSubjectIds.has(item.subjectUserId) && gapSkillIds.has(item.skillId)));

  const gapRows = gapCases
    .map((gap) => {
      const requirement = database.requirements.find((candidate) => candidate.id === gap.requirementId && candidate.tenantId === principal.tenantId);
      const skill = requirement && database.skills.find((candidate) => candidate.id === requirement.skillId && candidate.tenantId === principal.tenantId);
      return {
        gap,
        requirement,
        subjectName: personName(gap.subjectUserId),
        skillName: skill?.name ?? "Requirement without a named skill",
        // The evidence actually standing behind the evidenced level, counted
        // under the viewer's own evidence scope.
        evidenceCount: requirement
          ? evidence.filter((item) => item.subjectUserId === gap.subjectUserId && item.skillId === requirement.skillId && item.status === "verified").length
          : 0,
        interventionCount: interventions.filter((intervention) => intervention.gapCaseId === gap.id).length,
      };
    })
    .sort((a, b) =>
      Number(a.gap.status === "verified") - Number(b.gap.status === "verified") ||
      b.gap.gap - a.gap.gap ||
      PRIORITY_RANK[b.gap.priority] - PRIORITY_RANK[a.gap.priority] ||
      a.gap.id.localeCompare(b.gap.id));

  const openGaps = gapRows.filter((row) => row.gap.status !== "verified");
  const criticalOpen = openGaps.filter((row) => row.gap.priority === "critical").length;

  const interventionRows = interventions
    .map((intervention) => {
      const gapRow = gapRows.find((row) => row.gap.id === intervention.gapCaseId);
      const courses = enrollments
        .filter((enrollment) => enrollment.interventionId === intervention.id)
        .map((enrollment) => database.courses.find((course) => course.id === enrollment.courseId && course.tenantId === principal.tenantId)?.title)
        .filter((title): title is string => Boolean(title));
      return { intervention, skillName: gapRow?.skillName ?? "Gap case no longer readable", ownerName: personName(intervention.ownerUserId), courses };
    })
    .sort((a, b) =>
      INTERVENTION_RANK[a.intervention.status] - INTERVENTION_RANK[b.intervention.status] ||
      a.intervention.dueDate.localeCompare(b.intervention.dueDate) ||
      a.intervention.id.localeCompare(b.intervention.id));

  // The persisted development store predates the signals table, so a store
  // written before it existed reads as "no signal", never as a crash.
  const triggeringSignals = visibleRows(database, principal, "signal:read", database.signals ?? [])
    .filter((signal) => signal.linkedStudyId === study.id)
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

  // Coverage is evidenced proficiency over required proficiency on this
  // study's own open gap cases. With no open gap case there is no denominator,
  // so no percentage is claimed.
  const requiredLevels = openGaps.reduce((total, row) => total + row.gap.requiredLevel, 0);
  const evidencedLevels = openGaps.reduce((total, row) => total + Math.min(row.gap.evidencedLevel, row.gap.requiredLevel), 0);
  const coverage = requiredLevels > 0 ? Math.round((evidencedLevels / requiredLevels) * 100) : null;

  const stage = STAGES.indexOf(study.status) + 1;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = study.status !== "approved" && study.dueDate < today;

  return <div className="page fade-in">
    <div className="breadcrumbs">
      <Link href="/studies">TNA studies</Link><Icons.chevron /><span>{study.title}</span>
    </div>

    <PageHeader
      eyebrow={`TNA study · ${study.id}`}
      title={study.title}
      description={study.objective}
      actions={<Link className="button primary" href={`/studies/${study.id}/gaps`}>Open Gap Explorer</Link>}
    />

    <div className="study-status">
      <div><span>Stage</span><strong>{STAGE_LABEL[study.status]} · {stage} of 4</strong></div>
      <div><span>Study owner</span><strong>{personName(study.ownerUserId)}</strong></div>
      <div><span>Organizational unit</span><strong>{unitName(study.orgUnitId)}</strong></div>
      <div><span>Due date</span><strong>{study.dueDate}{overdue ? " · past due" : ""}</strong></div>
    </div>

    <div className="stepper" role="list" aria-label="Study status">
      {STAGES.map((candidate, index) => <div role="listitem" className={index < stage - 1 ? "complete" : index === stage - 1 ? "current" : ""} key={candidate}>
        <span aria-hidden="true">{index < stage - 1 ? "✓" : index + 1}</span>
        <small>{STAGE_LABEL[candidate]}{index === stage - 1 ? " (current)" : ""}</small>
      </div>)}
    </div>

    <section className="stat-strip" aria-label="Findings recorded against this study">
      <div><span>Gap cases</span><strong>{gapRows.length}</strong></div>
      <div><span>Still open</span><strong>{openGaps.length}</strong></div>
      <div><span>Critical and open</span><strong>{criticalOpen}</strong></div>
      <div><span>Interventions</span><strong>{interventionRows.length}</strong></div>
      <div><span>Target roles</span><strong>{roleTitles.length}</strong></div>
    </section>

    <div className="study-detail-grid">
      <section>
        <article className="panel decision-context">
          <div className="panel-header">
            <div><p className="eyebrow">Study objective</p><h2>What this study must close</h2></div>
            <Badge tone={STAGE_TONE[study.status]}>{STAGE_LABEL[study.status]}</Badge>
          </div>
          <blockquote>{study.objective}</blockquote>
          <dl className="fact-list">
            <div><dt>Target roles</dt><dd>{roleTitles.length > 0 ? roleTitles.join(", ") : "No target role recorded"}</dd></div>
            <div><dt>Opened</dt><dd>{study.createdAt.slice(0, 10)}</dd></div>
            <div><dt>Due date</dt><dd>{study.dueDate}{overdue ? " · past due" : ""}</dd></div>
          </dl>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><p className="eyebrow">Findings</p><h2>Gap cases in this study</h2></div>
            <span className="count-badge">{plural(gapRows.length, "gap case", "gap cases")}</span>
          </div>

          {gapRows.length === 0
            ? <p className="muted">
              No gap case is recorded against this study in your scope. Findings appear here once required proficiency has been compared with evidenced
              proficiency for the target roles; until then this study has produced no measurable gap.
            </p>
            : <>
              {coverage !== null && <>
                <Progress value={coverage} label="Evidenced proficiency against required proficiency on open gap cases" />
                <p className="muted">
                  <small>
                    {evidencedLevels} evidenced of {requiredLevels} required proficiency levels across {plural(openGaps.length, "open gap case", "open gap cases")}.
                    Levels are on each requirement&rsquo;s own scale and are capped at the level the requirement asks for.
                  </small>
                </p>
              </>}
              <div className="record-list">
                {gapRows.map(({ gap, requirement, subjectName, skillName, evidenceCount, interventionCount }) =>
                  <Link className="record-row" href={`/studies/${study.id}/gaps`} key={gap.id}>
                    <span className={`severity-mark severity-mark--${gap.priority}`} aria-hidden="true" />
                    <div className="record-main">
                      <strong>{skillName} · {subjectName}</strong>
                      <div className="record-meta">
                        <Badge tone={PRIORITY_TONE[gap.priority]}>{PRIORITY_LABEL[gap.priority]} priority</Badge>
                        <span>Required {gap.requiredLevel} · evidenced {gap.evidencedLevel} · gap {gap.gap}</span>
                        <span>{GAP_STATUS_LABEL[gap.status]}</span>
                        <span>{unitName(gap.orgUnitId)}</span>
                      </div>
                      <div className="record-meta">
                        {requirement
                          ? <span>{REQUIREMENT_SOURCE_LABEL[requirement.sourceType]} source: {requirement.sourceReference} (v{requirement.version}, {requirement.criticality})</span>
                          : <span>The requirement behind this gap case is not readable in your scope.</span>}
                      </div>
                      <div className="record-meta"><span>Recorded cause hypothesis: {gap.causeHypothesis}</span></div>
                    </div>
                    <div className="record-side">
                      <small>{plural(evidenceCount, "verified evidence record", "verified evidence records")}</small>
                      <small>{plural(interventionCount, "intervention", "interventions")}</small>
                    </div>
                  </Link>)}
              </div>
              <div className="panel-foot">
                <p><Icons.info />Each row opens the Gap Explorer for this study. Gap cases outside your delegated organizational scope are not counted above.</p>
                <Link href={`/studies/${study.id}/gaps`}>Compare required and evidenced levels</Link>
              </div>
            </>}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div><p className="eyebrow">Response</p><h2>Interventions on these gap cases</h2></div>
            <span className="count-badge">{plural(interventionRows.length, "intervention", "interventions")}</span>
          </div>
          {interventionRows.length === 0
            ? <p className="muted">No intervention is recorded against this study&rsquo;s gap cases. A gap without an owned action stays open.</p>
            : <div className="record-list">
              {interventionRows.map(({ intervention, skillName, ownerName, courses }) =>
                <div className="record-row" key={intervention.id}>
                  <span className="severity-mark" aria-hidden="true" />
                  <div className="record-main">
                    <strong>{intervention.title}</strong>
                    <div className="record-meta">
                      <span>{INTERVENTION_TYPE_LABEL[intervention.type]}</span>
                      <span>Closes: {skillName}</span>
                      <span>Owner: {ownerName}</span>
                      <span>Due {intervention.dueDate}</span>
                    </div>
                    {courses.length > 0 && <div className="record-meta"><span>Fulfilled by {courses.join(", ")}</span></div>}
                  </div>
                  <div className="record-side">
                    <Badge tone={INTERVENTION_STATUS_TONE[intervention.status]}>{INTERVENTION_STATUS_LABEL[intervention.status]}</Badge>
                  </div>
                </div>)}
            </div>}
        </article>
      </section>

      <aside>
        <article className="panel">
          <p className="eyebrow">Study record</p>
          <h3>As held in the system of record</h3>
          <dl>
            <div className="definition-row"><dt>Study id</dt><dd>{study.id}</dd></div>
            <div className="definition-row"><dt>Status</dt><dd>{STAGE_LABEL[study.status]}</dd></div>
            <div className="definition-row"><dt>Owner</dt><dd>{personName(study.ownerUserId)}</dd></div>
            <div className="definition-row"><dt>Organizational unit</dt><dd>{unitName(study.orgUnitId)}</dd></div>
            <div className="definition-row"><dt>Opened</dt><dd>{study.createdAt.slice(0, 10)}</dd></div>
            <div className="definition-row"><dt>Due date</dt><dd>{study.dueDate}</dd></div>
            <div className="definition-row"><dt>Target roles</dt><dd>{roleTitles.length > 0 ? roleTitles.join(", ") : "None recorded"}</dd></div>
          </dl>
          <p className="inline-note">
            These are the only attributes a TNA study holds. Sponsorship, population size and evidence-collection percentages are not recorded against a
            study, so this page does not report them.
          </p>
        </article>

        <article className="panel">
          <p className="eyebrow">Why this study exists</p>
          {triggeringSignals.length === 0
            ? <>
              <h3>No change signal is linked</h3>
              <p className="muted">
                No signal in your scope has been triaged onto this study. It was raised directly rather than from a detected regulation, incident, audit or
                workforce change.
              </p>
            </>
            : triggeringSignals.map((signal) => <div key={signal.id}>
              <div className="mini-meta">
                <Badge tone={SEVERITY_TONE[signal.severity]}>{SEVERITY_LABEL[signal.severity]} severity</Badge>
                <span>{SIGNAL_SOURCE_LABEL[signal.source]}</span>
              </div>
              <h3>{signal.title}</h3>
              <p className="muted">{signal.summary}</p>
              <dl>
                <div className="definition-row"><dt>Source reference</dt><dd>{signal.sourceReference}</dd></div>
                <div className="definition-row"><dt>Detected</dt><dd>{signal.detectedAt.slice(0, 10)}</dd></div>
                {signal.effectiveAt && <div className="definition-row"><dt>Effective</dt><dd>{signal.effectiveAt}</dd></div>}
                {signal.triagedByUserId && <div className="definition-row"><dt>Triaged by</dt><dd>{personName(signal.triagedByUserId)}</dd></div>}
                {signal.triagedAt && <div className="definition-row"><dt>Triaged on</dt><dd>{signal.triagedAt.slice(0, 10)}</dd></div>}
              </dl>
            </div>)}
          <div className="panel-foot"><Link href="/signals">Open the signal inbox</Link></div>
        </article>
      </aside>
    </div>
  </div>;
}
