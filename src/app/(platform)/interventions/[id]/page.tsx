import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { Badge, PageHeader, Progress } from "@/components/ui";
import { Icons } from "@/components/icons";
import { AssignLearning, type AssignableCourse } from "@/components/assign-learning";
import type { Course, Evidence, GapCase, Intervention, Requirement } from "@/lib/server/domain";
import { AuthError, authorize, principalFromCookies } from "@/lib/server/auth";
import { assertScoped, availableCourses, orgFor, visibleRows } from "@/lib/server/domain-service";
import { courseProgress } from "@/lib/server/learning";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Intervention" };

const typeLabel: Record<Intervention["type"], string> = {
  learning: "Learning",
  coaching: "Coaching",
  job_aid: "Job aid",
  process: "Process change",
  tooling: "Tooling",
  staffing: "Staffing",
};

const statusLabel: Record<Intervention["status"], string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  verified: "Verified",
};

const statusTone = { planned: "neutral", active: "info", completed: "success", verified: "success" } as const;

const priorityTone = { critical: "danger", high: "warning", medium: "info", low: "neutral" } as const;

const priorityLabel: Record<GapCase["priority"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const sourceLabel: Record<Requirement["sourceType"], string> = {
  policy: "Policy",
  regulation: "Regulation",
  risk: "Risk assessment",
  strategy: "Strategy",
  incident: "Incident / corrective action",
};

const enrollmentStatusLabel = {
  enrolled: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  withdrawn: "Withdrawn",
} as const;

const enrollmentStatusTone = { enrolled: "neutral", in_progress: "info", completed: "success", withdrawn: "neutral" } as const;

/**
 * States what a completion of this course would actually prove, in the terms the
 * learning module enforces. An attendance-only course is called out as emitting
 * nothing: it is the case where a manager is most likely to believe a gap has
 * been closed when the evidence ledger has not moved at all.
 */
function outcomeSentence(course: Course, evidence: Evidence | undefined, requiredLevel: number | undefined): string {
  if (evidence) {
    const validity = evidence.expiresAt ? `valid until ${evidence.expiresAt.slice(0, 10)}` : "with no expiry";
    const shortfall = requiredLevel !== undefined && evidence.proficiencyLevel < requiredLevel
      ? ` The requirement is level ${requiredLevel}, so the gap is reduced but not closed.`
      : "";
    return `Completed. ${course.code} issued ${evidence.status} evidence at level ${evidence.proficiencyLevel}, ${validity}.${shortfall}`;
  }
  if (course.evidenceRule === "attendance_only") {
    return `${course.code} records attendance only. Completing it emits no competence evidence, so it cannot close this gap.`;
  }
  const validity = course.validityMonths ? `, valid for ${course.validityMonths} months` : ", with no expiry";
  const shortfall = requiredLevel !== undefined && course.targetLevel < requiredLevel
    ? ` The requirement is level ${requiredLevel}, so passing alone will not close this gap.`
    : "";
  return `Passing ${course.code} at ${Math.round(course.passingScore * 100)}% or above issues verified evidence at level ${course.targetLevel}${validity}.${shortfall}`;
}

export default async function InterventionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await principalFromCookies();
  const db = await readDatabase();

  const intervention = db.interventions.find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
  if (!intervention) notFound();

  // Authorize the specific record, not merely the route: an id guessed from
  // another organizational unit must be indistinguishable from one that does
  // not exist.
  try {
    assertScoped(db, principal, "intervention:read", intervention);
  } catch (error) {
    // Only an authorization refusal is answered as "no such record". A row
    // pointing at a missing organizational unit is a data fault, and hiding it
    // behind a 404 would make the register quietly under-report real actions.
    if (error instanceof AuthError) notFound();
    throw error;
  }

  const record = db.gapCases.find((candidate) => candidate.id === intervention.gapCaseId && candidate.tenantId === principal.tenantId);
  // The gap names a person, so it carries its own authorization decision. A
  // reader entitled to the unit's action register is not thereby entitled to
  // that person's competence record.
  const gap = record && visibleRows(db, principal, "gap:read", [record]).length === 1 ? record : undefined;
  const requirement = gap ? db.requirements.find((candidate) => candidate.id === gap.requirementId) : undefined;
  const skill = requirement ? db.skills.find((candidate) => candidate.id === requirement.skillId) : undefined;
  const jobRole = requirement ? db.jobRoles.find((candidate) => candidate.id === requirement.jobRoleId) : undefined;
  const subject = gap ? db.users.find((candidate) => candidate.id === gap.subjectUserId) : undefined;
  const owner = db.users.find((candidate) => candidate.id === intervention.ownerUserId);
  const orgUnit = orgFor(db, intervention.tenantId, intervention.orgUnitId);
  const study = gap ? db.tnaStudies.find((candidate) => candidate.id === gap.tnaStudyId) : undefined;
  const isLearning = intervention.type === "learning";

  const enrollments = visibleRows(db, principal, "enrollment:read", db.enrollments)
    .filter((candidate) => candidate.interventionId === intervention.id)
    .map((enrollment) => ({
      enrollment,
      course: db.courses.find((candidate) => candidate.id === enrollment.courseId),
      learner: db.users.find((candidate) => candidate.id === enrollment.subjectUserId),
      evidence: enrollment.evidenceId ? db.evidence.find((candidate) => candidate.id === enrollment.evidenceId) : undefined,
      progress: courseProgress(db, enrollment),
    }));

  // Mirror the enrollment API's own authorization so the control is never shown
  // to someone whose submission would be refused.
  const subjectOrg = subject ? orgFor(db, principal.tenantId, subject.orgUnitId) : undefined;
  let canAssign = false;
  if (subject && subjectOrg) {
    try {
      authorize(principal, "enrollment:create", { tenantId: principal.tenantId, orgUnit: subjectOrg, subjectUserId: subject.id });
      canAssign = true;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      canAssign = false;
    }
  }

  // Only courses that develop the required skill can close this gap; anything
  // else is learning that leaves the evidenced level exactly where it was.
  const assignable: AssignableCourse[] = requirement && subject
    ? availableCourses(db, principal, db.courses)
        .filter((course) => course.status === "published" && course.skillId === requirement.skillId)
        .map((course) => ({
          id: course.id,
          code: course.code,
          title: course.title,
          targetLevel: course.targetLevel,
          evidenceRule: course.evidenceRule,
          passingScore: course.passingScore,
          validityMonths: course.validityMonths,
          activeEnrollment: db.enrollments.some((candidate) =>
            candidate.courseId === course.id &&
            candidate.subjectUserId === subject.id &&
            (candidate.status === "enrolled" || candidate.status === "in_progress")),
        }))
    : [];

  return (
    <div className="page fade-in">
      <div className="breadcrumbs">
        <Link href="/interventions">Interventions</Link><Icons.chevron /><span>{intervention.title}</span>
      </div>

      <PageHeader
        eyebrow={`${typeLabel[intervention.type]} intervention · ${statusLabel[intervention.status]}`}
        title={intervention.title}
        description={isLearning
          ? "A course fulfils this intervention: a passing completion emits the evidence that closes the gap."
          : "This intervention is not delivered as a course. The gap closes only when evidence is recorded separately against the required skill."}
      />

      <div className="detail-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">The gap this action addresses</p>
              <h2>{skill ? skill.name : "Gap case outside your scope"}</h2>
            </div>
            {gap && <Badge tone={priorityTone[gap.priority]}>{priorityLabel[gap.priority]} priority</Badge>}
          </div>

          {gap && requirement ? (
            <>
              <dl>
                <div className="definition-row"><dt>Subject</dt><dd>{subject?.displayName ?? gap.subjectUserId}</dd></div>
                <div className="definition-row">
                  <dt>Obligation</dt>
                  <dd>{sourceLabel[requirement.sourceType]} · {requirement.sourceReference}</dd>
                </div>
                <div className="definition-row"><dt>Criticality</dt><dd>{requirement.criticality} · requirement version {requirement.version}</dd></div>
                {jobRole && <div className="definition-row"><dt>Job role</dt><dd>{jobRole.title} ({jobRole.code})</dd></div>}
                <div className="definition-row"><dt>Gap status</dt><dd>{gap.status}</dd></div>
              </dl>

              <div className="stat-strip">
                <div><span>Required level</span><strong>{gap.requiredLevel}</strong></div>
                <div><span>Evidenced level</span><strong>{gap.evidencedLevel}</strong></div>
                <div><span>Remaining gap</span><strong>{gap.gap}</strong></div>
              </div>

              <p className="inline-note">Diagnosed cause: {gap.causeHypothesis}</p>
            </>
          ) : (
            <p className="inline-note">
              The gap case behind this intervention is outside your delegated scope, so the person it concerns, the
              obligation it derives from and its evidenced level are not shown here.
            </p>
          )}

          <h3>How this intervention closes the gap</h3>
          {isLearning ? (
            <>
              <p className="muted">
                Completion is recorded against an enrollment, and only the learning module may emit evidence from it.
                Assigning a course does not itself change the evidenced level.
              </p>
              {canAssign && requirement && subject ? (
                <AssignLearning
                  interventionId={intervention.id}
                  gapCaseId={intervention.gapCaseId}
                  subjectUserId={subject.id}
                  subjectName={subject.displayName}
                  skillName={skill?.name ?? "this skill"}
                  requiredLevel={gap?.requiredLevel ?? requirement.requiredLevel}
                  courses={assignable}
                  defaultDueDate={intervention.dueDate}
                  csrfToken={principal.session.csrfToken}
                />
              ) : (
                <p className="inline-note">
                  {subject
                    ? `You do not hold permission to enroll ${subject.displayName}, so learning must be assigned by their manager or a TNA analyst.`
                    : "Learning cannot be assigned from here because the gap case, and so its subject, is outside your delegated scope."}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="muted">
                A {typeLabel[intervention.type].toLowerCase()} intervention is delivered outside the course catalogue.
                There is no enrollment to progress and no completion that can emit evidence, so this record tracks the
                work being done, not the proof that it worked.
              </p>
              <p className="inline-note">
                {skill
                  ? `The gap closes only when new evidence against ${skill.name} is recorded separately — an observation, assessment, work product or credential. That evidence raises the evidenced level and the gap is recalculated from it.`
                  : "The gap closes only when new evidence against the required skill is recorded separately. That evidence raises the evidenced level and the gap is recalculated from it."}
              </p>
              <div className="panel-foot">
                <p><Icons.shield />Evidence remains the single authority on capability; completing this action does not assert it.</p>
                <Link href="/evidence">Open the evidence workspace</Link>
              </div>
            </>
          )}

          <h3>Assigned learning</h3>
          {enrollments.length === 0 ? (
            <p className="muted">
              {isLearning
                ? "No course has been assigned against this intervention yet, so nothing is being fulfilled."
                : "No enrollment is recorded against this intervention, which is expected for a non-training action."}
            </p>
          ) : (
            <div className="learning-list">
              {enrollments.map(({ enrollment, course, learner, evidence, progress }) => (
                <Fragment key={enrollment.id}>
                  <Link href={`/learning/${enrollment.id}`} className="learning-row">
                    <div className="learning-main">
                      <strong>{course ? course.title : enrollment.courseId}</strong>
                      <span className="learning-meta">
                        {course && <span>{course.code}</span>}
                        <span>{learner?.displayName ?? enrollment.subjectUserId}</span>
                        {enrollment.dueDate && <span>Due {enrollment.dueDate}</span>}
                        <span>Source: {enrollment.source}</span>
                      </span>
                    </div>
                    <div className="learning-progress">
                      <Progress value={progress.percent} label={`${course?.title ?? "Course"} progress`} />
                      <small>{progress.completed} of {progress.total} required modules</small>
                    </div>
                    <div className="learning-status">
                      <Badge tone={enrollmentStatusTone[enrollment.status]}>{enrollmentStatusLabel[enrollment.status]}</Badge>
                      <small>{evidence ? `Evidenced level ${evidence.proficiencyLevel}` : "No evidence emitted"}</small>
                    </div>
                    <Icons.chevron />
                  </Link>
                  {course && (
                    <p className="inline-note">{outcomeSentence(course, evidence, gap?.requiredLevel)}</p>
                  )}
                </Fragment>
              ))}
            </div>
          )}

          {study && (
            <div className="panel-foot">
              <p><Icons.info />Diagnosed in {study.title}.</p>
              <Link href={`/studies/${study.id}/gaps`}>Open the gap explorer</Link>
            </div>
          )}
        </section>

        <aside className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Intervention record</p>
              <h2>Delivery</h2>
            </div>
            <Badge tone={statusTone[intervention.status]}>{statusLabel[intervention.status]}</Badge>
          </div>
          <dl>
            <div className="definition-row"><dt>Type</dt><dd>{typeLabel[intervention.type]}</dd></div>
            <div className="definition-row"><dt>Owner</dt><dd>{owner?.displayName ?? "Unassigned"}</dd></div>
            <div className="definition-row"><dt>Due date</dt><dd>{intervention.dueDate}</dd></div>
            <div className="definition-row"><dt>Organizational unit</dt><dd>{orgUnit?.name ?? intervention.orgUnitId}</dd></div>
            <div className="definition-row"><dt>Gap case</dt><dd>{intervention.gapCaseId}</dd></div>
            <div className="definition-row"><dt>Record id</dt><dd>{intervention.id}</dd></div>
          </dl>
          <p className="inline-note">
            Status is set by the people doing the work. It is not a claim about competence: only verified evidence moves
            the evidenced level.
          </p>
        </aside>
      </div>
    </div>
  );
}
