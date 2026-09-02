import { Badge, PageHeader } from "@/components/ui";
import { EnrollButton } from "@/components/enroll-button";
import { authorize, principalFromCookies } from "@/lib/server/auth";
import { availableCourses } from "@/lib/server/domain-service";
import { modulesForCourse } from "@/lib/server/learning";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Course catalogue" };

export default async function Catalog() {
  const principal = await principalFromCookies();
  const db = await readDatabase();

  authorize(principal, "course:read", { tenantId: principal.tenantId });
  const courses = availableCourses(db, principal, db.courses).filter((course) => course.status === "published");

  const cards = courses.map((course) => {
    const modules = modulesForCourse(db, course.id);
    const skill = db.skills.find((candidate) => candidate.id === course.skillId);
    const activeEnrollment = db.enrollments.some((candidate) =>
      candidate.courseId === course.id &&
      candidate.subjectUserId === principal.user.id &&
      (candidate.status === "enrolled" || candidate.status === "in_progress"));
    return {
      course,
      skill,
      activeEnrollment,
      moduleCount: modules.length,
      minutes: modules.reduce((total, module) => total + module.durationMinutes, 0),
      hasAssessment: modules.some((module) => module.kind === "assessment"),
    };
  });

  return (
    <div className="page fade-in">
      <PageHeader
        eyebrow="Learning"
        title="Course catalogue"
        description="Published courses in your scope, and exactly what each one can evidence."
      />

      {cards.length === 0 ? (
        <section className="panel"><p className="muted">No published courses are available in your scope.</p></section>
      ) : (
        <section className="catalog-grid">
          {cards.map(({ course, skill, activeEnrollment, moduleCount, minutes, hasAssessment }) => (
            <article key={course.id} className="panel catalog-card">
              <div className="catalog-head">
                <span className="course-code">{course.code}</span>
                <Badge tone={course.evidenceRule === "assessed" ? "success" : "neutral"}>
                  {course.evidenceRule === "assessed" ? `Evidences level ${course.targetLevel}` : "Attendance only"}
                </Badge>
              </div>
              <h2>{course.title}</h2>
              <p>{course.description}</p>
              <dl className="fact-list">
                <div><dt>Develops</dt><dd>{skill?.name ?? course.skillId}</dd></div>
                <div><dt>Content</dt><dd>{moduleCount} modules · {minutes} min</dd></div>
                <div><dt>Assessment</dt><dd>{hasAssessment ? `Pass mark ${Math.round(course.passingScore * 100)}%` : "None"}</dd></div>
                <div><dt>Validity</dt><dd>{course.validityMonths ? `${course.validityMonths} months` : "No expiry"}</dd></div>
              </dl>
              {course.evidenceRule === "attendance_only" && (
                <p className="muted">Completion is recorded but issues no competence evidence.</p>
              )}
              <div className="catalog-action">
                <EnrollButton courseId={course.id} csrfToken={principal.session.csrfToken} alreadyActive={activeEnrollment} />
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
