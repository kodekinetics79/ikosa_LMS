"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { OrgUnit, QuestionBank, QuestionType } from "@/lib/server/domain";
import type { AssessmentSummary } from "@/lib/server/assessment-store";
import type { AuthorQuestionSummary, MarkingQueueItem } from "@/lib/server/assessment-list-store";
import styles from "./assessments.module.css";

type Capabilities = { author: boolean; grader: boolean; learner: boolean };
type ApiProblem = { error?: string; fields?: Record<string, string> };
type Tab = "assessments" | "library" | "marking";

type QuestionDraft = {
  bankId: string;
  questionType: QuestionType;
  prompt: string;
  choices: string;
  /** short_text accepted answers (pipe separated) and the numeric value. Choice answers are held as ids in `correctChoiceIds`, never as typed indexes. */
  answer: string;
  correctChoiceIds: string[];
  trueFalseAnswer: boolean;
  caseSensitive: boolean;
  matchLeft: string;
  matchRight: string;
  matchPairs: Record<string, string>;
  tolerance: string;
  points: number;
  difficulty: number;
  bloomLevel: "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";
  rationale: string;
};

function errorMessage(payload: ApiProblem, fallback: string): string {
  if (payload.error) return payload.error;
  if (payload.fields) return Object.values(payload.fields)[0] ?? fallback;
  return fallback;
}

function questionTypeLabel(type: QuestionType): string {
  return type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function assessmentTypeLabel(type: AssessmentSummary["assessmentType"]): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function lines(value: string): string[] {
  return value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
}

function itemsFrom(value: string, prefix: string): Array<{ id: string; label: string }> {
  return lines(value).map((label, index) => ({ id: `${prefix}${index + 1}`, label }));
}

/**
 * The correct ids that still exist in the options textarea.
 *
 * An author who deletes an option after marking it correct would otherwise ship
 * a key naming an id that is not in the list — exactly the unanswerable question
 * validateQuestionShape refuses with "The correct answer is not one of the
 * options".
 */
function liveCorrectIds(draft: QuestionDraft): string[] {
  const available = new Set(itemsFrom(draft.choices, "o").map((item) => item.id));
  return draft.correctChoiceIds.filter((id) => available.has(id));
}

/** Same defence for matching: a pair is kept only while both sides still exist. */
function livePairs(draft: QuestionDraft): Record<string, string> {
  const right = new Set(itemsFrom(draft.matchRight, "r").map((item) => item.id));
  const pairs: Record<string, string> = {};
  for (const item of itemsFrom(draft.matchLeft, "l")) {
    const chosen = draft.matchPairs[item.id];
    if (chosen && right.has(chosen)) pairs[item.id] = chosen;
  }
  return pairs;
}

function buildQuestionPayload(draft: QuestionDraft): { options: unknown; answerKey: unknown } {
  if (draft.questionType === "single_choice" || draft.questionType === "multiple_choice") {
    const choices = itemsFrom(draft.choices, "o");
    const correct = liveCorrectIds(draft);
    return draft.questionType === "single_choice"
      ? { options: { choices }, answerKey: { value: correct[0] ?? "" } }
      : { options: { choices }, answerKey: { values: correct } };
  }
  if (draft.questionType === "true_false") {
    // The kernel scores this with `typeof response.value === "boolean" && response.value === key.value`,
    // so the key has to be a real boolean. The old free-text box sent the string
    // "false", which matches neither answer and made the question unwinnable.
    return { options: { choices: [{ id: "true", label: "True" }, { id: "false", label: "False" }] }, answerKey: { value: draft.trueFalseAnswer } };
  }
  if (draft.questionType === "short_text") {
    return { options: {}, answerKey: { accepted: draft.answer.split("|").map((item) => item.trim()).filter(Boolean), caseSensitive: draft.caseSensitive } };
  }
  if (draft.questionType === "numeric") {
    return { options: {}, answerKey: { value: Number(draft.answer), tolerance: Number(draft.tolerance || 0) } };
  }
  if (draft.questionType === "ordering") {
    const items = itemsFrom(draft.choices, "o");
    // The same list under both spellings on purpose: validateQuestionShape reads
    // `options.choices` while the learner player's `orderOf` reads
    // `options.items`. Sending one of them alone either 400s at authoring time
    // or renders an ordering question with nothing to drag.
    return { options: { choices: items, items }, answerKey: { order: items.map((item) => item.id) } };
  }
  if (draft.questionType === "matching") {
    // The right list may be longer than the left; the extras are distractors, so
    // no count equality is imposed here or on the server.
    return { options: { left: itemsFrom(draft.matchLeft, "l"), right: itemsFrom(draft.matchRight, "r") }, answerKey: { pairs: livePairs(draft) } };
  }
  return { options: {}, answerKey: {} };
}

/**
 * Why this draft cannot yet produce a payload the server will accept, phrased
 * for the author.
 *
 * It mirrors validateQuestionShape deliberately. Without it the only feedback is
 * a 400 after the round trip, and for the defect that motivated the server check
 * — a correct answer that is not one of the options — that 400 arrived with no
 * control the author could use to fix it.
 */
function draftIssue(draft: QuestionDraft): string {
  if (!draft.bankId) return "Choose a question bank.";
  if (!draft.prompt.trim()) return "Write the prompt.";
  switch (draft.questionType) {
    case "single_choice":
    case "multiple_choice": {
      if (itemsFrom(draft.choices, "o").length < 2) return "Add at least two options, one per line.";
      if (liveCorrectIds(draft).length === 0) return draft.questionType === "single_choice" ? "Mark which option is correct." : "Mark at least one correct option.";
      return "";
    }
    case "short_text":
      return draft.answer.split("|").map((item) => item.trim()).filter(Boolean).length > 0 ? "" : "Give at least one accepted answer, separated by |.";
    case "numeric": {
      // Number("abc") used to be serialised as null and stored as a key nothing
      // could satisfy; the numeric key must be finite before it is sent.
      if (!draft.answer.trim() || !Number.isFinite(Number(draft.answer))) return "Give a numeric answer that is a real number.";
      const tolerance = Number(draft.tolerance || 0);
      if (!Number.isFinite(tolerance) || tolerance < 0) return "Tolerance must be zero or a positive number.";
      return "";
    }
    case "ordering":
      return itemsFrom(draft.choices, "o").length >= 2 ? "" : "Add at least two items, one per line, in the correct order.";
    case "matching": {
      const left = itemsFrom(draft.matchLeft, "l");
      if (left.length === 0) return "Add at least one item on the left.";
      if (itemsFrom(draft.matchRight, "r").length === 0) return "Add at least one item on the right.";
      const paired = Object.keys(livePairs(draft)).length;
      if (paired < left.length) return `Choose the match for every left item (${paired} of ${left.length} paired).`;
      return "";
    }
    default:
      return "";
  }
}

function previewResponse(value: unknown): string {
  if (value === null || value === undefined) return "No response";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.value === "string" || typeof object.value === "number" || typeof object.value === "boolean") return String(object.value);
    if (Array.isArray(object.values)) return object.values.map(String).join(", ");
    if (Array.isArray(object.order)) return object.order.map(String).join(" → ");
  }
  return JSON.stringify(value);
}

