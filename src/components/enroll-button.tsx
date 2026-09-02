"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EnrollButton({ courseId, csrfToken, alreadyActive }: { courseId: string; csrfToken: string; alreadyActive: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (alreadyActive) return <span className="muted">Already enrolled</span>;

  async function enroll() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ courseId, source: "self" }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setError(result.error ?? "Enrollment failed.");
        return;
      }
      router.push("/learning");
      router.refresh();
    } catch {
      setError("Enrollment could not be completed right now.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="button primary" onClick={enroll} disabled={pending}>
        {pending ? "Enrolling…" : "Enroll"}
      </button>
      {error && <small role="alert" className="field-error">{error}</small>}
    </>
  );
}
