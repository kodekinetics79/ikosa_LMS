"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type TriageStudyOption = { id: string; label: string };

/**
 * Records the triage decision for one signal.
 *
 * The outcome is chosen explicitly before any payload field appears, so the
 * screen offers no path that dismisses a change without stating why. The server
 * enforces the same rule; a refusal is surfaced verbatim here rather than
 * swallowed, because the whole point of the rule is that the person sees it.
 */
export function SignalTriage({ signalId, signalTitle, csrfToken, studies }: {
  signalId: string;
  signalTitle: string;
  csrfToken: string;
  studies: TriageStudyOption[];
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<"" | "link" | "dismiss">("");
  const [linkedStudyId, setLinkedStudyId] = useState(studies[0]?.id ?? "");
  const [dismissedReason, setDismissedReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (outcome === "") return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/signals/${encodeURIComponent(signalId)}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(outcome === "link" ? { outcome, linkedStudyId } : { outcome, dismissedReason }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        // Field-level messages carry the actual rule that was broken; the
        // generic envelope message on its own would hide it.
        const fields = result.fields && typeof result.fields === "object" ? Object.values(result.fields as Record<string, string>) : [];
        setError(fields.length ? fields.join(" ") : (result.error ?? "The triage decision could not be recorded."));
        return;
      }
      setOutcome("");
      setDismissedReason("");
      router.refresh();
    } catch {
      setError("The triage decision could not be recorded right now.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="triage-actions" role="group" aria-label={`Triage decision for ${signalTitle}`}>
        <label>
          Triage outcome
          <select
            value={outcome}
            disabled={pending}
            onChange={(event) => { setOutcome(event.target.value as "" | "link" | "dismiss"); setError(""); }}
          >
            <option value="">Choose an outcome…</option>
            <option value="link" disabled={studies.length === 0}>Link to a TNA study</option>
            <option value="dismiss">Dismiss with a stated reason</option>
          </select>
        </label>

        {outcome === "link" && <label>
          TNA study to link
          <select value={linkedStudyId} disabled={pending} onChange={(event) => setLinkedStudyId(event.target.value)}>
            {studies.map((study) => <option key={study.id} value={study.id}>{study.label}</option>)}
          </select>
        </label>}

        {outcome === "dismiss" && (
          <label>
            Reason for dismissal
            <textarea
              value={dismissedReason}
              disabled={pending}
              rows={2}
              maxLength={500}
              onChange={(event) => setDismissedReason(event.target.value)}
            />
          </label>
        )}

        <button type="button" className="button primary" onClick={submit} disabled={pending || outcome === ""}>
          {pending ? "Recording…" : "Record decision"}
        </button>
      </div>
      {studies.length === 0 && <p className="inline-note">No TNA study is readable in your scope, so this signal can only be dismissed with a reason until one exists.</p>}
      {outcome === "dismiss" && <p className="inline-note">A dismissal is kept on the record with its reason and your name. It is refused without one.</p>}
      {error && <small role="alert" className="field-error">{error}</small>}
    </div>
  );
}
