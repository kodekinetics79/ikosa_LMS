"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Verification controls for one evidence record.
 *
 * Rendered only for a viewer who actually holds `evidence:verify` on that row,
 * so the interface never offers a decision the server will refuse. The server
 * re-checks every rule regardless - this component is a convenience, not the
 * control.
 *
 * A revocation always carries a reason. The reason is written to the audit
 * ledger rather than onto the record, because Evidence has no field for it and
 * inventing one here would put an unverifiable string beside a capability
 * claim.
 */

export type EvidenceReviewProps = {
  evidenceId: string;
  /** Named in every control label, so a screen-reader user can tell rows apart. */
  subjectName: string;
  skillName: string;
  status: "pending" | "verified" | "revoked";
  csrfToken: string;
};

export function EvidenceReview({ evidenceId, subjectName, skillName, status, csrfToken }: EvidenceReviewProps) {
  const router = useRouter();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // Deterministic and unique per row, so the label/control pair survives
  // re-render and two rows never collide on one id.
  const reasonId = `revoke-reason-${evidenceId}`;
  const describes = `${skillName} evidence for ${subjectName}`;

  async function decide(decision: "verified" | "revoked") {
    setPending(true);
    setError("");
    setDone("");
    try {
      const response = await fetch(`/api/evidence/${encodeURIComponent(evidenceId)}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(decision === "revoked" ? { decision, reason } : { decision }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Field-level messages carry the precise refusal, including the
        // separation-of-duties rule; show it rather than a generic failure.
        const fields = result.fields ? Object.values(result.fields as Record<string, string>).join(" ") : "";
        setError(fields || result.error || "That decision could not be recorded.");
        return;
      }
      const recalculated = Array.isArray(result.gapCasesRecalculated) ? result.gapCasesRecalculated.length : 0;
      setDone(
        `${decision === "verified" ? "Verified" : "Revoked"}: ${describes}.` +
          (recalculated > 0 ? ` ${recalculated} gap ${recalculated === 1 ? "case" : "cases"} recalculated.` : ""),
      );
      setRevoking(false);
      setReason("");
      router.refresh();
    } catch {
      setError("That decision could not be recorded right now. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      {!revoking && (
        <>
          {status === "pending" && (
            <button
              type="button"
              className="button primary"
              disabled={pending}
              aria-label={`Verify ${describes}`}
              onClick={() => decide("verified")}
            >
              {pending ? "Recording…" : "Verify"}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            disabled={pending}
            aria-label={`Revoke ${describes}`}
            onClick={() => {
              setRevoking(true);
              setError("");
              setDone("");
            }}
          >
            Revoke
          </button>
        </>
      )}

      {revoking && (
        <>
          <label className="table-search" htmlFor={reasonId}>
            Reason
            <input
              id={reasonId}
              type="text"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-label={`Reason for revoking ${describes}`}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={pending || reason.trim().length === 0}
            aria-label={`Confirm revocation of ${describes}`}
            onClick={() => decide("revoked")}
          >
            {pending ? "Recording…" : "Confirm revocation"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={pending}
            aria-label={`Cancel revoking ${describes}`}
            onClick={() => {
              setRevoking(false);
              setReason("");
              setError("");
            }}
          >
            Cancel
          </button>
          <span className="muted">A reason is required and is written to the audit ledger.</span>
        </>
      )}

      {error && <small role="alert" className="field-error">{error}</small>}
      {done && <small role="status" className="muted">{done}</small>}
    </div>
  );
}
