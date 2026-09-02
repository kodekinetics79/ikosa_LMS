"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui";

export type PlayerModule = {
  id: string;
  position: number;
  title: string;
  kind: "lesson" | "document" | "video" | "scorm" | "assessment";
  durationMinutes: number;
  required: boolean;
  completed: boolean;
  score: number | null;
};

const kindLabels: Record<PlayerModule["kind"], string> = {
  lesson: "Lesson",
  document: "Document",
  video: "Video",
  scorm: "Simulation",
  assessment: "Assessment",
};

const withheldMessages: Record<string, string> = {
  not_complete: "Progress recorded. Remaining modules must be completed before this course can evidence competence.",
  attendance_only: "Attendance recorded. This course does not carry assessed evidence, so it does not change your competence record.",
  assessment_not_passed: "Recorded, but below the pass mark. No competence evidence was issued and the course remains open so you can retake the assessment.",
  already_complete: "This enrollment is already complete.",
};

export function CoursePlayer({
  enrollmentId,
  modules,
  csrfToken,
  passingScore,
  locked,
}: {
  enrollmentId: string;
  modules: PlayerModule[];
  csrfToken: string;
  passingScore: number;
  locked: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "info" | "danger"; text: string } | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});

  async function complete(module: PlayerModule) {
    setPendingId(module.id);
    setMessage(null);
    try {
      const raw = scores[module.id];
      const payload: { moduleId: string; score?: number } = { moduleId: module.id };
      if (module.kind === "assessment") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          setMessage({ tone: "danger", text: "Enter an assessment score between 0 and 100." });
          return;
        }
        payload.score = parsed / 100;
      }

      const response = await fetch(`/api/enrollments/${enrollmentId}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok) {
        setMessage({ tone: "danger", text: result.error ?? "That could not be recorded. Please try again." });
        return;
      }

      if (result.evidence) {
        setMessage({
          tone: "success",
          text: `Passed. Verified evidence issued at level ${result.evidence.proficiencyLevel} with confidence ${Math.round(result.evidence.strength * 100)}%${
            result.gapCasesRecalculated?.length ? `, and ${result.gapCasesRecalculated.length} gap case recalculated.` : "."
          }`,
        });
      } else {
        setMessage({
          tone: result.evidenceWithheldReason === "assessment_not_passed" ? "danger" : "info",
          text: withheldMessages[result.evidenceWithheldReason ?? ""] ?? "Progress recorded.",
        });
      }
      router.refresh();
    } catch {
      setMessage({ tone: "danger", text: "Progress could not be recorded right now. Please try again." });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="course-player">
      {message && (
        <p className={`player-message player-message--${message.tone}`} role="status">{message.text}</p>
      )}
      <ol className="module-list">
        {modules.map((module) => (
          <li key={module.id} className={module.completed ? "module module--done" : "module"}>
            <span className="module-index" aria-hidden="true">{module.completed ? "✓" : module.position}</span>
            <div className="module-body">
              <strong>{module.title}</strong>
              <span className="module-meta">
                <Badge tone={module.kind === "assessment" ? "info" : "neutral"}>{kindLabels[module.kind]}</Badge>
                <span>{module.durationMinutes} min</span>
                {!module.required && <span>Optional</span>}
                {module.completed && module.score !== null && <span>Scored {Math.round(module.score * 100)}%</span>}
              </span>
            </div>
            <div className="module-action">
              {module.kind === "assessment" && !locked && (
                <label className="score-input">
                  <span>Score %</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    inputMode="numeric"
                    value={scores[module.id] ?? ""}
                    onChange={(event) => setScores((current) => ({ ...current, [module.id]: event.target.value }))}
                    aria-describedby={`pass-${module.id}`}
                  />
                  <small id={`pass-${module.id}`}>Pass mark {Math.round(passingScore * 100)}%</small>
                </label>
              )}
              {locked ? (
                <span className="muted">Closed</span>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  disabled={pendingId === module.id}
                  onClick={() => complete(module)}
                >
                  {pendingId === module.id
                    ? "Recording…"
                    : module.kind === "assessment"
                      ? module.completed ? "Retake" : "Submit assessment"
                      : module.completed ? "Mark again" : "Mark complete"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
