import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader } from "@/components/ui";
import { Icons } from "@/components/icons";
import { AuthError, principalFromCookies } from "@/lib/server/auth";
import type { Evidence } from "@/lib/server/domain";
import { assertScoped, visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Gap explorer" };

/**
 * Gap Explorer.
 *
 * The route id selects the study; every figure below is read from that study's
 * own gap cases, the requirement that raised each one, and the evidence rows
 * standing behind the evidenced level. Nothing is estimated, averaged or
 * inferred: where a record is absent the page says so instead of filling the
 * space, because a fabricated readiness number is worse than a missing one.
 *
 * Layout note: `.data-table` carries a 780px floor, so the table sits in the
 * page's block flow rather than inside `.gap-layout`. Below 1100px that grid
 * collapses to a single `1fr` track whose automatic minimum is the widest
 * item, and a table in it drags the whole page sideways.
 */

const STAGE_LABEL = { draft: "Draft", collecting: "Collecting evidence", analysis: "Analysis", approved: "Approved" } as const;

const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const PRIORITY_TONE = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;

const GAP_STATUS_LABEL = { open: "Awaiting triage", triaged: "Triaged", actioned: "Action under way", verified: "Verified closed" } as const;
const GAP_STATUS_TONE = { open: "warning", triaged: "info", actioned: "info", verified: "success" } as const;

const REQUIREMENT_SOURCE_LABEL = { policy: "Policy", regulation: "Regulation", risk: "Risk", strategy: "Strategy", incident: "Incident" } as const;
const CRITICALITY_LABEL = { standard: "Standard", important: "Important", mandatory: "Mandatory" } as const;
const CRITICALITY_MARK = { mandatory: "critical", important: "high", standard: "low" } as const;

const EVIDENCE_TYPE_LABEL = { assessment: "Assessment", observation: "Observation", work_product: "Work product", credential: "Credential" } as const;
const EVIDENCE_STATUS_LABEL = { pending: "Awaiting verification", verified: "Verified", revoked: "Revoked" } as const;
const EVIDENCE_STATUS_TONE = { pending: "warning", verified: "success", revoked: "danger" } as const;

const INTERVENTION_TYPE_LABEL = { learning: "Learning", coaching: "Coaching", job_aid: "Job aid", process: "Process", tooling: "Tooling", staffing: "Staffing" } as const;
const INTERVENTION_STATUS_LABEL = { planned: "Planned", active: "Active", completed: "Completed", verified: "Verified" } as const;
const INTERVENTION_STATUS_TONE = { planned: "neutral", active: "info", completed: "success", verified: "success" } as const;

const ENROLLMENT_STATUS_LABEL = { enrolled: "Enrolled", in_progress: "In progress", completed: "Completed", withdrawn: "Withdrawn" } as const;
const ENROLLMENT_STATUS_TONE = { enrolled: "neutral", in_progress: "info", completed: "success", withdrawn: "neutral" } as const;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Dates are held as ISO strings; the leading date part is shown verbatim so an audit reader sees the stored value. */
function day(value: string): string {
  return value.slice(0, 10);
}

/**
 * Machine-generated references such as `COURSE:LOTO-401 v3 / ENROLLMENT:enr_a9a...`
 * contain no natural break, and one unbreakable token pushes a narrow column -
 * and with it the whole page - sideways. `<wbr>` offers the break opportunity
 * without altering the text that is read out or copied.
 */
function breakable(reference: string) {
  const parts = reference.split(/(?<=[\/:_-])/g);
  return parts.map((part, index) => <Fragment key={index}>{part}{index < parts.length - 1 && <wbr />}</Fragment>);
}

function hasLapsed(record: Evidence, now: number): boolean {
  return record.expiresAt !== null && new Date(record.expiresAt).getTime() < now;
}

/**
 * The remaining gap in words.
 *
 * The `.level-dot` marks beside each level encode required-versus-evidenced in
 * colour alone, and the numerals beside them are styled identically, so a
 * reader who cannot separate red from amber from blue cannot tell an at-risk
 * level from a compliant one. Every level on this page is therefore also
 * stated in text, and this is the sentence that states it.
 */
function gapLabel(gap: number): string {
  if (gap > 0) return `${plural(gap, "level", "levels")} short`;
  if (gap === 0) return "Requirement met";
  return `${plural(Math.abs(gap), "level", "levels")} above requirement`;
}

function evidencedDotClass(gap: number): string {
  if (gap >= 2) return "level-dot bad";
  if (gap === 1) return "level-dot medium";
  return "level-dot";
}

export default async function GapExplorer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await principalFromCookies();
  const database = await readDatabase();
  // Real clock time: expiry is a comparison against now, and no fixed value can
  // stand in for it without letting a lapsed record read as current capability.
  const now = new Date().getTime();

  const study = database.tnaStudies.find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
  if (!study) notFound();

  // Authorize the record, not the route. A study inside the tenant but outside
  // the viewer's delegated organizational scope must answer exactly as an
  // unknown id does, or the refusal itself confirms the study exists.
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

  const visibleEvidence = visibleRows(database, principal, "evidence:read", database.evidence);
  const visibleInterventions = visibleRows(database, principal, "intervention:read", database.interventions);
  const visibleEnrollments = visibleRows(database, principal, "enrollment:read", database.enrollments);

  const rows = visibleRows(database, principal, "gap:read", database.gapCases)
    .filter((gapCase) => gapCase.tnaStudyId === study.id)
    .map((gapCase) => {
      const requirement = database.requirements.find((candidate) => candidate.id === gapCase.requirementId && candidate.tenantId === principal.tenantId);
      const skill = requirement && database.skills.find((candidate) => candidate.id === requirement.skillId && candidate.tenantId === principal.tenantId);
      const jobRole = requirement && database.jobRoles.find((candidate) => candidate.id === requirement.jobRoleId && candidate.tenantId === principal.tenantId);

      // The evidence rows that stand behind the evidenced level: same person,
      // same skill. Newest first, so a lapsed record is never the first thing
      // read as if it were current.
      const evidence = requirement
        ? visibleEvidence
          .filter((record) => record.subjectUserId === gapCase.subjectUserId && record.skillId === requirement.skillId)
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        : [];
      const lapsed = evidence.filter((record) => hasLapsed(record, now));
      const unverified = evidence.filter((record) => record.status !== "verified");
      const current = evidence.filter((record) => record.status === "verified" && !hasLapsed(record, now));
      const strongestCurrent = current.reduce<Evidence | null>((best, record) => (!best || record.proficiencyLevel > best.proficiencyLevel ? record : best), null);

      const interventions = visibleInterventions.filter((intervention) => intervention.gapCaseId === gapCase.id);
      const interventionIds = new Set(interventions.map((intervention) => intervention.id));
      const enrollments = visibleEnrollments.filter((enrollment) =>
        enrollment.gapCaseId === gapCase.id || (enrollment.interventionId !== null && interventionIds.has(enrollment.interventionId)));

      return {
        gapCase,
        requirement,
        jobRole,
        subjectName: personName(gapCase.subjectUserId),
        skillName: skill?.name ?? "Requirement without a readable skill",
        skillCode: skill?.code ?? null,
        evidence,
        lapsed,
        unverified,
        current,
        strongestCurrent,
        interventions,
        enrollments,
      };
    })
    // Largest remaining gap first, then the priority recorded on the case. Two
    // cases equal on both keep a stable order by id.
    .sort((a, b) =>
      b.gapCase.gap - a.gapCase.gap ||
      PRIORITY_RANK[b.gapCase.priority] - PRIORITY_RANK[a.gapCase.priority] ||
      a.gapCase.id.localeCompare(b.gapCase.id));

  const people = new Set(rows.map((row) => row.gapCase.subjectUserId));
  const criticalOpen = rows.filter((row) => row.gapCase.priority === "critical" && row.gapCase.status !== "verified").length;
  const levelsShort = rows.reduce((total, row) => total + Math.max(0, row.gapCase.gap), 0);
  const evidenceReviewed = rows.reduce((total, row) => total + row.evidence.length, 0);
  const evidenceLapsed = rows.reduce((total, row) => total + row.lapsed.length, 0);

  // One entry per requirement that raised a gap case here: the obligations this
  // study is actually accountable to.
  const obligations = rows.reduce<{ key: string; label: string; detail: string; requiredLevel: number; criticality: keyof typeof CRITICALITY_MARK; count: number }[]>(
    (list, { requirement }) => {
      if (!requirement) return list;
      const existing = list.find((entry) => entry.key === requirement.id);
      if (existing) {
        existing.count += 1;
        return list;
      }
      list.push({
        key: requirement.id,
        label: requirement.sourceReference,
        detail: `${REQUIREMENT_SOURCE_LABEL[requirement.sourceType]} · version ${requirement.version} · ${CRITICALITY_LABEL[requirement.criticality]} · in force from ${requirement.effectiveFrom}`,
        requiredLevel: requirement.requiredLevel,
        criticality: requirement.criticality,
        count: 1,
      });
      return list;
    }, []);

  return <div className="page fade-in">
    <div className="breadcrumbs">
      <Link href="/studies">TNA studies</Link><Icons.chevron /><Link href={`/studies/${study.id}`}>{study.title}</Link><Icons.chevron /><span>Gap Explorer</span>
    </div>

    <PageHeader
      eyebrow={`${study.id} · ${STAGE_LABEL[study.status]}`}
      title="Gap Explorer"
      description="Each row is one person measured against one requirement, beside the obligation that created that requirement and the evidence records behind the level they are credited with."
    />

    <section className="panel gap-table-wrap gap-inspector">
      <div className="panel-header">
        <div><p className="eyebrow">Findings</p><h2>Gap cases in this study</h2></div>
        <span>{plural(rows.length, "gap case", "gap cases")}</span>
      </div>

      {rows.length === 0
        ? <>
          <p className="muted">
            No gap case is recorded against this study within your delegated organizational scope. A gap case exists only once a required proficiency has
            been compared with evidenced proficiency for a named person, so there is nothing here to show and nothing is assumed in its place.
          </p>
          <p className="inline-note">
            This is the study record answering for itself. It is not an error, and it is not a claim that the workforce is compliant &mdash; only that this
            study has produced no comparison you are able to see.
          </p>
        </>
        : <>
          <div className="stat-strip">
            <div><span>Gap cases</span><strong>{rows.length}</strong></div>
            <div><span>People</span><strong>{people.size}</strong></div>
            <div><span>Critical, not yet closed</span><strong>{criticalOpen}</strong></div>
            <div><span>Proficiency levels short</span><strong>{levelsShort}</strong></div>
            <div><span>Evidence records behind them</span><strong>{evidenceReviewed}</strong></div>
            <div><span>Of those, lapsed</span><strong>{evidenceLapsed}</strong></div>
          </div>

          {/* Focusable and named: the table carries a fixed minimum width, and a
              scrollable region only a mouse can pan is unreachable by keyboard. */}
          <div className="table-scroll" role="region" aria-label="Gap cases table" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">
                Gap cases in {study.title}, sorted by remaining gap and then by priority. Required and evidenced levels are stated in words as well as
                marked with a coloured dot.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Skill</th>
                  <th scope="col">Obligation that requires it</th>
                  <th scope="col">Required</th>
                  <th scope="col">Evidenced</th>
                  <th scope="col">Remaining gap</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Status</th>
                  {/* A visible header, not `.sr-only`: that class is absolutely
                      positioned, so inside a horizontally scrolled table it escapes
                      the scroll container and drags the whole document sideways. */}
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ gapCase, requirement, subjectName, skillName, skillCode, evidence }) => <tr key={gapCase.id}>
                  <td>
                    <strong>{subjectName}</strong>
                    <span className="mini-meta muted">{unitName(gapCase.orgUnitId)}</span>
                  </td>
                  <td>
                    {skillName}
                    {skillCode && <span className="mini-meta muted">{skillCode}</span>}
                  </td>
                  <td>
                    {requirement
                      ? <>
                        <strong>{breakable(requirement.sourceReference)}</strong>
                        <span className="mini-meta muted">
                          {REQUIREMENT_SOURCE_LABEL[requirement.sourceType]} · v{requirement.version} · {CRITICALITY_LABEL[requirement.criticality]} · from {requirement.effectiveFrom}
                        </span>
                      </>
                      : <span className="muted">The requirement behind this gap case is not readable in your scope.</span>}
                  </td>
                  <td>
                    <span className="level-dot" aria-hidden="true" /> Level {gapCase.requiredLevel}
                    <span className="mini-meta muted">{requirement ? `${CRITICALITY_LABEL[requirement.criticality]} requirement` : "Level as recorded on the case"}</span>
                  </td>
                  <td>
                    <span className={evidencedDotClass(gapCase.gap)} aria-hidden="true" /> Level {gapCase.evidencedLevel}
                    <span className="mini-meta muted">
                      {gapCase.gap > 0 ? "Below the required level" : gapCase.gap === 0 ? "Meets the required level" : "Above the required level"}
                    </span>
                  </td>
                  <td>
                    <strong>{gapLabel(gapCase.gap)}</strong>
                    <span className="mini-meta muted">{plural(evidence.length, "evidence record", "evidence records")}</span>
                  </td>
                  <td><Badge tone={PRIORITY_TONE[gapCase.priority]}>{PRIORITY_LABEL[gapCase.priority]}</Badge></td>
                  <td><Badge tone={GAP_STATUS_TONE[gapCase.status]}>{GAP_STATUS_LABEL[gapCase.status]}</Badge></td>
                  <td><a className="text-button" href={`#gap-${gapCase.id}`}>Evidence records</a></td>
                </tr>)}
              </tbody>
            </table>
          </div>

          <div className="table-note">
            <span>Showing {plural(rows.length, "gap case", "gap cases")}, sorted by remaining gap and then by recorded priority.</span>
            <span>Gap cases outside your delegated organizational scope are not shown and are not counted here.</span>
          </div>

          <h3>Where these required levels come from</h3>
          <p className="muted">
            A gap case is only defensible if the level it measures against traces to a written obligation. These are the obligations behind the rows above,
            read from the requirement records themselves.
          </p>
          <div className="record-list">
            {obligations.length === 0
              ? <p className="muted">No requirement behind these gap cases is readable in your scope, so no obligation can be shown.</p>
              : obligations.map((obligation) => <div className="record-row" key={obligation.key}>
                <span className={`severity-mark severity-mark--${CRITICALITY_MARK[obligation.criticality]}`} aria-hidden="true" />
                <div className="record-main">
                  <strong>{breakable(obligation.label)}</strong>
                  <div className="record-meta">
                    <span>{obligation.detail}</span>
                    <span>Requires level {obligation.requiredLevel}</span>
                  </div>
                </div>
                <div className="record-side">
                  <small>{plural(obligation.count, "gap case", "gap cases")}</small>
                </div>
              </div>)}
          </div>
        </>}

      <h3>Study record</h3>
      <dl>
        <div className="definition-row"><dt>Study</dt><dd>{study.title}</dd></div>
        <div className="definition-row"><dt>Stage</dt><dd>{STAGE_LABEL[study.status]}</dd></div>
        <div className="definition-row"><dt>Owner</dt><dd>{personName(study.ownerUserId)}</dd></div>
        <div className="definition-row"><dt>Organizational unit</dt><dd>{unitName(study.orgUnitId)}</dd></div>
        <div className="definition-row"><dt>Due date</dt><dd>{study.dueDate}</dd></div>
      </dl>
      <div className="inspector-actions">
        <Link className="button secondary" href={`/studies/${study.id}`}>Back to the study record</Link>
      </div>
    </section>

    {rows.length > 0 && <dl className="fact-list">
      <div><dt>Required</dt><dd>The proficiency level the obligation demands</dd></div>
      <div><dt>Evidenced</dt><dd>The level recorded on the gap case</dd></div>
      <div><dt>Remaining gap</dt><dd>Stated in words in every row, never in colour alone</dd></div>
      <div><dt>What follows</dt><dd>One panel per gap case, with the evidence records its level rests on</dd></div>
    </dl>}

    <div className="gap-layout">
      {rows.map(({ gapCase, requirement, jobRole, subjectName, skillName, skillCode, evidence, lapsed, unverified, current, strongestCurrent, interventions, enrollments }) => [
        <article className="panel gap-inspector" id={`gap-${gapCase.id}`} key={`${gapCase.id}-evidence`} aria-labelledby={`gap-${gapCase.id}-heading`}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Gap case · {gapCase.id}</p>
              <h2 id={`gap-${gapCase.id}-heading`}>{subjectName} · {skillName}</h2>
            </div>
            <Badge tone={PRIORITY_TONE[gapCase.priority]}>{PRIORITY_LABEL[gapCase.priority]}</Badge>
          </div>

          <div className="gap-score">
            <div><span>Required</span><strong>{gapCase.requiredLevel}</strong></div>
            <Icons.chevron />
            <div><span>Evidenced</span><strong>{gapCase.evidencedLevel}</strong></div>
            {gapCase.gap > 0 && <div className="delta">{gapLabel(gapCase.gap)}</div>}
          </div>
          {/* The delta chip above already carries the shortfall in words; where
              there is no chip the same fact is stated here rather than in colour. */}
          <p className="mini-meta muted">{gapCase.gap > 0 ? null : <>{gapLabel(gapCase.gap)} · </>}{GAP_STATUS_LABEL[gapCase.status]} · {unitName(gapCase.orgUnitId)}</p>

          <h3>The evidence behind the evidenced level</h3>
          {evidence.length === 0
            ? <p className="muted">
              No evidence record for {subjectName} against this skill is readable in your scope. The evidenced level above is the value stored on the gap
              case; nothing on this page corroborates it.
            </p>
            : <>
              <ul className="evidence-points">
                <li><b>{current.length}</b>verified and unexpired {current.length === 1 ? "record" : "records"} that can support a current capability claim</li>
                <li><b>{lapsed.length}</b>lapsed {lapsed.length === 1 ? "record" : "records"} past the expiry date held against {lapsed.length === 1 ? "it" : "them"}</li>
                <li><b>{unverified.length}</b>{unverified.length === 1 ? "record" : "records"} not in a verified state</li>
              </ul>
              <div className="record-list">
                {evidence.map((record) => {
                  const expired = hasLapsed(record, now);
                  return <div className="record-row" key={record.id}>
                    <span className={`severity-mark${expired || record.status === "revoked" ? " severity-mark--critical" : record.status === "pending" ? " severity-mark--high" : ""}`} aria-hidden="true" />
                    <div className="record-main">
                      <strong>Level {record.proficiencyLevel} · {EVIDENCE_TYPE_LABEL[record.type]}</strong>
                      <div className="record-meta">
                        <span>{breakable(record.sourceReference)}</span>
                        <span>Observed {day(record.observedAt)}</span>
                        <span>Strength {Math.round(record.strength * 100)}%</span>
                        <span>{record.assessorUserId ? `Assessed by ${personName(record.assessorUserId)}` : "No named assessor"}</span>
                      </div>
                      <div className="record-meta">
                        <span>
                          {record.expiresAt === null
                            ? "No expiry recorded"
                            : expired
                              ? `Expired ${day(record.expiresAt)} — lapsed, and cannot be read as current capability`
                              : `Valid until ${day(record.expiresAt)}`}
                        </span>
                      </div>
                    </div>
                    <div className="record-side">
                      <Badge tone={EVIDENCE_STATUS_TONE[record.status]}>{EVIDENCE_STATUS_LABEL[record.status]}</Badge>
                      {expired && <Badge tone="danger">Expired</Badge>}
                    </div>
                  </div>;
                })}
              </div>
              <div className="source-proof">
                <Icons.shield />
                <span>
                  <strong>
                    {strongestCurrent
                      ? `Strongest verified, unexpired evidence on record: level ${strongestCurrent.proficiencyLevel}`
                      : "No verified, unexpired evidence on record"}
                  </strong>
                  <small>
                    {strongestCurrent
                      ? <>{EVIDENCE_TYPE_LABEL[strongestCurrent.type]} {breakable(strongestCurrent.sourceReference)}, observed {day(strongestCurrent.observedAt)}. The gap case stores an evidenced level of {gapCase.evidencedLevel}.</>
                      : `Every record above is lapsed, revoked or still awaiting verification. The gap case stores an evidenced level of ${gapCase.evidencedLevel}.`}
                  </small>
                </span>
              </div>
              {strongestCurrent && strongestCurrent.proficiencyLevel !== gapCase.evidencedLevel && <p className="inline-note">
                The stored evidenced level ({gapCase.evidencedLevel}) and the strongest current evidence on record (level {strongestCurrent.proficiencyLevel})
                disagree. The table above reports the value stored on the gap case; the records here are the ledger as it stands now.
              </p>}
            </>}

          <h3>Interventions on this gap case</h3>
          {interventions.length === 0
            ? <p className="muted">No intervention is recorded against this gap case. A gap without an owned action stays open.</p>
            : <div className="record-list">
              {interventions.map((intervention) => <div className="record-row" key={intervention.id}>
                <span className="severity-mark" aria-hidden="true" />
                <div className="record-main">
                  <strong>{intervention.title}</strong>
                  <div className="record-meta">
                    <span>{INTERVENTION_TYPE_LABEL[intervention.type]}</span>
                    <span>Owner: {personName(intervention.ownerUserId)}</span>
                    <span>Due {intervention.dueDate}</span>
                  </div>
                </div>
                <div className="record-side">
                  <Badge tone={INTERVENTION_STATUS_TONE[intervention.status]}>{INTERVENTION_STATUS_LABEL[intervention.status]}</Badge>
                </div>
              </div>)}
            </div>}

          <h3>Learning assigned to close it</h3>
          {enrollments.length === 0
            ? <p className="muted">No course enrollment is attached to this gap case or to its interventions.</p>
            : <div className="record-list">
              {enrollments.map((enrollment) => {
                const course = database.courses.find((candidate) => candidate.id === enrollment.courseId && candidate.tenantId === principal.tenantId);
                const emitted = enrollment.evidenceId ? visibleEvidence.find((record) => record.id === enrollment.evidenceId) : undefined;
                return <div className="record-row" key={enrollment.id}>
                  <span className="severity-mark" aria-hidden="true" />
                  <div className="record-main">
                    <strong>{course ? `${course.title} (${course.code} v${course.version})` : "Course not readable in your scope"}</strong>
                    <div className="record-meta">
                      <span>{personName(enrollment.subjectUserId)}</span>
                      <span>{ENROLLMENT_STATUS_LABEL[enrollment.status]}</span>
                      <span>{enrollment.dueDate ? `Due ${enrollment.dueDate}` : "No due date"}</span>
                      <span>{enrollment.score === null ? "No score recorded" : `Score ${Math.round(enrollment.score * 100)}%`}</span>
                      <span>{enrollment.interventionId ? "Fulfils an intervention" : "Assigned outside an intervention"}</span>
                    </div>
                    <div className="record-meta">
                      <span>
                        {emitted
                          ? <>Completion issued evidence {breakable(emitted.sourceReference)} at level {emitted.proficiencyLevel}{emitted.expiresAt ? `, valid until ${day(emitted.expiresAt)}.` : ", with no expiry."}</>
                          : course && course.evidenceRule === "attendance_only"
                            ? "This course records attendance only. Completing it emits no competence evidence, so it cannot close the gap on its own."
                            : enrollment.status === "completed"
                              ? "Completed, but no evidence record is attached to this enrollment."
                              : "No evidence emitted yet: evidence is issued only on a passing completion."}
                      </span>
                    </div>
                  </div>
                  <div className="record-side">
                    <Badge tone={ENROLLMENT_STATUS_TONE[enrollment.status]}>{ENROLLMENT_STATUS_LABEL[enrollment.status]}</Badge>
                    {emitted ? <Badge tone="success">Evidence emitted</Badge> : <small>No evidence yet</small>}
                  </div>
                </div>;
              })}
            </div>}
        </article>,

        <aside className="panel gap-inspector" key={`${gapCase.id}-obligation`} aria-label={`Obligation and recorded hypothesis for gap case ${gapCase.id}`}>
          <p className="eyebrow">Obligation</p>
          {requirement
            ? <>
              <div className="source-proof">
                <Icons.shield />
                <span>
                  <strong>{breakable(requirement.sourceReference)}</strong>
                  <small>{REQUIREMENT_SOURCE_LABEL[requirement.sourceType]} · version {requirement.version}</small>
                </span>
              </div>
              <dl>
                <div className="definition-row"><dt>Requires</dt><dd>Level {requirement.requiredLevel}</dd></div>
                <div className="definition-row"><dt>Criticality</dt><dd>{CRITICALITY_LABEL[requirement.criticality]}</dd></div>
                <div className="definition-row"><dt>Skill</dt><dd>{skillCode ? `${skillName} (${skillCode})` : skillName}</dd></div>
                <div className="definition-row"><dt>Job role</dt><dd>{jobRole ? `${jobRole.title} (${jobRole.code})` : "Not readable in your scope"}</dd></div>
                <div className="definition-row"><dt>In force from</dt><dd>{requirement.effectiveFrom}</dd></div>
                <div className="definition-row"><dt>In force until</dt><dd>{requirement.effectiveTo ?? "No end date"}</dd></div>
                <div className="definition-row"><dt>Requirement id</dt><dd>{requirement.id}</dd></div>
              </dl>
            </>
            : <p className="muted">The requirement behind this gap case is not readable in your scope, so the level above cannot be traced to its obligation here.</p>}

          <h3>Recorded cause hypothesis</h3>
          <p>{gapCase.causeHypothesis}</p>
          <p className="inline-note">
            This is the hypothesis stored on the gap case, not a finding. Nothing on this page tests it: the evidence records establish the level, not the
            reason for it, and the hypothesis stands until an intervention outcome confirms or replaces it.
          </p>

          <h3>Case state</h3>
          <dl>
            <div className="definition-row"><dt>Status</dt><dd>{GAP_STATUS_LABEL[gapCase.status]}</dd></div>
            <div className="definition-row"><dt>Priority</dt><dd>{PRIORITY_LABEL[gapCase.priority]}</dd></div>
            <div className="definition-row"><dt>Remaining gap</dt><dd>{gapLabel(gapCase.gap)}</dd></div>
            <div className="definition-row"><dt>Subject</dt><dd>{subjectName}</dd></div>
            <div className="definition-row"><dt>Organizational unit</dt><dd>{unitName(gapCase.orgUnitId)}</dd></div>
          </dl>
        </aside>,
      ])}
    </div>
  </div>;
}
