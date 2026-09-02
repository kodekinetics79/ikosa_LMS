"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

export type AssignableCourse = {
  id: string;
  code: string;
  title: string;
  targetLevel: number;
  evidenceRule: "assessed" | "attendance_only";
  passingScore: number;
  validityMonths: number | null;
  /** The API refuses a second active enrollment, so say so before it is tried. */
  activeEnrollment: boolean;
};

/**
 * The junction control: it turns a diagnosed gap into assigned learning.
 *
 * Only the enrollment API may create the record, so this component states what
 * the chosen course can evidence and then reports back exactly what the API
 * decided. It never claims an outcome the server did not confirm.
 */
export function AssignLearning({
  interventionId,
  gapCaseId,
  subjectUserId,
  subjectName,
  skillName,
  requiredLevel,
  courses,
  defaultDueDate,
  csrfToken,
}: {
  interventionId: string;
  gapCaseId: string;
  subjectUserId: string;
  subjectName: string;
  skillName: string;
  requiredLevel: number;
  courses: AssignableCourse[];
  defaultDueDate: string | null;
  csrfToken: string;
}) {
  const router = useRouter();
  const noteId = useId();
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [dueDate, setDueDate] = useState(defaultDueDate ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState("");

  if (courses.length === 0) {
    return (
      <p className="inline-note">
        No published course in your scope develops {skillName}, so learning cannot fulfil this intervention yet. A course
        against this skill has to be published before an assignment could close the gap.
      </p>
    );
  }

  const selected = courses.find((course) => course.id === courseId);

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setConfirmed("");
    try {
      const response = await fetch("/api/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          courseId,
          subjectUserId,
          interventionId,
          gapCaseId,
          source: "intervention",
          ...(dueDate ? { dueDate } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      if (!response.ok) {
        // Report the server's own reason. A generic failure message would hide
        // exactly the refusals a manager needs to act on, such as an active
        // enrollment that already exists for this learner and course.
        const reasons = result.fields ? Object.values(result.fields) : [];
        setError(reasons.length > 0 ? reasons.join(" ") : result.error ?? "The assignment was refused.");
        return;
      }
      setConfirmed(`${selected?.code ?? "Course"} assigned to ${subjectName}. Nothing is evidenced until it is completed.`);
      router.refresh();
    } catch {
      setError("The assignment could not be sent. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="triage-actions" onSubmit={assign} aria-label={`Assign learning to ${subjectName}`}>
      <label>
        Course developing {skillName}
        <select
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          disabled={pending}
          aria-describedby={noteId}
        >
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.code} · {course.title}{course.activeEnrollment ? " (already enrolled)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label>
        Due date
        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          disabled={pending}
        />
      </label>

      <button type="submit" className="button primary" disabled={pending || !courseId}>
        {pending ? "Assigning…" : `Assign to ${subjectName}`}
      </button>

      <p className="inline-note" id={noteId}>
        {selected
          ? selected.evidenceRule === "assessed"
            ? `Passing ${selected.code} at ${Math.round(selected.passingScore * 100)}% or above issues verified evidence at level ${selected.targetLevel}${selected.validityMonths ? `, valid for ${selected.validityMonths} months` : ", with no expiry"}.${selected.targetLevel < requiredLevel ? ` The requirement is level ${requiredLevel}, so this course alone will not close the gap.` : ""}`
            : `${selected.code} records attendance only. Completing it emits no competence evidence and will not close this gap.`
          : "Select a course to see what completing it would evidence."}
      </p>

      {confirmed && <p className="inline-note" role="status">{confirmed}</p>}
      {error && <small className="field-error" role="alert">{error}</small>}
    </form>
  );
}
