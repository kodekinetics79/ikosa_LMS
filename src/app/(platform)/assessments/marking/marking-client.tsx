"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarkingQueueItem } from "@/lib/server/assessment-list-store";
import type { AttemptScript, AttemptScriptItem } from "@/lib/server/assessment/marking";
import styles from "./marking.module.css";

type ApiProblem = { error?: string; fields?: Record<string, string> };
type Draft = { score: string; feedback: string };

type AttemptGroup = {
  attemptId: string;
  learnerName: string;
  learnerEmail: string;
  assessmentCode: string;
  assessmentTitle: string;
  submittedAt: string;
  pending: number;
};

function errorMessage(payload: ApiProblem, fallback: string): string {
  if (payload.error) return payload.error;
  if (payload.fields) return Object.values(payload.fields)[0] ?? fallback;
  return fallback;
}

function typeLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function when(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function points(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The learner's answer as text a marker can read.
 *
 * Responses are jsonb shaped by question type — `{value}`, `{values}`,
 * `{order}`, `{pairs}` — and dumping raw JSON at the person marking an essay
 * makes them decode a wire format before they can grade. Anything unrecognised
 * still falls back to formatted JSON rather than rendering as "[object Object]".
 */
function answerText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(answerText).filter(Boolean).join(", ");
  const record = value as Record<string, unknown>;
  if ("text" in record) return answerText(record.text);
  if ("value" in record) return answerText(record.value);
  if ("values" in record) return answerText(record.values);
  if ("order" in record) return answerText(record.order);
  if ("pairs" in record && record.pairs && typeof record.pairs === "object") {
    return Object.entries(record.pairs as Record<string, unknown>)
      .map(([left, right]) => `${left} → ${answerText(right)}`)
      .join("\n");
  }
  return Object.keys(record).length === 0 ? "" : JSON.stringify(record, null, 2);
}

function groupByAttempt(queue: MarkingQueueItem[]): AttemptGroup[] {
  const groups = new Map<string, AttemptGroup>();
  for (const item of queue) {
    const existing = groups.get(item.attemptId);
    if (existing) {
      existing.pending += 1;
      continue;
    }
    groups.set(item.attemptId, {
      attemptId: item.attemptId,
      learnerName: item.learnerName,
      learnerEmail: item.learnerEmail,
      assessmentCode: item.assessmentCode,
      assessmentTitle: item.assessmentTitle,
      submittedAt: item.submittedAt,
      pending: 1,
    });
  }
  // Oldest submission first: the queue is a waiting list, and a learner who
  // submitted first has been waiting longest for a result.
  return [...groups.values()].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export function MarkingClient({ queue, csrfToken }: { queue: MarkingQueueItem[]; csrfToken: string }) {
  const groups = useMemo(() => groupByAttempt(queue), [queue]);
  const [search, setSearch] = useState("");
  const [attemptId, setAttemptId] = useState<string | null>(groups[0]?.attemptId ?? null);
  const [script, setScript] = useState<AttemptScript | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [outstanding, setOutstanding] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups.filter((group) =>
      group.learnerName.toLowerCase().includes(term) || group.assessmentTitle.toLowerCase().includes(term));
  }, [groups, search]);

  /**
   * Reload the whole script rather than patch the item that was just saved.
   * Grading the last required item finalizes the attempt server-side — status,
   * score, percentage and pass flag all change in the same transaction — so
   * local state would be stale in exactly the moment that matters most.
   */
  const loadScript = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/assessment-marking?attemptId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json() as AttemptScript & ApiProblem;
      if (!response.ok) {
        setScript(null);
        setError(errorMessage(payload, "Could not load this attempt"));
        return;
      }
      setScript(payload);
      // The rail was rendered from the queue the server read before any of this
      // session's marks. Without this the last item of an attempt stays listed
      // as pending after it has been graded and the attempt has finalized.
      setOutstanding((current) => ({ ...current, [payload.attempt.id]: payload.awaitingMarking }));
      setDrafts(Object.fromEntries(payload.items
        .filter((item) => item.responseId)
        .map((item) => [item.responseId as string, {
          score: item.finalScore === null ? "" : String(item.finalScore),
          feedback: item.feedback,
        }])));
    } catch {
      setScript(null);
      setError("Could not reach the marking service");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!attemptId) {
      setScript(null);
      return;
    }
    void loadScript(attemptId);
  }, [attemptId, loadScript]);

  async function saveMark(item: AttemptScriptItem) {
    if (!item.responseId) return;
    const draft = drafts[item.responseId];
    const score = Number(draft?.score);
    if (!draft || draft.score.trim() === "" || !Number.isFinite(score)) {
      setError("Enter a score before saving");
      return;
    }
    if (score < 0 || score > item.maxPoints) {
      setError(`Score must be between 0 and ${points(item.maxPoints)}`);
      return;
    }
    setSaving(item.responseId);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/assessment-attempts", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "grade_response", responseId: item.responseId, score, feedback: draft.feedback }),
      });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) {
        setError(errorMessage(payload, "Could not save this mark"));
        return;
      }
      setNotice(`Question ${item.position} marked`);
      if (attemptId) await loadScript(attemptId);
    } catch {
      setError("Could not reach the marking service");
    } finally {
      setSaving(null);
    }
  }

  function setDraft(responseId: string, patch: Partial<Draft>) {
    setDrafts((current) => {
      // The defaults have to be a base the spreads build ON, not literals the
      // spreads overwrite — TS2783 flags the latter because the written value
      // is unreachable, and a reader cannot tell which one wins.
      const existing: Draft = current[responseId] ?? { score: "", feedback: "" };
      return { ...current, [responseId]: { ...existing, ...patch } };
    });
  }

  const provisionalPercent = script && script.totalPoints > 0
    ? Math.round((script.provisionalPoints / script.totalPoints) * 1000) / 10
    : 0;
  // Grading writes are refused once the attempt leaves 'submitted', so the
  // controls are disabled and explained rather than rendered as buttons that
  // would come back 404.
  const finalized = script !== null && script.attempt.status !== "submitted";

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <span className={styles.kicker}>Marking</span>
          <h1>Mark a script, not a fragment</h1>
          <p>
            Every attempt waiting on you, with the learner&apos;s whole paper in order: what the machine
            already scored, what still needs a human, and how many items stand between this attempt and a
            final result.
          </p>
        </div>
        <Link className={styles.ghostButton} href="/assessments">Back to assessments</Link>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.notice} role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className={styles.emptyPage}>
          <strong>Nothing is waiting to be marked</strong>
          <p>Every submitted response in your scope has a final score. New submissions appear here as they arrive.</p>
        </div>
      ) : (
        <div className={styles.layout}>
          <aside className={styles.rail}>
            <label className={styles.searchLabel} htmlFor="marking-search">Search</label>
            <input
              id="marking-search"
              className={styles.search}
              type="search"
              value={search}
              placeholder="Learner or assessment"
              onChange={(event) => setSearch(event.target.value)}
            />
            <p className={styles.railCount}>
              {visible.length} of {groups.length} attempt{groups.length === 1 ? "" : "s"}
            </p>
            {visible.length === 0 ? (
              <p className={styles.railEmpty}>No attempt matches “{search.trim()}”.</p>
            ) : (
              <ul className={styles.attemptList}>
                {visible.map((group) => {
                  const pending = outstanding[group.attemptId] ?? group.pending;
                  return (
                  <li key={group.attemptId}>
                    <button
                      type="button"
                      className={group.attemptId === attemptId ? styles.attemptItemActive : styles.attemptItem}
                      onClick={() => setAttemptId(group.attemptId)}
                    >
                      <strong>{group.learnerName}</strong>
                      <span>{group.assessmentCode} · {group.assessmentTitle}</span>
                      <small>{when(group.submittedAt)}</small>
                      <em>{pending === 0 ? "All items marked" : `${pending} item${pending === 1 ? "" : "s"} pending`}</em>
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className={styles.script}>
            {loading && !script ? <p className={styles.loading}>Loading script…</p> : null}
            {!loading && !script && !error ? <p className={styles.loading}>Select an attempt to mark.</p> : null}
            {script ? (
              <>
                <header className={styles.scriptHeader}>
                  <div>
                    <span className={styles.kicker}>{script.assessment.code}</span>
                    <h2>{script.assessment.title}</h2>
                    <p>
                      {script.learner.displayName} · {script.learner.email} · attempt {script.attempt.attemptNumber} ·
                      submitted {when(script.attempt.submittedAt)}
                    </p>
                  </div>
                  <div className={styles.totals}>
                    <article>
                      <span>Provisional</span>
                      <strong>{points(script.provisionalPoints)}/{points(script.totalPoints)}</strong>
                      <small>{provisionalPercent}% · pass at {script.assessment.passPercentage}%</small>
                    </article>
                    <article>
                      <span>Still to mark</span>
                      <strong>{script.awaitingMarking}</strong>
                      <small>
                        {script.awaitingMarking === 0
                          ? "Nothing blocking the result"
                          : `required item${script.awaitingMarking === 1 ? "" : "s"} before a final result`}
                      </small>
                    </article>
                    <article>
                      <span>Status</span>
                      <strong>{typeLabel(script.attempt.status)}</strong>
                      <small>
                        {script.attempt.percentage === null
                          ? "No final result yet"
                          : `${script.attempt.percentage}% · ${script.attempt.passed ? "passed" : "not passed"}`}
                      </small>
                    </article>
                  </div>
                </header>

                {finalized ? (
                  <p className={styles.banner}>
                    This attempt is finalized. Its marks are part of the learner&apos;s record and can no longer be
                    changed from this screen.
                  </p>
                ) : null}

                <ol className={styles.items}>
                  {script.items.map((item) => {
                    const answer = answerText(item.response);
                    const draft = item.responseId ? drafts[item.responseId] : undefined;
                    const markable = Boolean(item.responseId) && !item.autoScored && !finalized;
                    return (
                      <li key={item.questionId} className={styles.item}>
                        <div className={styles.itemMeta}>
                          <span className={styles.position}>Q{item.position}</span>
                          <span className={styles.tag}>{typeLabel(item.questionType)}</span>
                          <span className={item.required ? styles.tagRequired : styles.tag}>
                            {item.required ? "Required" : "Optional"}
                          </span>
                          <span className={item.autoScored ? styles.tagAuto : styles.tagManual}>
                            {item.autoScored ? "Auto-scored" : "Human marked"}
                          </span>
                          <span className={styles.tagPoints}>
                            {item.finalScore === null ? "—" : points(item.finalScore)} / {points(item.maxPoints)}
                          </span>
                        </div>
                        <h3>{item.prompt}</h3>

                        <div className={styles.responseBox}>
                          <span>Learner response</span>
                          {item.responseId === null ? (
                            <p className={styles.muted}>No response recorded — the learner did not answer this item.</p>
                          ) : answer ? (
                            <p>{answer}</p>
                          ) : (
                            <p className={styles.muted}>Answered, but the response is empty.</p>
                          )}
                        </div>

                        {item.rationale ? (
                          <div className={styles.rationale}>
                            <span>Marker guidance</span>
                            <p>{item.rationale}</p>
                          </div>
                        ) : null}

                        {item.autoScored ? (
                          <p className={styles.note}>
                            Scored automatically on submission at {points(item.finalScore ?? 0)} of {points(item.maxPoints)}.
                          </p>
                        ) : item.responseId === null ? (
                          <p className={styles.note}>
                            There is no response to attach a mark to, so this item cannot be scored or commented on
                            here. It counts as zero of {points(item.maxPoints)} in the total above.
                          </p>
                        ) : markable ? (
                          <div className={styles.gradePanel}>
                            <label>
                              Score <span>max {points(item.maxPoints)}</span>
                              <input
                                type="number"
                                min={0}
                                max={item.maxPoints}
                                step="0.01"
                                value={draft?.score ?? ""}
                                onChange={(event) => setDraft(item.responseId as string, { score: event.target.value })}
                              />
                            </label>
                            <label>
                              Feedback to the learner
                              <textarea
                                rows={3}
                                value={draft?.feedback ?? ""}
                                onChange={(event) => setDraft(item.responseId as string, { feedback: event.target.value })}
                              />
                            </label>
                            <button
                              type="button"
                              className={styles.primaryButton}
                              disabled={saving === item.responseId}
                              onClick={() => void saveMark(item)}
                            >
                              {saving === item.responseId ? "Saving…" : item.finalScore === null ? "Save mark" : "Update mark"}
                            </button>
                          </div>
                        ) : (
                          <p className={styles.note}>
                            Marked at {points(item.finalScore ?? 0)} of {points(item.maxPoints)}.
                            {item.feedback ? ` Feedback: ${item.feedback}` : ""}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