export function AssessmentWorkspaceClient({
  assessments: initialAssessments,
  banks: initialBanks,
  questions: initialQuestions,
  marking: initialMarking,
  organizations,
  capabilities,
  csrfToken,
}: {
  assessments: AssessmentSummary[];
  banks: QuestionBank[];
  questions: AuthorQuestionSummary[];
  marking: MarkingQueueItem[];
  organizations: OrgUnit[];
  capabilities: Capabilities;
  csrfToken: string;
}) {
  const [assessments, setAssessments] = useState(initialAssessments);
  const [banks, setBanks] = useState(initialBanks);
  const [questions, setQuestions] = useState(initialQuestions);
  const [marking, setMarking] = useState(initialMarking);
  const [tab, setTab] = useState<Tab>(capabilities.learner && !capabilities.author && !capabilities.grader ? "assessments" : "assessments");
  const [showAssessmentForm, setShowAssessmentForm] = useState(false);
  const [showBankForm, setShowBankForm] = useState(false);
  /**
   * Library filters.
   *
   * `listAuthorQuestions` returns every question in scope, unbounded and
   * unordered beyond `updated_at DESC`. On a real tenant that is a wall of
   * prompts with no way to find one, and the bank rail items were inert
   * `<div>`s that did nothing when clicked.
   */
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryBank, setLibraryBank] = useState("all");
  const [libraryReview, setLibraryReview] = useState("all");
  const [showQuestionForm, setShowQuestionForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const rootOrg = organizations[0];
  const [selectedAssessmentId, setSelectedAssessmentId] = useState(initialAssessments.find((item) => item.status === "draft")?.id ?? "");
  const [assessmentForm, setAssessmentForm] = useState({
    orgUnitId: rootOrg?.id ?? "",
    code: "",
    title: "",
    description: "",
    assessmentType: "quiz" as "quiz" | "exam" | "practice",
    durationMinutes: 30,
    passPercentage: 70,
    attemptLimit: 1,
    feedbackMode: "after_submit" as "immediate" | "after_submit" | "after_close",
  });
  const [bankForm, setBankForm] = useState({ orgUnitId: rootOrg?.id ?? "", code: "", name: "", description: "" });
  const [questionForm, setQuestionForm] = useState<QuestionDraft>({
    bankId: initialBanks[0]?.id ?? "",
    questionType: "single_choice",
    prompt: "",
    choices: "",
    answer: "",
    correctChoiceIds: [],
    trueFalseAnswer: true,
    caseSensitive: false,
    matchLeft: "",
    matchRight: "",
    matchPairs: {},
    tolerance: "0",
    points: 1,
    difficulty: 2,
    bloomLevel: "understand",
    rationale: "",
  });
  const [gradeDrafts, setGradeDrafts] = useState<Record<string, { score: string; feedback: string }>>({});

  /* The authoring controls are derived from the textareas on every keystroke, so
     the author marks a real option instead of typing an index that may not
     exist. `questionIssue` is the same rule set the server enforces, applied
     before the request rather than after the 400. */
  const choiceItems = useMemo(() => itemsFrom(questionForm.choices, "o"), [questionForm.choices]);
  const matchLeftItems = useMemo(() => itemsFrom(questionForm.matchLeft, "l"), [questionForm.matchLeft]);
  const matchRightItems = useMemo(() => itemsFrom(questionForm.matchRight, "r"), [questionForm.matchRight]);
  const questionIssue = useMemo(() => draftIssue(questionForm), [questionForm]);

  function toggleCorrectChoice(id: string) {
    setQuestionForm((current) => {
      if (current.questionType === "single_choice") return { ...current, correctChoiceIds: [id] };
      const selected = current.correctChoiceIds.includes(id);
      return { ...current, correctChoiceIds: selected ? current.correctChoiceIds.filter((item) => item !== id) : [...current.correctChoiceIds, id] };
    });
  }

  function setMatchPair(leftId: string, rightId: string) {
    setQuestionForm((current) => {
      const pairs = { ...current.matchPairs };
      if (rightId) pairs[leftId] = rightId; else delete pairs[leftId];
      return { ...current, matchPairs: pairs };
    });
  }

  const pendingMarking = marking.length;
  const published = assessments.filter((item) => item.status === "published").length;
  const drafts = assessments.filter((item) => item.status === "draft").length;
  const totalAttempts = assessments.reduce((sum, item) => sum + item.attemptCount, 0);
  const draftAssessments = useMemo(() => assessments.filter((item) => item.status === "draft"), [assessments]);

  async function createAssessment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("assessment"); setError("");
    try {
      const response = await fetch("/api/assessments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ ...assessmentForm, courseId: null, shuffleQuestions: false, shuffleOptions: false, opensAt: null, closesAt: null }),
      });
      const payload = await response.json() as AssessmentSummary & ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to create assessment"));
      setAssessments((current) => [payload, ...current]);
      setSelectedAssessmentId(payload.id);
      setAssessmentForm((current) => ({ ...current, code: "", title: "", description: "" }));
      setShowAssessmentForm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create assessment"); }
    finally { setBusy(""); }
  }

  async function createBank(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("bank"); setError("");
    try {
      const response = await fetch("/api/assessment-banks", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(bankForm) });
      const payload = await response.json() as QuestionBank & ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to create question bank"));
      setBanks((current) => [payload, ...current]);
      setQuestionForm((current) => ({ ...current, bankId: payload.id }));
      setBankForm((current) => ({ ...current, code: "", name: "", description: "" }));
      setShowBankForm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create question bank"); }
    finally { setBusy(""); }
  }

  async function createQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("question"); setError("");
    try {
      // The submit button is disabled while this is non-empty; the check is
      // repeated here because a form can still be submitted with Enter.
      if (questionIssue) throw new Error(questionIssue);
      const structured = buildQuestionPayload(questionForm);
      const response = await fetch("/api/assessment-questions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ ...questionForm, ...structured, origin: "manual", reviewStatus: "approved", skillId: null, rubricId: null }),
      });
      const payload = await response.json() as AuthorQuestionSummary & ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to create question"));
      setQuestions((current) => [{ ...payload, bankName: banks.find((bank) => bank.id === questionForm.bankId)?.name ?? "Question bank" }, ...current]);
      setQuestionForm((current) => ({ ...current, prompt: "", choices: "", answer: "", rationale: "", correctChoiceIds: [], matchLeft: "", matchRight: "", matchPairs: {} }));
      setShowQuestionForm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create question"); }
    finally { setBusy(""); }
  }

  /**
   * The review gate, reachable from the library.
   *
   * Publication requires every question to be approved, and the store forces an
   * `origin: "ai"` question to `draft` whatever the caller asks for — so
   * without this control an AI-generated question had no route to publication
   * at all, and the publish blocker naming it was unresolvable.
   */
  const visibleQuestions = questions.filter((question) => {
    if (libraryBank !== "all" && question.bankId !== libraryBank) return false;
    if (libraryReview !== "all" && question.reviewStatus !== libraryReview) return false;
    if (!librarySearch.trim()) return true;
    const needle = librarySearch.trim().toLowerCase();
    return question.prompt.toLowerCase().includes(needle)
      || question.bankName.toLowerCase().includes(needle)
      || question.questionType.includes(needle);
  });

  async function reviewQuestion(questionId: string, reviewStatus: "approved" | "rejected") {
    setBusy(`review:${questionId}`); setError("");
    try {
      const response = await fetch("/api/assessment-questions", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "review", questionId, reviewStatus }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to record that review decision");
      setQuestions((current) => current.map((item) => item.id === questionId ? { ...item, reviewStatus } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to record that review decision");
    } finally { setBusy(""); }
  }

  async function attachQuestion(questionId: string) {
    if (!selectedAssessmentId) { setError("Select a draft assessment before adding questions"); return; }
    setBusy(`attach:${questionId}`); setError("");
    try {
      const response = await fetch("/api/assessments", { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ action: "attach_question", assessmentId: selectedAssessmentId, questionId }) });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to add question"));
      setAssessments((current) => current.map((assessment) => assessment.id === selectedAssessmentId ? { ...assessment, itemCount: assessment.itemCount + 1 } : assessment));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to add question"); }
    finally { setBusy(""); }
  }

  async function publish(assessment: AssessmentSummary) {
    if (!window.confirm(`Publish ${assessment.title}? Learners in scope will be able to start attempts.`)) return;
    setBusy(`publish:${assessment.id}`); setError("");
    try {
      const response = await fetch("/api/assessments", { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ action: "publish", assessmentId: assessment.id }) });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to publish assessment"));
      setAssessments((current) => current.map((item) => item.id === assessment.id ? { ...item, status: "published" as const } : item));
      if (selectedAssessmentId === assessment.id) setSelectedAssessmentId(assessments.find((item) => item.id !== assessment.id && item.status === "draft")?.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to publish assessment"); }
    finally { setBusy(""); }
  }

  async function grade(item: MarkingQueueItem) {
    const draft = gradeDrafts[item.responseId] ?? { score: "", feedback: "" };
    const score = Number(draft.score);
    if (!Number.isFinite(score) || score < 0 || score > item.maxPoints) { setError(`Score must be between 0 and ${item.maxPoints}`); return; }
    setBusy(`grade:${item.responseId}`); setError("");
    try {
      const response = await fetch("/api/assessment-attempts", { method: "PATCH", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ action: "grade_response", responseId: item.responseId, score, feedback: draft.feedback }) });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to save grade"));
      setMarking((current) => current.filter((candidate) => candidate.responseId !== item.responseId));
      setAssessments((current) => current.map((assessment) => assessment.id === item.assessmentId ? { ...assessment, pendingMarking: Math.max(0, assessment.pendingMarking - 1) } : assessment));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save grade"); }
    finally { setBusy(""); }
  }

  return <div className={styles.page}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}>{capabilities.learner && !capabilities.author ? "Your assessments" : "Assessment studio"}</span>
        <h1>{capabilities.learner && !capabilities.author ? "Show what you know." : "Design, deliver and grade with confidence."}</h1>
        <p>{capabilities.learner && !capabilities.author ? "Quizzes, practice checks and exams available to you appear here. Your answers are saved as you work." : "Build reusable question banks, publish controlled assessments and keep objective scoring separate from human judgment."}</p>
      </div>
      {capabilities.author ? <div className={styles.heroActions}><button className={styles.secondaryButton} type="button" onClick={() => { setTab("library"); setShowQuestionForm(true); }}>New question</button><button className={styles.primaryButton} type="button" onClick={() => setShowAssessmentForm(true)}>Create assessment</button></div> : null}
    </section>

    {error ? <div className={styles.error} role="alert">{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}

    <section className={styles.metrics} aria-label="Assessment summary">
      <article><span>{capabilities.learner && !capabilities.author ? "Available" : "Published"}</span><strong>{published}</strong><small>{capabilities.learner && !capabilities.author ? "currently open to you" : "live assessments"}</small></article>
      <article><span>{capabilities.learner && !capabilities.author ? "Attempts used" : "Drafts"}</span><strong>{capabilities.learner && !capabilities.author ? totalAttempts : drafts}</strong><small>{capabilities.learner && !capabilities.author ? "across visible assessments" : "still being authored"}</small></article>
      <article><span>{capabilities.grader ? "Needs marking" : "Question count"}</span><strong>{capabilities.grader ? pendingMarking : assessments.reduce((sum,item)=>sum+item.itemCount,0)}</strong><small>{capabilities.grader ? "subjective responses" : "across visible assessments"}</small></article>
      <article><span>Assessment types</span><strong>{new Set(assessments.map((item) => item.assessmentType)).size}</strong><small>quiz · exam · practice</small></article>
    </section>

    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <div className={styles.tabs} role="tablist">
          <button className={tab === "assessments" ? styles.tabActive : styles.tab} role="tab" aria-selected={tab === "assessments"} onClick={() => setTab("assessments")}>Assessments</button>
          {capabilities.author ? <button className={tab === "library" ? styles.tabActive : styles.tab} role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>Question library <span>{questions.length}</span></button> : null}
          {capabilities.grader ? <button className={tab === "marking" ? styles.tabActive : styles.tab} role="tab" aria-selected={tab === "marking"} onClick={() => setTab("marking")}>Marking <span>{marking.length}</span></button> : null}
        </div>
        {tab === "library" && capabilities.author ? <div className={styles.libraryTools}><select value={selectedAssessmentId} onChange={(event) => setSelectedAssessmentId(event.target.value)}><option value="">Select draft assessment</option>{draftAssessments.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.title}</option>)}</select><button className={styles.ghostButton} type="button" onClick={() => setShowBankForm(true)}>New bank</button></div> : null}
      </header>

      {tab === "assessments" ? <div className={styles.assessmentGrid}>
        {assessments.length === 0 ? <div className={styles.empty}><strong>No assessments yet.</strong>{capabilities.author ? "Create the first quiz, exam or practice check." : "Nothing is open to you right now."}</div> : assessments.map((assessment) => <article className={styles.assessmentCard} key={assessment.id}>
          <div className={styles.cardTop}><div><span className={styles.type}>{assessmentTypeLabel(assessment.assessmentType)}</span><span className={`${styles.status} ${assessment.status === "published" ? styles.live : ""}`}>{statusLabel(assessment.status)}</span></div><strong>{assessment.code}</strong></div>
          <h2>{assessment.title}</h2><p>{assessment.description || "No description has been added yet."}</p>
          <div className={styles.cardStats}><span><strong>{assessment.itemCount}</strong> questions</span><span><strong>{assessment.durationMinutes ?? "—"}</strong> {assessment.durationMinutes ? "min" : "untimed"}</span><span><strong>{assessment.passPercentage}%</strong> pass</span></div>
          <div className={styles.cardFooter}>
            <small>{assessment.attemptCount} attempt{assessment.attemptCount === 1 ? "" : "s"}{assessment.pendingMarking ? ` · ${assessment.pendingMarking} pending marking` : ""}</small>
            {/* The builder is where an assessment is actually assembled: order,
                point values, required flags, availability and the publish
                checklist. Publishing straight from the card is kept for a
                draft that is already complete, but it is no longer the only
                way in — before the builder existed, attaching a question was
                fire-and-forget and nothing could show what was on an
                assessment at all. */}
            {capabilities.author ? <Link className={styles.ghostButton} href={`/assessments/${assessment.id}`}>Open builder</Link> : null}
            {capabilities.author && assessment.status === "draft" ? <button className={styles.primarySmall} disabled={busy === `publish:${assessment.id}`} onClick={() => publish(assessment)}>{busy === `publish:${assessment.id}` ? "Publishing…" : "Publish"}</button> : null}
            {capabilities.learner && assessment.status === "published" ? <Link className={styles.primarySmall} href={`/assessments/${assessment.id}/attempt`}>{assessment.attemptCount ? "Continue / retry" : "Start"}</Link> : null}
          </div>
        </article>)}
      </div> : null}

      {tab === "library" && capabilities.author ? <div className={styles.library}>
        <div className={styles.bankRail}>
          <div className={styles.railTitle}><span>Question banks</span><button type="button" aria-label="Create a question bank" onClick={() => setShowBankForm(true)}>+</button></div>
          {/* Clicking a bank filters the list. These were inert divs, so the
              rail showed counts and did nothing. */}
          <button type="button" className={`${styles.bankItem} ${libraryBank === "all" ? styles.bankItemActive : ""}`} aria-pressed={libraryBank === "all"} onClick={() => setLibraryBank("all")}>
            <strong>All banks</strong><span>Everything in scope</span><small>{questions.length} questions</small>
          </button>
          {banks.length ? banks.map((bank) => <button type="button" className={`${styles.bankItem} ${libraryBank === bank.id ? styles.bankItemActive : ""}`} aria-pressed={libraryBank === bank.id} key={bank.id} onClick={() => setLibraryBank(libraryBank === bank.id ? "all" : bank.id)}>
            <strong>{bank.name}</strong><span>{bank.code}</span><small>{questions.filter((question) => question.bankId === bank.id).length} questions</small>
          </button>) : <div className={styles.railEmpty}>Create a bank to organize reusable questions.</div>}
        </div>
        <div className={styles.questionList}>
          <div className={styles.libraryFilters}>
            <input type="search" value={librarySearch} placeholder="Search prompts, banks and types…" aria-label="Search the question library" onChange={(event) => setLibrarySearch(event.target.value)} />
            <select value={libraryReview} aria-label="Filter by review status" onChange={(event) => setLibraryReview(event.target.value)}>
              <option value="all">Any review status</option>
              <option value="draft">Awaiting review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
            <span>{visibleQuestions.length} of {questions.length}</span>
          </div>
          {visibleQuestions.length ? visibleQuestions.map((question) => <article className={styles.questionRow} key={question.id}><div className={styles.questionMeta}><span>{questionTypeLabel(question.questionType)}</span><span>Difficulty {question.difficulty}/5</span><span>{question.bloomLevel}</span><span className={question.reviewStatus === "approved" ? styles.approved : styles.draftTag}>{question.reviewStatus}</span></div><h3>{question.prompt}</h3><p>{question.rationale || `Stored in ${question.bankName}`}</p><div className={styles.questionFooter}><span>{question.points} point{question.points === 1 ? "" : "s"} · {question.origin}</span><div className={styles.questionActions}>{question.reviewStatus !== "approved" ? <button className={styles.ghostButton} type="button" disabled={busy === `review:${question.id}`} onClick={() => reviewQuestion(question.id, "approved")}>{busy === `review:${question.id}` ? "Saving…" : "Approve"}</button> : null}{question.reviewStatus === "draft" ? <button className={styles.ghostButton} type="button" disabled={busy === `review:${question.id}`} onClick={() => reviewQuestion(question.id, "rejected")}>Reject</button> : null}<button className={styles.ghostButton} type="button" disabled={!selectedAssessmentId || busy === `attach:${question.id}`} onClick={() => attachQuestion(question.id)}>{busy === `attach:${question.id}` ? "Adding…" : selectedAssessmentId ? "Add to assessment" : "Select assessment first"}</button></div></div></article>) : <div className={styles.empty}><strong>{questions.length ? "No question matches those filters." : "No questions yet."}</strong>{questions.length ? "Clear the search or choose a different bank." : "Create the first reusable question."}</div>}</div>
      </div> : null}

      {tab === "marking" && capabilities.grader ? <div className={styles.markingList}>{marking.length ? marking.map((item) => { const draft = gradeDrafts[item.responseId] ?? { score: "", feedback: "" }; return <article className={styles.markingCard} key={item.responseId}><header><div><span>{item.assessmentCode}</span><h3>{item.assessmentTitle}</h3></div><div className={styles.learnerBadge}><strong>{item.learnerName}</strong><span>{item.learnerEmail}</span></div></header><div className={styles.markingBody}><div><small>Question · {questionTypeLabel(item.questionType)}</small><h4>{item.prompt}</h4><div className={styles.responseBox}><span>Learner response</span><p>{previewResponse(item.response)}</p></div>{item.rationale ? <div className={styles.rationale}><span>Marker guidance</span><p>{item.rationale}</p></div> : null}</div><div className={styles.gradePanel}><label>Score <span>out of {item.maxPoints}</span><input type="number" min="0" max={item.maxPoints} step="0.25" value={draft.score} onChange={(event) => setGradeDrafts((current) => ({ ...current, [item.responseId]: { ...draft, score: event.target.value } }))}/></label><label>Feedback<textarea rows={5} value={draft.feedback} onChange={(event) => setGradeDrafts((current) => ({ ...current, [item.responseId]: { ...draft, feedback: event.target.value } }))} placeholder="Specific, useful feedback for the learner"/></label><button className={styles.primaryButton} type="button" disabled={busy === `grade:${item.responseId}`} onClick={() => grade(item)}>{busy === `grade:${item.responseId}` ? "Saving…" : "Save mark"}</button></div></div></article>; }) : <div className={styles.empty}><strong>Marking queue is clear.</strong>Subjective answers waiting for a human decision will appear here.</div>}</div> : null}
    </section>

    {showAssessmentForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAssessmentForm(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-assessment-title"><header><div><h2 id="create-assessment-title">Create assessment</h2><p>Start with the delivery rules; attach approved questions from the library next.</p></div><button type="button" onClick={() => setShowAssessmentForm(false)}>×</button></header><form onSubmit={createAssessment}><div className={styles.formGrid}><label>Organization<select value={assessmentForm.orgUnitId} onChange={(event) => setAssessmentForm((current) => ({ ...current, orgUnitId: event.target.value }))}>{organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label><label>Code<input value={assessmentForm.code} onChange={(event) => setAssessmentForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="SEC-QUIZ-01" required/></label><label className={styles.full}>Title<input value={assessmentForm.title} onChange={(event) => setAssessmentForm((current) => ({ ...current, title: event.target.value }))} placeholder="Security fundamentals checkpoint" required/></label><label className={styles.full}>Description<textarea rows={3} value={assessmentForm.description} onChange={(event) => setAssessmentForm((current) => ({ ...current, description: event.target.value }))}/></label><label>Type<select value={assessmentForm.assessmentType} onChange={(event) => setAssessmentForm((current) => ({ ...current, assessmentType: event.target.value as typeof current.assessmentType }))}><option value="quiz">Quiz</option><option value="exam">Exam</option><option value="practice">Practice</option></select></label><label>Duration (minutes)<input type="number" min="1" value={assessmentForm.durationMinutes} onChange={(event) => setAssessmentForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))}/></label><label>Pass percentage<input type="number" min="0" max="100" value={assessmentForm.passPercentage} onChange={(event) => setAssessmentForm((current) => ({ ...current, passPercentage: Number(event.target.value) }))}/></label><label>Attempt limit<input type="number" min="1" max="100" value={assessmentForm.attemptLimit} onChange={(event) => setAssessmentForm((current) => ({ ...current, attemptLimit: Number(event.target.value) }))}/></label><label>Feedback<select value={assessmentForm.feedbackMode} onChange={(event) => setAssessmentForm((current) => ({ ...current, feedbackMode: event.target.value as typeof current.feedbackMode }))}><option value="after_submit">After submit</option><option value="immediate">Immediate</option><option value="after_close">After close</option></select></label></div><footer><button className={styles.secondaryButton} type="button" onClick={() => setShowAssessmentForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "assessment"}>{busy === "assessment" ? "Creating…" : "Create draft"}</button></footer></form></section></div> : null}

    {showBankForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowBankForm(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-bank-title"><header><div><h2 id="create-bank-title">Create question bank</h2><p>Reusable banks keep questions organized across courses and assessments.</p></div><button type="button" onClick={() => setShowBankForm(false)}>×</button></header><form onSubmit={createBank}><div className={styles.formGrid}><label>Organization<select value={bankForm.orgUnitId} onChange={(event) => setBankForm((current) => ({ ...current, orgUnitId: event.target.value }))}>{organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label><label>Code<input value={bankForm.code} onChange={(event) => setBankForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="SEC-BANK" required/></label><label className={styles.full}>Bank name<input value={bankForm.name} onChange={(event) => setBankForm((current) => ({ ...current, name: event.target.value }))} required/></label><label className={styles.full}>Description<textarea rows={3} value={bankForm.description} onChange={(event) => setBankForm((current) => ({ ...current, description: event.target.value }))}/></label></div><footer><button className={styles.secondaryButton} type="button" onClick={() => setShowBankForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "bank"}>{busy === "bank" ? "Creating…" : "Create bank"}</button></footer></form></section></div> : null}

    {showQuestionForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowQuestionForm(false); }}><section className={`${styles.modal} ${styles.wideModal}`} role="dialog" aria-modal="true" aria-labelledby="create-question-title"><header><div><h2 id="create-question-title">Create question</h2><p>Manual questions can be approved immediately. AI-origin questions will require human review before publishing.</p></div><button type="button" onClick={() => setShowQuestionForm(false)}>×</button></header><form onSubmit={createQuestion}><div className={styles.formGrid}><label>Question bank<select value={questionForm.bankId} onChange={(event) => setQuestionForm((current) => ({ ...current, bankId: event.target.value }))} required><option value="">Select bank</option>{banks.map((bank) => <option value={bank.id} key={bank.id}>{bank.name}</option>)}</select></label><label>Question type<select value={questionForm.questionType} onChange={(event) => setQuestionForm((current) => ({ ...current, questionType: event.target.value as QuestionType, choices: "", answer: "", correctChoiceIds: [], matchLeft: "", matchRight: "", matchPairs: {} }))}><option value="single_choice">Single choice</option><option value="multiple_choice">Multiple choice</option><option value="true_false">True / False</option><option value="short_text">Short text</option><option value="long_text">Long text / essay</option><option value="numeric">Numeric</option><option value="ordering">Ordering</option><option value="matching">Matching</option></select></label><label className={styles.full}>Prompt<textarea rows={4} value={questionForm.prompt} onChange={(event) => setQuestionForm((current) => ({ ...current, prompt: event.target.value }))} placeholder="Ask one clear, measurable question…" required/></label>{["single_choice","multiple_choice","ordering"].includes(questionForm.questionType) ? <label className={styles.full}>Options <span>one per line</span><textarea rows={5} value={questionForm.choices} onChange={(event) => setQuestionForm((current) => ({ ...current, choices: event.target.value }))} placeholder={questionForm.questionType === "ordering" ? "First step\nSecond step\nThird step" : "Option one\nOption two\nOption three"} required/></label> : null}
{questionForm.questionType === "single_choice" || questionForm.questionType === "multiple_choice" ? <div className={`${styles.full} ${styles.answerPicker}`}>
  <span className={styles.pickerTitle}>Correct answer{questionForm.questionType === "multiple_choice" ? "s" : ""} <small>{questionForm.questionType === "single_choice" ? "choose one" : "choose every correct option"}</small></span>
  {choiceItems.length > 0 ? <div className={styles.choiceOptions}>{choiceItems.map((choice, index) => <label className={`${styles.choiceOption} ${questionForm.correctChoiceIds.includes(choice.id) ? styles.choiceOptionOn : ""}`} key={choice.id}>
    <input type={questionForm.questionType === "single_choice" ? "radio" : "checkbox"} name="question-correct-choice" checked={questionForm.correctChoiceIds.includes(choice.id)} onChange={() => toggleCorrectChoice(choice.id)}/><span>{index + 1}</span><strong>{choice.label}</strong>
  </label>)}</div> : <p className={styles.pickerEmpty}>Type the options above; each line appears here to be marked correct.</p>}
</div> : null}
{questionForm.questionType === "true_false" ? <div className={`${styles.full} ${styles.answerPicker}`}>
  <span className={styles.pickerTitle}>Correct answer <small>the statement is</small></span>
  <div className={styles.toggleRow}>{[true, false].map((value) => <label className={`${styles.choiceOption} ${questionForm.trueFalseAnswer === value ? styles.choiceOptionOn : ""}`} key={String(value)}>
    <input type="radio" name="question-true-false" checked={questionForm.trueFalseAnswer === value} onChange={() => setQuestionForm((current) => ({ ...current, trueFalseAnswer: value }))}/><strong>{value ? "True" : "False"}</strong>
  </label>)}</div>
</div> : null}
{questionForm.questionType === "short_text" ? <label className={styles.full}>Correct answer <span>accepted answers separated by |</span><input value={questionForm.answer} onChange={(event) => setQuestionForm((current) => ({ ...current, answer: event.target.value }))} placeholder="colour|color" required/></label> : null}
{questionForm.questionType === "short_text" ? <label className={`${styles.full} ${styles.checkboxRow}`}><input type="checkbox" checked={questionForm.caseSensitive} onChange={(event) => setQuestionForm((current) => ({ ...current, caseSensitive: event.target.checked }))}/>Case sensitive — compare the learner answer exactly as typed</label> : null}
{questionForm.questionType === "numeric" ? <label>Correct answer <span>a number</span><input type="number" step="any" value={questionForm.answer} onChange={(event) => setQuestionForm((current) => ({ ...current, answer: event.target.value }))} placeholder="42" required/></label> : null}
{questionForm.questionType === "numeric" ? <label>Tolerance<input type="number" step="any" min="0" value={questionForm.tolerance} onChange={(event) => setQuestionForm((current) => ({ ...current, tolerance: event.target.value }))}/></label> : null}
{questionForm.questionType === "ordering" ? <div className={`${styles.full} ${styles.answerPicker}`}>
  <span className={styles.pickerTitle}>Correct answer <small>the order typed above is the correct sequence</small></span>
  {choiceItems.length > 0 ? <ol className={styles.orderPreview}>{choiceItems.map((item) => <li key={item.id}>{item.label}</li>)}</ol> : <p className={styles.pickerEmpty}>Type the steps above in the order a learner must reproduce.</p>}
</div> : null}
{questionForm.questionType === "matching" ? <label className={styles.full}>Left items <span>one per line</span><textarea rows={4} value={questionForm.matchLeft} onChange={(event) => setQuestionForm((current) => ({ ...current, matchLeft: event.target.value }))} placeholder={"Encryption at rest\nMulti-factor authentication\nLeast privilege"} required/></label> : null}
{questionForm.questionType === "matching" ? <label className={styles.full}>Right items <span>one per line · extras become distractors</span><textarea rows={4} value={questionForm.matchRight} onChange={(event) => setQuestionForm((current) => ({ ...current, matchRight: event.target.value }))} placeholder={"Protects stored data\nStops stolen-password logins\nLimits the blast radius\nSpeeds up backups"} required/></label> : null}
{questionForm.questionType === "matching" ? <div className={`${styles.full} ${styles.answerPicker}`}>
  <span className={styles.pickerTitle}>Correct pairing <small>every left item needs a match</small></span>
  {matchLeftItems.length > 0 && matchRightItems.length > 0 ? <div className={styles.pairGrid}>{matchLeftItems.map((item) => <div className={styles.pairRow} key={item.id}>
    <strong>{item.label}</strong>
    <select value={questionForm.matchPairs[item.id] ?? ""} aria-label={`Match for ${item.label}`} onChange={(event) => setMatchPair(item.id, event.target.value)}>
      <option value="">Select the match</option>
      {matchRightItems.map((right) => <option value={right.id} key={right.id}>{right.label}</option>)}
    </select>
  </div>)}</div> : <p className={styles.pickerEmpty}>Fill both lists above and each left item gets a match picker here.</p>}
  {/* Said plainly because the learner player does not render matching yet: the
      kernel scores it, the attempt screen shows an unsupported notice. */}
  <p className={styles.pickerNote}>Matching is scored automatically, but learner delivery for it is not enabled in this release — the attempt screen shows a notice instead of the pairing controls.</p>
</div> : null}
<label>Points<input type="number" min="0.25" step="0.25" value={questionForm.points} onChange={(event) => setQuestionForm((current) => ({ ...current, points: Number(event.target.value) }))}/></label><label>Difficulty<select value={questionForm.difficulty} onChange={(event) => setQuestionForm((current) => ({ ...current, difficulty: Number(event.target.value) }))}><option value={1}>1 · Easy</option><option value={2}>2 · Foundation</option><option value={3}>3 · Moderate</option><option value={4}>4 · Advanced</option><option value={5}>5 · Expert</option></select></label><label>Bloom level<select value={questionForm.bloomLevel} onChange={(event) => setQuestionForm((current) => ({ ...current, bloomLevel: event.target.value as typeof current.bloomLevel }))}><option value="remember">Remember</option><option value="understand">Understand</option><option value="apply">Apply</option><option value="analyze">Analyze</option><option value="evaluate">Evaluate</option><option value="create">Create</option></select></label><label className={styles.full}>Rationale / marker guidance<textarea rows={3} value={questionForm.rationale} onChange={(event) => setQuestionForm((current) => ({ ...current, rationale: event.target.value }))} placeholder="Why the answer is correct or what a strong response should demonstrate."/></label></div><footer>{questionIssue ? <p className={styles.formIssue} role="status">{questionIssue}</p> : null}<button className={styles.secondaryButton} type="button" onClick={() => setShowQuestionForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "question" || questionIssue !== ""}>{busy === "question" ? "Creating…" : "Create approved question"}</button></footer></form></section></div> : null}
  </div>;
}
