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
  answer: string;
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

function buildQuestionPayload(draft: QuestionDraft): { options: unknown; answerKey: unknown } {
  const choiceLines = lines(draft.choices);
  if (draft.questionType === "single_choice" || draft.questionType === "multiple_choice") {
    const choices = choiceLines.map((label, index) => ({ id: `o${index + 1}`, label }));
    const indexes = draft.answer.split(",").map((item) => Number(item.trim()) - 1).filter((item) => Number.isInteger(item) && item >= 0 && item < choices.length);
    return draft.questionType === "single_choice"
      ? { options: { choices }, answerKey: { value: choices[indexes[0] ?? -1]?.id ?? "" } }
      : { options: { choices }, answerKey: { values: indexes.map((index) => choices[index].id) } };
  }
  if (draft.questionType === "true_false") {
    return { options: { choices: [{ id: "true", label: "True" }, { id: "false", label: "False" }] }, answerKey: { value: draft.answer.trim().toLowerCase() === "true" } };
  }
  if (draft.questionType === "short_text") {
    return { options: {}, answerKey: { accepted: draft.answer.split("|").map((item) => item.trim()).filter(Boolean), caseSensitive: false } };
  }
  if (draft.questionType === "numeric") {
    return { options: {}, answerKey: { value: Number(draft.answer), tolerance: Number(draft.tolerance || 0) } };
  }
  if (draft.questionType === "ordering") {
    const items = choiceLines.map((label, index) => ({ id: `o${index + 1}`, label }));
    return { options: { items }, answerKey: { order: items.map((item) => item.id) } };
  }
  return { options: {}, answerKey: {} };
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
    tolerance: "0",
    points: 1,
    difficulty: 2,
    bloomLevel: "understand",
    rationale: "",
  });
  const [gradeDrafts, setGradeDrafts] = useState<Record<string, { score: string; feedback: string }>>({});

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
      if (!questionForm.bankId) throw new Error("Create or select a question bank first");
      const structured = buildQuestionPayload(questionForm);
      const response = await fetch("/api/assessment-questions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ ...questionForm, ...structured, origin: "manual", reviewStatus: "approved", skillId: null, rubricId: null }),
      });
      const payload = await response.json() as AuthorQuestionSummary & ApiProblem;
      if (!response.ok) throw new Error(errorMessage(payload, "Unable to create question"));
      setQuestions((current) => [{ ...payload, bankName: banks.find((bank) => bank.id === questionForm.bankId)?.name ?? "Question bank" }, ...current]);
      setQuestionForm((current) => ({ ...current, prompt: "", choices: "", answer: "", rationale: "" }));
      setShowQuestionForm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create question"); }
    finally { setBusy(""); }
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
            {capabilities.author && assessment.status === "draft" ? <button className={styles.primarySmall} disabled={busy === `publish:${assessment.id}`} onClick={() => publish(assessment)}>{busy === `publish:${assessment.id}` ? "Publishing…" : "Publish"}</button> : null}
            {capabilities.learner && assessment.status === "published" ? <Link className={styles.primarySmall} href={`/assessments/${assessment.id}/attempt`}>{assessment.attemptCount ? "Continue / retry" : "Start"}</Link> : null}
          </div>
        </article>)}
      </div> : null}

      {tab === "library" && capabilities.author ? <div className={styles.library}>
        <div className={styles.bankRail}><div className={styles.railTitle}><span>Question banks</span><button type="button" onClick={() => setShowBankForm(true)}>+</button></div>{banks.length ? banks.map((bank) => <div className={styles.bankItem} key={bank.id}><strong>{bank.name}</strong><span>{bank.code}</span><small>{questions.filter((question) => question.bankId === bank.id).length} questions</small></div>) : <div className={styles.railEmpty}>Create a bank to organize reusable questions.</div>}</div>
        <div className={styles.questionList}>{questions.length ? questions.map((question) => <article className={styles.questionRow} key={question.id}><div className={styles.questionMeta}><span>{questionTypeLabel(question.questionType)}</span><span>Difficulty {question.difficulty}/5</span><span>{question.bloomLevel}</span><span className={question.reviewStatus === "approved" ? styles.approved : styles.draftTag}>{question.reviewStatus}</span></div><h3>{question.prompt}</h3><p>{question.rationale || `Stored in ${question.bankName}`}</p><div className={styles.questionFooter}><span>{question.points} point{question.points === 1 ? "" : "s"} · {question.origin}</span><button className={styles.ghostButton} type="button" disabled={!selectedAssessmentId || busy === `attach:${question.id}`} onClick={() => attachQuestion(question.id)}>{busy === `attach:${question.id}` ? "Adding…" : selectedAssessmentId ? "Add to assessment" : "Select assessment first"}</button></div></article>) : <div className={styles.empty}><strong>No questions yet.</strong>Create the first reusable question.</div>}</div>
      </div> : null}

      {tab === "marking" && capabilities.grader ? <div className={styles.markingList}>{marking.length ? marking.map((item) => { const draft = gradeDrafts[item.responseId] ?? { score: "", feedback: "" }; return <article className={styles.markingCard} key={item.responseId}><header><div><span>{item.assessmentCode}</span><h3>{item.assessmentTitle}</h3></div><div className={styles.learnerBadge}><strong>{item.learnerName}</strong><span>{item.learnerEmail}</span></div></header><div className={styles.markingBody}><div><small>Question · {questionTypeLabel(item.questionType)}</small><h4>{item.prompt}</h4><div className={styles.responseBox}><span>Learner response</span><p>{previewResponse(item.response)}</p></div>{item.rationale ? <div className={styles.rationale}><span>Marker guidance</span><p>{item.rationale}</p></div> : null}</div><div className={styles.gradePanel}><label>Score <span>out of {item.maxPoints}</span><input type="number" min="0" max={item.maxPoints} step="0.25" value={draft.score} onChange={(event) => setGradeDrafts((current) => ({ ...current, [item.responseId]: { ...draft, score: event.target.value } }))}/></label><label>Feedback<textarea rows={5} value={draft.feedback} onChange={(event) => setGradeDrafts((current) => ({ ...current, [item.responseId]: { ...draft, feedback: event.target.value } }))} placeholder="Specific, useful feedback for the learner"/></label><button className={styles.primaryButton} type="button" disabled={busy === `grade:${item.responseId}`} onClick={() => grade(item)}>{busy === `grade:${item.responseId}` ? "Saving…" : "Save mark"}</button></div></div></article>; }) : <div className={styles.empty}><strong>Marking queue is clear.</strong>Subjective answers waiting for a human decision will appear here.</div>}</div> : null}
    </section>

    {showAssessmentForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAssessmentForm(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-assessment-title"><header><div><h2 id="create-assessment-title">Create assessment</h2><p>Start with the delivery rules; attach approved questions from the library next.</p></div><button type="button" onClick={() => setShowAssessmentForm(false)}>×</button></header><form onSubmit={createAssessment}><div className={styles.formGrid}><label>Organization<select value={assessmentForm.orgUnitId} onChange={(event) => setAssessmentForm((current) => ({ ...current, orgUnitId: event.target.value }))}>{organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label><label>Code<input value={assessmentForm.code} onChange={(event) => setAssessmentForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="SEC-QUIZ-01" required/></label><label className={styles.full}>Title<input value={assessmentForm.title} onChange={(event) => setAssessmentForm((current) => ({ ...current, title: event.target.value }))} placeholder="Security fundamentals checkpoint" required/></label><label className={styles.full}>Description<textarea rows={3} value={assessmentForm.description} onChange={(event) => setAssessmentForm((current) => ({ ...current, description: event.target.value }))}/></label><label>Type<select value={assessmentForm.assessmentType} onChange={(event) => setAssessmentForm((current) => ({ ...current, assessmentType: event.target.value as typeof current.assessmentType }))}><option value="quiz">Quiz</option><option value="exam">Exam</option><option value="practice">Practice</option></select></label><label>Duration (minutes)<input type="number" min="1" value={assessmentForm.durationMinutes} onChange={(event) => setAssessmentForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))}/></label><label>Pass percentage<input type="number" min="0" max="100" value={assessmentForm.passPercentage} onChange={(event) => setAssessmentForm((current) => ({ ...current, passPercentage: Number(event.target.value) }))}/></label><label>Attempt limit<input type="number" min="1" max="100" value={assessmentForm.attemptLimit} onChange={(event) => setAssessmentForm((current) => ({ ...current, attemptLimit: Number(event.target.value) }))}/></label><label>Feedback<select value={assessmentForm.feedbackMode} onChange={(event) => setAssessmentForm((current) => ({ ...current, feedbackMode: event.target.value as typeof current.feedbackMode }))}><option value="after_submit">After submit</option><option value="immediate">Immediate</option><option value="after_close">After close</option></select></label></div><footer><button className={styles.secondaryButton} type="button" onClick={() => setShowAssessmentForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "assessment"}>{busy === "assessment" ? "Creating…" : "Create draft"}</button></footer></form></section></div> : null}

    {showBankForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowBankForm(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="create-bank-title"><header><div><h2 id="create-bank-title">Create question bank</h2><p>Reusable banks keep questions organized across courses and assessments.</p></div><button type="button" onClick={() => setShowBankForm(false)}>×</button></header><form onSubmit={createBank}><div className={styles.formGrid}><label>Organization<select value={bankForm.orgUnitId} onChange={(event) => setBankForm((current) => ({ ...current, orgUnitId: event.target.value }))}>{organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label><label>Code<input value={bankForm.code} onChange={(event) => setBankForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="SEC-BANK" required/></label><label className={styles.full}>Bank name<input value={bankForm.name} onChange={(event) => setBankForm((current) => ({ ...current, name: event.target.value }))} required/></label><label className={styles.full}>Description<textarea rows={3} value={bankForm.description} onChange={(event) => setBankForm((current) => ({ ...current, description: event.target.value }))}/></label></div><footer><button className={styles.secondaryButton} type="button" onClick={() => setShowBankForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "bank"}>{busy === "bank" ? "Creating…" : "Create bank"}</button></footer></form></section></div> : null}

    {showQuestionForm ? <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowQuestionForm(false); }}><section className={`${styles.modal} ${styles.wideModal}`} role="dialog" aria-modal="true" aria-labelledby="create-question-title"><header><div><h2 id="create-question-title">Create question</h2><p>Manual questions can be approved immediately. AI-origin questions will require human review before publishing.</p></div><button type="button" onClick={() => setShowQuestionForm(false)}>×</button></header><form onSubmit={createQuestion}><div className={styles.formGrid}><label>Question bank<select value={questionForm.bankId} onChange={(event) => setQuestionForm((current) => ({ ...current, bankId: event.target.value }))} required><option value="">Select bank</option>{banks.map((bank) => <option value={bank.id} key={bank.id}>{bank.name}</option>)}</select></label><label>Question type<select value={questionForm.questionType} onChange={(event) => setQuestionForm((current) => ({ ...current, questionType: event.target.value as QuestionType, choices: "", answer: "" }))}><option value="single_choice">Single choice</option><option value="multiple_choice">Multiple choice</option><option value="true_false">True / False</option><option value="short_text">Short text</option><option value="long_text">Long text / essay</option><option value="numeric">Numeric</option><option value="ordering">Ordering</option></select></label><label className={styles.full}>Prompt<textarea rows={4} value={questionForm.prompt} onChange={(event) => setQuestionForm((current) => ({ ...current, prompt: event.target.value }))} placeholder="Ask one clear, measurable question…" required/></label>{["single_choice","multiple_choice","ordering"].includes(questionForm.questionType) ? <label className={styles.full}>Options <span>one per line</span><textarea rows={5} value={questionForm.choices} onChange={(event) => setQuestionForm((current) => ({ ...current, choices: event.target.value }))} placeholder={questionForm.questionType === "ordering" ? "First step\nSecond step\nThird step" : "Option one\nOption two\nOption three"} required/></label> : null}{questionForm.questionType !== "long_text" ? <label className={styles.full}>Correct answer <span>{questionForm.questionType === "single_choice" ? "option number (e.g. 2)" : questionForm.questionType === "multiple_choice" ? "comma-separated option numbers (e.g. 1,3)" : questionForm.questionType === "short_text" ? "accepted answers separated by |" : questionForm.questionType === "ordering" ? "order follows the option list above" : ""}</span>{questionForm.questionType === "ordering" ? <input value="The option order above is the correct order" readOnly/> : <input value={questionForm.answer} onChange={(event) => setQuestionForm((current) => ({ ...current, answer: event.target.value }))} required/>}</label> : null}{questionForm.questionType === "numeric" ? <label>Tolerance<input type="number" step="any" min="0" value={questionForm.tolerance} onChange={(event) => setQuestionForm((current) => ({ ...current, tolerance: event.target.value }))}/></label> : null}<label>Points<input type="number" min="0.25" step="0.25" value={questionForm.points} onChange={(event) => setQuestionForm((current) => ({ ...current, points: Number(event.target.value) }))}/></label><label>Difficulty<select value={questionForm.difficulty} onChange={(event) => setQuestionForm((current) => ({ ...current, difficulty: Number(event.target.value) }))}><option value={1}>1 · Easy</option><option value={2}>2 · Foundation</option><option value={3}>3 · Moderate</option><option value={4}>4 · Advanced</option><option value={5}>5 · Expert</option></select></label><label>Bloom level<select value={questionForm.bloomLevel} onChange={(event) => setQuestionForm((current) => ({ ...current, bloomLevel: event.target.value as typeof current.bloomLevel }))}><option value="remember">Remember</option><option value="understand">Understand</option><option value="apply">Apply</option><option value="analyze">Analyze</option><option value="evaluate">Evaluate</option><option value="create">Create</option></select></label><label className={styles.full}>Rationale / marker guidance<textarea rows={3} value={questionForm.rationale} onChange={(event) => setQuestionForm((current) => ({ ...current, rationale: event.target.value }))} placeholder="Why the answer is correct or what a strong response should demonstrate."/></label></div><footer><button className={styles.secondaryButton} type="button" onClick={() => setShowQuestionForm(false)}>Cancel</button><button className={styles.primaryButton} type="submit" disabled={busy === "question"}>{busy === "question" ? "Creating…" : "Create approved question"}</button></footer></form></section></div> : null}
  </div>;
}
