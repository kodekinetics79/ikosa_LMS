import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader, Progress } from "@/components/ui";
import { Icons } from "@/components/icons";
import { CoursePlayer, type PlayerModule } from "@/components/course-player";
import { principalFromCookies } from "@/lib/server/auth";
import { assertScoped } from "@/lib/server/domain-service";
import { courseProgress, modulesForCourse } from "@/lib/server/learning";
import { readDatabase } from "@/lib/server/store";

export default async function CourseDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await principalFromCookies();
  const db = await readDatabase();

  const enrollment = db.enrollments.find((candidate) => candidate.id === id && candidate.tenantId === principal.tenantId);
  if (!enrollment) notFound();

  // Authorize the specific record, not merely the route. A learner reaching
  // another person's enrollment id directly must be refused here.
  try {
    assertScoped(db, principal, "enrollment:read", enrollment);
  } catch {
    notFound();
  }

  const course = db.courses.find((candidate) => candidate.id === enrollment.courseId);
  if (!course) notFound();

  const skill = db.skills.find((candidate) => candidate.id === course.skillId);
  const subject = db.users.find((candidate) => candidate.id === enrollment.subjectUserId);
  const evidence = enrollment.evidenceId ? db.evidence.find((candidate) => candidate.id === enrollment.evidenceId) : undefined;
  const intervention = enrollment.interventionId ? db.interventions.find((candidate) => candidate.id === enrollment.interventionId) : undefined;
  const gap = enrollment.gapCaseId ? db.gapCases.find((candidate) => candidate.id === enrollment.gapCaseId) : undefined;
  const completions = db.moduleCompletions.filter((candidate) => candidate.enrollmentId === enrollment.id);
  const progress = courseProgress(db, enrollment);

  const modules: PlayerModule[] = modulesForCourse(db, course.id).map((module) => {
    const completion = completions.find((candidate) => candidate.moduleId === module.id);
    return {
      id: module.id,
      position: module.position,
      title: module.title,
      kind: module.kind,
      durationMinutes: module.durationMinutes,
      required: module.required,
      completed: Boolean(completion),
      score: completion?.score ?? null,
    };
  });

  // Only the subject records their own progress; a manager viewing a team
  // member's record sees it read-only.
  const canRecord = enrollment.subjectUserId === principal.user.id && enrollment.status !== "completed" && enrollment.status !== "withdrawn";

  return (
    <div className="page fade-in">
      <div className="breadcrumbs">
        <Link href="/learning">My learning</Link><Icons.chevron /><span>{course.code}</span>
      </div>

      <PageHeader
        eyebrow={`${course.code} · version ${course.version}`}
        title={course.title}
        description={course.description}
      />

      <div className="study-status">
        <div><span>Develops</span><strong>{skill?.name ?? course.skillId}</strong></div>
        <div><span>Evidences</span><strong>{course.evidenceRule === "assessed" ? `Level ${course.targetLevel} on passing` : "Attendance only"}</strong></div>
        <div><span>Pass mark</span><strong>{course.evidenceRule === "assessed" ? `${Math.round(course.passingScore * 100)}%` : "Not assessed"}</strong></div>
        <div><span>Valid for</span><strong>{course.validityMonths ? `${course.validityMonths} months` : "No expiry"}</strong></div>
      </div>

      <div className="study-detail-grid">
        <section>
          <article className="panel">
            <div className="panel-header">
              <div><p className="eyebrow">Course content</p><h2>Modules</h2></div>
              <span>{progress.completed} of {progress.total} required</span>
            </div>
            <Progress value={progress.percent} label={`${course.title} progress`} />
            {canRecord ? (
              <CoursePlayer
                enrollmentId={enrollment.id}
                modules={modules}
                csrfToken={principal.session.csrfToken}
                passingScore={course.passingScore}
                locked={false}
              />
            ) : (
              <CoursePlayer
                enrollmentId={enrollment.id}
                modules={modules}
                csrfToken={principal.session.csrfToken}
                passingScore={course.passingScore}
                locked
              />
            )}
            {!canRecord && enrollment.subjectUserId !== principal.user.id && (
              <p className="muted">You are viewing {subject?.displayName ?? "another learner"}&rsquo;s record. Only the learner can record their own progress.</p>
            )}
          </article>
        </section>

        <aside>
          <article className="panel">
            <p className="eyebrow">Assurance outcome</p>
            {evidence ? (
              <>
                <h3>Competence evidenced</h3>
                <dl className="fact-list">
                  <div><dt>Level</dt><dd>{evidence.proficiencyLevel}</dd></div>
                  <div><dt>Confidence</dt><dd>{Math.round(evidence.strength * 100)}%</dd></div>
                  <div><dt>Status</dt><dd>{evidence.status}</dd></div>
                  <div><dt>Expires</dt><dd>{evidence.expiresAt ? new Date(evidence.expiresAt).toLocaleDateString() : "No expiry"}</dd></div>
                </dl>
                <p className="muted">Source: {evidence.sourceReference}</p>
              </>
            ) : course.evidenceRule === "attendance_only" ? (
              <>
                <h3>No competence evidence</h3>
                <p className="muted">This course records attendance. Attending a briefing is not proof that the work can be performed, so completion will not change a readiness figure.</p>
              </>
            ) : (
              <>
                <h3>Not yet evidenced</h3>
                <p className="muted">
                  Passing the assessment at {Math.round(course.passingScore * 100)}% or above issues verified evidence at level {course.targetLevel}
                  {course.validityMonths ? `, valid for ${course.validityMonths} months` : ""}.
                </p>
              </>
            )}
          </article>

          {(intervention || gap) && (
            <article className="panel">
              <p className="eyebrow">Why this was assigned</p>
              {intervention && (
                <>
                  <h3>{intervention.title}</h3>
                  <p className="muted">Intervention status: {intervention.status}{intervention.dueDate ? ` · due ${intervention.dueDate}` : ""}</p>
                </>
              )}
              {gap && (
                <>
                  <div className="mini-meta">
                    <Badge tone={gap.priority === "critical" ? "danger" : gap.priority === "high" ? "warning" : "neutral"}>{gap.priority} gap</Badge>
                    <span>Required level {gap.requiredLevel} · evidenced {gap.evidencedLevel}</span>
                  </div>
                  <Link href={`/studies/${gap.tnaStudyId}/gaps`}>Open the gap case <Icons.chevron /></Link>
                </>
              )}
            </article>
          )}
        </aside>
      </div>
    </div>
  );
}
