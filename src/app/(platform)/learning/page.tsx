import Link from "next/link";
import { Badge, PageHeader, Progress } from "@/components/ui";
import { Icons } from "@/components/icons";
import { principalFromCookies } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { courseProgress } from "@/lib/server/learning";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "My learning" };

const statusTone = { enrolled: "neutral", in_progress: "info", completed: "success", withdrawn: "neutral" } as const;
const statusLabel = { enrolled: "Not started", in_progress: "In progress", completed: "Completed", withdrawn: "Withdrawn" } as const;

export default async function MyLearning() {
  const principal = await principalFromCookies();
  const db = await readDatabase();

  const enrollments = visibleRows(db, principal, "enrollment:read", db.enrollments);
  const rows = enrollments
    .map((enrollment) => {
      const course = db.courses.find((candidate) => candidate.id === enrollment.courseId);
      const subject = db.users.find((candidate) => candidate.id === enrollment.subjectUserId);
      const evidence = enrollment.evidenceId ? db.evidence.find((candidate) => candidate.id === enrollment.evidenceId) : undefined;
      return { enrollment, course, subject, evidence, progress: courseProgress(db, enrollment) };
    })
    .filter((row) => row.course)
    .sort((a, b) => Number(a.enrollment.status === "completed") - Number(b.enrollment.status === "completed"));

  const own = rows.filter((row) => row.enrollment.subjectUserId === principal.user.id);
  const others = rows.filter((row) => row.enrollment.subjectUserId !== principal.user.id);

  return (
    <div className="page fade-in">
      <PageHeader
        eyebrow="Learning"
        title="My learning"
        description="Courses assigned to close a verified capability gap, and what each one will evidence."
        actions={<Link className="button primary" href="/catalog">Browse catalogue</Link>}
      />

      {rows.length === 0 ? (
        <section className="panel">
          <p className="muted">No learning is assigned in your scope. Assign a course from the catalogue to fulfil an intervention.</p>
        </section>
      ) : null}

      {own.length > 0 && <EnrollmentTable heading="Assigned to you" rows={own} showSubject={false} />}
      {others.length > 0 && <EnrollmentTable heading="Your team" rows={others} showSubject />}
    </div>
  );
}

type Row = {
  enrollment: import("@/lib/server/domain").Enrollment;
  course?: import("@/lib/server/domain").Course;
  subject?: import("@/lib/server/domain").PublicUser;
  evidence?: import("@/lib/server/domain").Evidence;
  progress: { completed: number; total: number; percent: number };
};

function EnrollmentTable({ heading, rows, showSubject }: { heading: string; rows: Row[]; showSubject: boolean }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div><p className="eyebrow">Learning register</p><h2>{heading}</h2></div>
        <span className="count-badge">{rows.length}</span>
      </div>
      <div className="learning-list">
        {rows.map(({ enrollment, course, subject, evidence, progress }) => (
          <Link key={enrollment.id} href={`/learning/${enrollment.id}`} className="learning-row">
            <div className="learning-main">
              <strong>{course!.title}</strong>
              <span className="learning-meta">
                <span>{course!.code}</span>
                {showSubject && subject && <span>{subject.displayName}</span>}
                {enrollment.dueDate && <span>Due {enrollment.dueDate}</span>}
                {enrollment.source === "intervention" && <Badge tone="info">Fulfils an intervention</Badge>}
              </span>
            </div>
            <div className="learning-progress">
              <Progress value={progress.percent} label={`${course!.title} progress`} />
              <small>{progress.completed} of {progress.total} required modules</small>
            </div>
            <div className="learning-status">
              <Badge tone={statusTone[enrollment.status]}>{statusLabel[enrollment.status]}</Badge>
              {evidence ? (
                <small>Evidenced level {evidence.proficiencyLevel}</small>
              ) : course!.evidenceRule === "attendance_only" ? (
                <small>Attendance only</small>
              ) : (
                <small>Evidences level {course!.targetLevel}</small>
              )}
            </div>
            <Icons.chevron />
          </Link>
        ))}
      </div>
    </section>
  );
}
