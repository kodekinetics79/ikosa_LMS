"use client";

/**
 * The assessment builder.
 *
 * Every control here reaches an endpoint that does the thing it says. Nothing
 * is shown that is not wired: a setting the server does not honour is worse
 * than a setting that is absent, because the author believes they configured
 * something.
 *
 * The screen refetches the assessment after every mutation rather than patching
 * local state optimistically. The workspace grid does the latter and its
 * `itemCount` and `pendingMarking` drift from the server until a page reload —
 * for a builder, where position, points and readiness are all derived
 * server-side, showing a stale answer would be worse than a moment's latency.
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AssessmentDetail } from "@/lib/server/assessment/authoring";
import type { AuthorQuestionSummary } from "@/lib/server/assessment-list-store";
import styles from "./builder.module.css";

type Props = {
  detail: AssessmentDetail;
  questions: AuthorQuestionSummary[];
  csrfToken: string;
};

type Problem = { error?: string; fields?: Record<string, string> };

const TYPE_LABELS: Record<string, string> = {
  single_choice: "Single choice", multiple_choice: "Multiple choice", true_false: "True / false",
  short_text: "Short text", long_text: "Written response", numeric: "Numeric",
  matching: "Matching", ordering: "Ordering",
};

function problemText(payload: Problem, fallback: string): string {
  if (payload.fields) {
    const first = Object.values(payload.fields)[0];
    if (first) return first;
  }
  return payload.error ?? fallback;
}

export function AssessmentBuilderClient({ detail: initial, questions, csrfToken }: Props) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [bankFilter, setBankFilter] = useState("all");
  const [settings, setSettings] = useState(() => formValues(initial));

  const assessment = detail.assessment;
  const isDraft = assessment.status === "draft";
  const attachedIds = useMemo(() => new Set(detail.items.map((item) => item.questionId)), [detail.items]);

  /** Reloads the assessment from the server. Position, points and readiness are all derived there. */
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/assessments/${assessment.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as AssessmentDetail;
    setDetail(next);
    setSettings(formValues(next));
    // The workspace list shows itemCount and status, both of which just changed.
    router.refresh();
  }, [assessment.id, router]);

  const send = useCallback(async (
    label: string,
    request: { url: string; method: "POST" | "PATCH"; body: Record<string, unknown> },
    successMessage: string,
  ): Promise<boolean> => {
    setBusy(label); setError(""); setSaved("");
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(request.body),
      });
      const payload = await response.json().catch(() => ({})) as Problem;
      if (!response.ok) { setError(problemText(payload, "That change could not be saved.")); return false; }
      await refresh();
      setSaved(successMessage);
      return true;
    } catch {
      setError("The server could not be reached. Your change was not saved.");
      return false;
    } finally { setBusy(null); }
  }, [csrfToken, refresh]);

  const patchAssessment = (label: string, body: Record<string, unknown>, message: string) =>
    send(label, { url: "/api/assessments", method: "PATCH", body: { assessmentId: assessment.id, ...body } }, message);

  /**
   * Approving here is the same endpoint the library uses, so an AI-generated
   * question — which the store always forces to `draft` — has a route to
   * publication that a human has to walk.
   */
  const reviewQuestion = (questionId: string, reviewStatus: "approved" | "rejected") =>
    send("review", { url: "/api/assessment-questions", method: "PATCH", body: { action: "review", questionId, reviewStatus } },
      reviewStatus === "approved" ? "Question approved." : "Question rejected.");

  function move(index: number, direction: -1 | 1) {
    const order = detail.items.map((item) => item.questionId);
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    void patchAssessment("reorder", { action: "reorder_questions", questionIds: order }, "Question order saved.");
  }

  const availableQuestions = questions.filter((question) => {
    if (attachedIds.has(question.id)) return false;
    if (bankFilter !== "all" && question.bankId !== bankFilter) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return question.prompt.toLowerCase().includes(needle) || question.bankName.toLowerCase().includes(needle);
  });

  const banks = useMemo(() => {
    const seen = new Map<string, string>();
    for (const question of questions) if (!seen.has(question.bankId)) seen.set(question.bankId, question.bankName);
    return [...seen.entries()];
  }, [questions]);

  const statusChip = assessment.status === "published" ? styles.chipLive : assessment.status === "retired" ? styles.chipRetired : styles.chipDraft;

  return (
    <div className={styles.page}>
      <Link href="/assessments" className={styles.back}>← All assessments</Link>

      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.code}>{assessment.code}</span>
          <h1>{assessment.title}</h1>
          {assessment.description ? <p>{assessment.description}</p> : null}
          <div className={styles.chips}>
            <span className={`${styles.chip} ${statusChip}`}>{assessment.status}</span>
            <span className={styles.chip}>{assessment.assessmentType}</span>
            <span className={styles.chip}>{assessment.durationMinutes ? `${assessment.durationMinutes} min` : "Untimed"}</span>
            <span className={styles.chip}>Pass {assessment.passPercentage}%</span>
            <span className={styles.chip}>{assessment.attemptLimit} attempt{assessment.attemptLimit === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div className={styles.headActions}>
          {assessment.status === "draft" ? (
            <button
              type="button" className={styles.primary}
              disabled={busy !== null || detail.publishBlockers.length > 0}
              title={detail.publishBlockers.length > 0 ? "Resolve the readiness checks first" : undefined}
              onClick={() => patchAssessment("publish", { action: "publish" }, "Published. Learners in scope can now start it.")}
            >
              {busy === "publish" ? "Publishing…" : "Publish"}
            </button>
          ) : null}
          {assessment.status === "published" ? (
            <button type="button" className={styles.secondary} disabled={busy !== null}
              onClick={() => patchAssessment("unpublish", { action: "unpublish" }, "Returned to draft.")}>
              {busy === "unpublish" ? "Working…" : "Return to draft"}
            </button>
          ) : null}
          {assessment.status !== "retired" ? (
            <button type="button" className={styles.danger} disabled={busy !== null}
              onClick={() => { if (window.confirm("Retire this assessment? Learners will no longer be able to start it.")) void patchAssessment("retire", { action: "retire" }, "Retired."); }}>
              Retire
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button></div> : null}
      {saved ? <div className={styles.saved} role="status"><span>{saved}</span><button type="button" aria-label="Dismiss" onClick={() => setSaved("")}>×</button></div> : null}

      <div className={styles.grid}>
        <div>
          {/* ---- questions ---- */}
          <section className={styles.panel} aria-labelledby="builder-questions">
            <div className={styles.panelHead}>
              <div>
                <h2 id="builder-questions">Questions</h2>
                <p>{detail.items.length} item{detail.items.length === 1 ? "" : "s"} · {detail.totalPoints} points · {detail.requiredPoints} required</p>
              </div>
            </div>
            <div className={styles.panelBody}>
              {detail.items.length === 0 ? (
                <div className={styles.empty}>
                  <strong>No questions yet</strong>
                  Attach approved questions from your library to build this assessment.
                </div>
              ) : (
                <ol className={styles.items}>
                  {detail.items.map((item, index) => (
                    <li key={item.questionId} className={styles.item}>
                      <span className={styles.pos} aria-hidden="true">{item.position}</span>
                      <div className={styles.itemMain}>
                        <div className={styles.itemMeta}>
                          <span>{TYPE_LABELS[item.questionType] ?? item.questionType}</span>
                          <span className={item.autoScored ? styles.auto : styles.manual}>
                            {item.autoScored ? "Auto-scored" : "Human marking"}
                          </span>
                          <span>{item.bankCode}</span>
                          {item.reviewStatus !== "approved" ? <span className={styles.unapproved}>{item.reviewStatus}</span> : null}
                          {!item.required ? <span>Optional</span> : null}
                        </div>
                        <p>{item.prompt}</p>
                      </div>
                      <div className={styles.itemControls}>
                        <div className={styles.controlRow}>
                          <button type="button" className={styles.move} disabled={!isDraft || index === 0 || busy !== null}
                            aria-label={`Move question ${item.position} earlier`} onClick={() => move(index, -1)}>↑</button>
                          <button type="button" className={styles.move} disabled={!isDraft || index === detail.items.length - 1 || busy !== null}
                            aria-label={`Move question ${item.position} later`} onClick={() => move(index, 1)}>↓</button>
                        </div>
                        <div className={styles.controlRow}>
                          <label htmlFor={`points-${item.questionId}`}>Points</label>
                          <input
                            id={`points-${item.questionId}`} className={styles.points} type="number" min="0.25" step="0.25"
                            defaultValue={item.effectivePoints} disabled={!isDraft || busy !== null}
                            aria-label={`Points for question ${item.position}. The question is worth ${item.questionPoints} in its bank.`}
                            onBlur={(event) => {
                              const value = Number(event.target.value);
                              if (!Number.isFinite(value) || value === item.effectivePoints) return;
                              // null clears the override back to the bank value.
                              void patchAssessment("points", {
                                action: "set_item", questionId: item.questionId,
                                pointsOverride: value === item.questionPoints ? null : value,
                              }, "Points updated.");
                            }}
                          />
                        </div>
                        <label className={styles.toggle}>
                          <input type="checkbox" checked={item.required} disabled={!isDraft || busy !== null}
                            onChange={(event) => void patchAssessment("required", { action: "set_item", questionId: item.questionId, required: event.target.checked }, "Requirement updated.")} />
                          Required
                        </label>
                        {/* The publish checklist reports unapproved questions
                            as a blocker. Without the approval control here that
                            blocker is unresolvable from the only screen that
                            reports it — the author would be told what is wrong
                            and given no way to fix it. */}
                        {item.reviewStatus !== "approved" ? (
                          <div className={styles.review}>
                            <button type="button" className={`${styles.secondary} ${styles.tiny}`} disabled={busy !== null}
                              onClick={() => void reviewQuestion(item.questionId, "approved")}>
                              Approve
                            </button>
                            <button type="button" className={`${styles.ghost} ${styles.tiny}`} disabled={busy !== null}
                              onClick={() => void reviewQuestion(item.questionId, "rejected")}>
                              Reject
                            </button>
                          </div>
                        ) : null}
                        <button type="button" className={`${styles.ghost} ${styles.tiny}`} disabled={!isDraft || busy !== null}
                          onClick={() => void patchAssessment("detach", { action: "detach_question", questionId: item.questionId }, "Question removed.")}>
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          {/* ---- add from library ---- */}
          {isDraft ? (
            <section className={styles.panel} style={{ marginTop: 16 }} aria-labelledby="builder-library">
              <div className={styles.panelHead}>
                <div>
                  <h2 id="builder-library">Add from your library</h2>
                  <p>{availableQuestions.length} question{availableQuestions.length === 1 ? "" : "s"} available</p>
                </div>
              </div>
              <div className={styles.panelBody}>
                <div className={styles.tools}>
                  <input type="search" value={search} placeholder="Search prompts and banks…" aria-label="Search questions"
                    onChange={(event) => setSearch(event.target.value)} />
                  <select value={bankFilter} aria-label="Filter by bank" onChange={(event) => setBankFilter(event.target.value)}>
                    <option value="all">All banks</option>
                    {banks.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                </div>
                {availableQuestions.length === 0 ? (
                  <div className={styles.empty}>
                    <strong>Nothing to add</strong>
                    {questions.length === 0
                      ? "Create questions in the library first."
                      : "Every matching question is already on this assessment, or no question matches your filters."}
                  </div>
                ) : (
                  <ul className={styles.available}>
                    {availableQuestions.slice(0, 50).map((question) => (
                      <li key={question.id}>
                        <div>
                          <strong>{question.prompt}</strong>
                          <span>{TYPE_LABELS[question.questionType] ?? question.questionType} · {question.points} pts · {question.bankName} · {question.reviewStatus}</span>
                        </div>
                        <button type="button" className={`${styles.secondary} ${styles.tiny}`} disabled={busy !== null}
                          onClick={() => void patchAssessment("attach", { action: "attach_question", questionId: question.id }, "Question added.")}>
                          Add
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : null}
        </div>

        {/* ---- sidebar ---- */}
        <div>
          <section className={styles.panel} aria-labelledby="builder-readiness">
            <div className={styles.panelHead}><div><h2 id="builder-readiness">Publish readiness</h2></div></div>
            <div className={styles.panelBody}>
              {detail.publishBlockers.length === 0 ? (
                <p className={styles.ready}>Ready to publish.</p>
              ) : (
                <ul className={styles.blockers}>
                  {detail.publishBlockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
                </ul>
              )}
              <div className={styles.stats} style={{ marginTop: 14 }}>
                <div><strong>{detail.totalPoints}</strong><span>Total points</span></div>
                <div><strong>{detail.manuallyMarkedItems}</strong><span>Human marked</span></div>
                <div><strong>{detail.attemptCount}</strong><span>Attempts</span></div>
              </div>
              {detail.pendingMarking > 0 ? (
                <p className={styles.hint}>{detail.pendingMarking} attempt{detail.pendingMarking === 1 ? " is" : "s are"} waiting in the marking queue.</p>
              ) : null}
            </div>
          </section>

          <section className={styles.panel} style={{ marginTop: 16 }} aria-labelledby="builder-settings">
            <div className={styles.panelHead}>
              <div>
                <h2 id="builder-settings">Settings</h2>
                <p>{isDraft ? "Editable while this assessment is a draft" : "Locked — return to draft to change"}</p>
              </div>
            </div>
            <div className={styles.panelBody}>
              <form
                className={styles.fields}
                onSubmit={(event) => {
                  event.preventDefault();
                  void patchAssessment("settings", {
                    action: "update",
                    title: settings.title,
                    description: settings.description,
                    assessmentType: settings.assessmentType,
                    durationMinutes: settings.durationMinutes === "" ? null : Number(settings.durationMinutes),
                    passPercentage: Number(settings.passPercentage),
                    attemptLimit: Number(settings.attemptLimit),
                    feedbackMode: settings.feedbackMode,
                    shuffleQuestions: settings.shuffleQuestions,
                    shuffleOptions: settings.shuffleOptions,
                    opensAt: settings.opensAt ? new Date(settings.opensAt).toISOString() : null,
                    closesAt: settings.closesAt ? new Date(settings.closesAt).toISOString() : null,
                  }, "Settings saved.");
                }}
              >
                <label className={styles.wide}>Title
                  <input type="text" value={settings.title} disabled={!isDraft} maxLength={240} required
                    onChange={(event) => setSettings({ ...settings, title: event.target.value })} />
                </label>
                <label className={styles.wide}>Description
                  <textarea rows={2} value={settings.description} disabled={!isDraft} maxLength={4000}
                    onChange={(event) => setSettings({ ...settings, description: event.target.value })} />
                </label>
                <label>Type
                  <select value={settings.assessmentType} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, assessmentType: event.target.value })}>
                    <option value="quiz">Quiz</option><option value="exam">Exam</option><option value="practice">Practice</option>
                  </select>
                </label>
                <label>Time limit (minutes)
                  <input type="number" min="1" max="1440" value={settings.durationMinutes} disabled={!isDraft}
                    placeholder="Untimed"
                    onChange={(event) => setSettings({ ...settings, durationMinutes: event.target.value })} />
                </label>
                <label>Pass mark (%)
                  <input type="number" min="0" max="100" step="1" value={settings.passPercentage} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, passPercentage: event.target.value })} />
                </label>
                <label>Attempts allowed
                  <input type="number" min="1" max="100" value={settings.attemptLimit} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, attemptLimit: event.target.value })} />
                </label>
                <label className={styles.wide}>When learners see their marks
                  <select value={settings.feedbackMode} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, feedbackMode: event.target.value })}>
                    <option value="immediate">Immediately, as each item is scored</option>
                    <option value="after_submit">After they submit</option>
                    <option value="after_close">Only after the assessment closes</option>
                  </select>
                  {settings.feedbackMode === "after_close" && !settings.closesAt
                    ? <p className={styles.hint}>Without a closing time this behaves as “after they submit”, so marks are never withheld indefinitely.</p>
                    : null}
                </label>
                <label>Opens
                  <input type="datetime-local" value={settings.opensAt} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, opensAt: event.target.value })} />
                </label>
                <label>Closes
                  <input type="datetime-local" value={settings.closesAt} disabled={!isDraft}
                    onChange={(event) => setSettings({ ...settings, closesAt: event.target.value })} />
                </label>
                <div className={styles.wide}>
                  <label className={styles.switchRow}>
                    <input type="checkbox" checked={settings.shuffleQuestions} disabled={!isDraft}
                      onChange={(event) => setSettings({ ...settings, shuffleQuestions: event.target.checked })} />
                    Shuffle question order for each learner
                  </label>
                  <label className={styles.switchRow}>
                    <input type="checkbox" checked={settings.shuffleOptions} disabled={!isDraft}
                      onChange={(event) => setSettings({ ...settings, shuffleOptions: event.target.checked })} />
                    Shuffle the options within each question
                  </label>
                  <p className={styles.hint}>Shuffling is fixed per attempt, so a learner who navigates back finds the same question in the same place.</p>
                </div>
                {isDraft ? (
                  <div className={`${styles.footer} ${styles.wide}`}>
                    <button type="submit" className={styles.primary} disabled={busy !== null}>
                      {busy === "settings" ? "Saving…" : "Save settings"}
                    </button>
                  </div>
                ) : null}
              </form>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** ISO instants to the `datetime-local` shape, which has no timezone and no seconds. */
function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formValues(detail: AssessmentDetail) {
  const assessment = detail.assessment;
  return {
    title: assessment.title,
    description: assessment.description,
    assessmentType: assessment.assessmentType as string,
    durationMinutes: assessment.durationMinutes === null ? "" : String(assessment.durationMinutes),
    passPercentage: String(assessment.passPercentage),
    attemptLimit: String(assessment.attemptLimit),
    feedbackMode: assessment.feedbackMode as string,
    shuffleQuestions: assessment.shuffleQuestions,
    shuffleOptions: assessment.shuffleOptions,
    opensAt: toLocalInput(assessment.opensAt),
    closesAt: toLocalInput(assessment.closesAt),
  };
}
