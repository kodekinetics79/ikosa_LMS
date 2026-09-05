"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssessmentSummary, AttemptWorkspace, LearnerQuestion } from "@/lib/server/assessment-store";
import type { AssessmentAttempt } from "@/lib/server/domain";
import styles from "./attempt.module.css";

type ApiProblem = { error?: string; fields?: Record<string, string> };
type AnswerMap = Record<string, unknown>;

type Choice = { id: string; label: string };
type OrderItem = { id: string; label: string };
type MatchingSides = { left: Choice[]; right: Choice[] };

/** What the learner branch of `GET /api/assessments` returns for one card. */
type LearnerAssessmentCard = Pick<AssessmentSummary,
  "id" | "code" | "title" | "description" | "assessmentType" | "durationMinutes" | "passPercentage" | "attemptLimit" | "attemptCount" | "status">;
/** One row of `GET /api/assessment-attempts`. */
type LearnerAttemptRow = { attempt: Pick<AssessmentAttempt, "id" | "assessmentId" | "status" | "attemptNumber">; awaitingMarking: number };
/** Everything the start screen needs before an attempt exists. */
type Briefing = { assessment: LearnerAssessmentCard | null; attempts: LearnerAttemptRow[] };

function problem(payload: ApiProblem, fallback: string): string {
  return payload.error ?? (payload.fields ? Object.values(payload.fields)[0] : undefined) ?? fallback;
}

function labelledItems(value: unknown, fallbackNoun: string): Choice[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: String(object.id ?? `o${index + 1}`), label: String(object.label ?? object.text ?? `${fallbackNoun} ${index + 1}`) };
  });
}

function choicesOf(options: unknown): Choice[] {
  if (!options || typeof options !== "object") return [];
  return labelledItems((options as Record<string, unknown>).choices, "Option");
}

function orderOf(options: unknown): OrderItem[] {
  if (!options || typeof options !== "object") return [];
  const record = options as Record<string, unknown>;
  // The authoring validator stores an ordering question's items under `choices`
  // (orderingOptions in assessment/question-schema.ts), so reading only `items`
  // rendered an empty list — no rows, no way to answer — for every ordering
  // question the product can actually author. `items` is still accepted so any
  // row written in the older shape keeps working.
  return labelledItems(record.choices ?? record.items, "Item");
}

function matchingOf(options: unknown): MatchingSides {
  if (!options || typeof options !== "object") return { left: [], right: [] };
  const record = options as Record<string, unknown>;
  return { left: labelledItems(record.left, "Item"), right: labelledItems(record.right, "Match") };
}

function pairsOf(value: unknown): Record<string, string> {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pairs = object.pairs;
  if (!pairs || typeof pairs !== "object" || Array.isArray(pairs)) return {};
  const result: Record<string, string> = {};
  for (const [leftId, rightId] of Object.entries(pairs as Record<string, unknown>)) {
    if (typeof rightId === "string" && rightId !== "") result[leftId] = rightId;
  }
  return result;
}

function answered(question: LearnerQuestion, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const type = question.questionType;
  if (type === "multiple_choice") return Array.isArray(object.values) && object.values.length > 0;
  if (type === "ordering") return Array.isArray(object.order) && object.order.length > 0;
  if (type === "matching") {
    // A half-finished pairing must not read as answered. `{pairs:{}}` is an
    // object, so the old "the value exists" test marked the question Answered in
    // the navigator and let submit's required-question gate through — for a
    // response the kernel scores all-or-nothing and therefore marks wrong.
    const left = matchingOf(question.options).left;
    if (left.length === 0) return false;
    const chosen = pairsOf(object);
    return left.every((item) => chosen[item.id] !== undefined);
  }
  return object.value !== undefined && object.value !== null && String(object.value).trim() !== "";
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours ? `${hours}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}` : `${minutes}:${String(secs).padStart(2,"0")}`;
}

export function AssessmentAttemptClient({ assessmentId, csrfToken }: { assessmentId: string; csrfToken: string }) {
  const [workspace, setWorkspace] = useState<AttemptWorkspace | null>(null);
  /**
   * What the learner is told before anything is spent.
   *
   * Mounting this page used to POST an attempt straight away, so opening the URL
   * — a mistyped link, a wrong card, a back button — consumed one of a limited
   * set of attempts silently and irreversibly. Nothing is written until the
   * learner presses the button on the start screen this feeds.
   */
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [starting, setStarting] = useState(false);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * Per-question save state.
   *
   * `save()` used to write the answer into local state and, on failure, only
   * set the error banner — so a failed save left the answer looking saved. The
   * learner sees "Answered" in the navigator and a green "Up to date" footer
   * for a response the server never received, and finds out at submit. An
   * answer whose save failed is tracked here and reported as unsaved.
   */
  const [unsaved, setUnsaved] = useState<Record<string, true>>({});
  const pendingText = useRef<Map<string, { value: unknown; timer: number }>>(new Map());
  const [error, setError] = useState("");
  const [result, setResult] = useState<AttemptWorkspace["attempt"] | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const submittedRef = useRef(false);

  /**
   * Reads the assessment card and this learner's own attempts. Both are plain
   * GETs: nothing here starts, resumes or consumes an attempt.
   */
  const loadBriefing = useCallback(async () => {
    const [assessmentsResponse, attemptsResponse] = await Promise.all([
      fetch("/api/assessments", { headers: { accept: "application/json" } }),
      fetch("/api/assessment-attempts", { headers: { accept: "application/json" } }),
    ]);
    const assessmentsPayload = await assessmentsResponse.json() as { items?: LearnerAssessmentCard[] } & ApiProblem;
    if (!assessmentsResponse.ok) throw new Error(problem(assessmentsPayload, "Unable to load this assessment"));
    const attemptsPayload = await attemptsResponse.json() as { items?: LearnerAttemptRow[] } & ApiProblem;
    if (!attemptsResponse.ok) throw new Error(problem(attemptsPayload, "Unable to load your attempts"));
    setBriefing({
      assessment: (assessmentsPayload.items ?? []).find((item) => item.id === assessmentId) ?? null,
      attempts: (attemptsPayload.items ?? []).filter((row) => row.attempt.assessmentId === assessmentId),
    });
  }, [assessmentId]);

  useEffect(() => {
    setLoading(true);
    loadBriefing()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to load this assessment"))
      .finally(() => setLoading(false));
  }, [loadBriefing]);

  const start = useCallback(async () => {
    setStarting(true); setError("");
    try {
      const response = await fetch("/api/assessment-attempts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ assessmentId }),
      });
      const payload = await response.json() as AttemptWorkspace & ApiProblem;
      if (!response.ok || !payload.attempt) throw new Error(problem(payload, "Unable to start assessment"));
      setWorkspace(payload);
      const initial: AnswerMap = {};
      for (const item of payload.responses) initial[item.questionId] = item.response;
      setAnswers(initial);
      // Seed the countdown from the SERVER's deadline and the SERVER's clock,
      // then tick locally. Measuring `Date.now()` against `startedAt` gave a
      // learner whose device clock was wrong - or set back deliberately - a
      // different amount of time than the exam allowed. Only the difference
      // between two server timestamps is trusted here; the browser contributes
      // the ticking, not the budget.
      if (payload.deadlineAt) {
        const remaining = Math.floor((Date.parse(payload.deadlineAt) - Date.parse(payload.serverNow)) / 1000);
        setSecondsLeft(Math.max(0, remaining));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start assessment");
      // A refused start means the server's view of this learner's attempts is
      // not the one on screen (another tab started the last attempt, or the
      // window closed): re-read it so the card stops offering a button that
      // can only fail.
      void loadBriefing().catch(() => undefined);
    }
    finally { setStarting(false); }
  }, [assessmentId, csrfToken, loadBriefing]);

  const submit = useCallback(async (automatic = false) => {
    if (!workspace || submittedRef.current) return;
    if (!automatic) {
      const missing = workspace.questions.filter((question) => question.required && !answered(question, answers[question.id]));
      if (missing.length) { setError(`${missing.length} required question${missing.length === 1 ? " is" : "s are"} unanswered.`); setCurrent(Math.max(0, workspace.questions.indexOf(missing[0]))); return; }
      if (!window.confirm("Submit this assessment? You will not be able to change these answers afterward.")) return;
    }
    submittedRef.current = true; setSaving("submit"); setError("");
    try {
      const response = await fetch("/api/assessment-attempts", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "submit", attemptId: workspace.attempt.id }),
      });
      const payload = await response.json() as { attempt?: AttemptWorkspace["attempt"] } & ApiProblem;
      if (!response.ok || !payload.attempt) throw new Error(problem(payload, "Unable to submit assessment"));
      setResult(payload.attempt);
    } catch (cause) { submittedRef.current = false; setError(cause instanceof Error ? cause.message : "Unable to submit assessment"); }
    finally { setSaving(null); }
  }, [answers, csrfToken, workspace]);

  useEffect(() => {
    if (secondsLeft === null || result) return;
    if (secondsLeft <= 0) { void submit(true); return; }
    const timer = window.setInterval(() => setSecondsLeft((value) => value === null ? null : Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [result, secondsLeft, submit]);

  const persist = useCallback(async (attemptId: string, questionId: string, responseValue: unknown) => {
    setSaving(questionId);
    try {
      const response = await fetch("/api/assessment-attempts", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "save_response", attemptId, questionId, response: responseValue }),
      });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(problem(payload, "Unable to save answer"));
      setUnsaved((current) => {
        if (!current[questionId]) return current;
        const next = { ...current };
        delete next[questionId];
        return next;
      });
    } catch (cause) {
      // Record it against the question, not just in a banner the learner can
      // dismiss. The navigator and the footer both read this.
      setUnsaved((current) => ({ ...current, [questionId]: true }));
      setError(cause instanceof Error ? cause.message : "Unable to save answer");
    }
    finally { setSaving(null); }
  }, [csrfToken]);

  const save = useCallback(async (questionId: string, responseValue: unknown) => {
    if (!workspace || result || secondsLeft === 0) return;
    setAnswers((currentAnswers) => ({ ...currentAnswers, [questionId]: responseValue }));
    const queued = pendingText.current.get(questionId);
    if (queued) { window.clearTimeout(queued.timer); pendingText.current.delete(questionId); }
    await persist(workspace.attempt.id, questionId, responseValue);
  }, [persist, result, secondsLeft, workspace]);

  /**
   * Typing does not block on the network.
   *
   * Text answers were saved on blur alone, with a hint saying so. A learner who
   * writes an essay and then closes the tab, loses their connection, or simply
   * runs out of time without clicking elsewhere loses everything they typed —
   * blur is not an event you can rely on happening. This keeps the local answer
   * current immediately and writes it through shortly after they stop typing.
   */
  const saveDebounced = useCallback((questionId: string, responseValue: unknown) => {
    if (!workspace || result || secondsLeft === 0) return;
    setAnswers((currentAnswers) => ({ ...currentAnswers, [questionId]: responseValue }));
    const attemptId = workspace.attempt.id;
    const queued = pendingText.current.get(questionId);
    if (queued) window.clearTimeout(queued.timer);
    const timer = window.setTimeout(() => {
      pendingText.current.delete(questionId);
      void persist(attemptId, questionId, responseValue);
    }, 1200);
    pendingText.current.set(questionId, { value: responseValue, timer });
  }, [persist, result, secondsLeft, workspace]);

  /**
   * Flush anything still waiting when the page is being hidden or unloaded.
   *
   * `pagehide` fires where `beforeunload` is unreliable (mobile Safari, bfcache),
   * and `visibilitychange` covers a tab switch that never unloads. `keepalive`
   * lets the request outlive the document.
   */
  useEffect(() => {
    if (!workspace || result) return;
    const attemptId = workspace.attempt.id;
    const flush = () => {
      for (const [questionId, queued] of pendingText.current) {
        window.clearTimeout(queued.timer);
        void fetch("/api/assessment-attempts", {
          method: "PATCH", keepalive: true,
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ action: "save_response", attemptId, questionId, response: queued.value }),
        }).catch(() => undefined);
      }
      pendingText.current.clear();
    };
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [csrfToken, result, workspace]);

  const unsavedCount = useMemo(() => Object.keys(unsaved).length, [unsaved]);
  const answeredCount = useMemo(() => workspace ? workspace.questions.filter((question) => answered(question, answers[question.id])).length : 0, [answers, workspace]);
  const question = workspace?.questions[current];

  if (loading || (starting && !workspace)) return <div className={styles.loading}><div className={styles.spinner}/><strong>{starting ? "Preparing your assessment…" : "Loading assessment details…"}</strong><span>{starting ? "Opening the latest saved attempt and question set." : "Reading the instructions and your attempt history."}</span></div>;

  if (!workspace) {
    const card = briefing?.assessment ?? null;
    if (!card) return <div className={styles.failure}><strong>Assessment unavailable</strong><p>{error || "This assessment is not published to you, or its window has closed."}</p><Link href="/assessments">Return to assessments</Link></div>;
    // `attemptCount` already includes an attempt that is still open, so the
    // "no attempts left" branch must exclude that case or a learner mid-exam
    // would be told to go away instead of being offered Resume.
    const inProgress = briefing?.attempts.find((row) => row.attempt.status === "in_progress") ?? null;
    const exhausted = !inProgress && card.attemptCount >= card.attemptLimit;
    return <div className={styles.startPage}><section className={styles.startCard}>
      <Link className={styles.startBack} href="/assessments">← Assessments</Link>
      <span className={styles.startCode}>{card.code} · {card.assessmentType}</span>
      <h1>{card.title}</h1>
      {card.description ? <p className={styles.startDescription}>{card.description}</p> : null}
      <dl className={styles.startFacts}>
        <div><dt>Time limit</dt><dd>{card.durationMinutes ? `${card.durationMinutes} minutes` : "Untimed"}</dd></div>
        <div><dt>Pass mark</dt><dd>{card.passPercentage}%</dd></div>
        <div><dt>Attempts used</dt><dd>{card.attemptCount} of {card.attemptLimit}</dd></div>
        <div><dt>Status</dt><dd>{inProgress ? `Attempt ${inProgress.attempt.attemptNumber} in progress` : exhausted ? "No attempts left" : "Not started"}</dd></div>
      </dl>
      {error ? <div className={styles.error} role="alert">{error}<button onClick={() => setError("")} type="button">×</button></div> : null}
      {exhausted
        ? <div className={styles.startBlocked}><strong>You have used all {card.attemptLimit} {card.attemptLimit === 1 ? "attempt" : "attempts"}.</strong><span>Starting another would be refused. Your marks appear on your assessments list once each attempt is graded.</span><Link className={styles.primaryLink} href="/assessments">Back to assessments</Link></div>
        : <>
            <button type="button" className={styles.startButton} disabled={starting} onClick={() => void start()}>{starting ? "Opening…" : inProgress ? "Resume attempt" : "Start assessment"}</button>
            <p className={styles.startNote}>{inProgress
              ? card.durationMinutes ? "Resuming reopens the attempt you already started — its timer has been running since then and does not restart." : "Resuming reopens the attempt you already started, with your saved answers."
              : card.durationMinutes ? `Starting uses one of your ${card.attemptLimit} ${card.attemptLimit === 1 ? "attempt" : "attempts"} and begins the ${card.durationMinutes}-minute timer, which keeps running if you close this page.` : `Starting uses one of your ${card.attemptLimit} ${card.attemptLimit === 1 ? "attempt" : "attempts"}. Your answers save as you go.`}</p>
          </>}
    </section></div>;
  }

  if (result) {
    const pending = result.status === "submitted";
    return <div className={styles.resultPage}><section className={styles.resultCard}><div className={pending ? styles.pendingMark : styles.completeMark}>{pending ? "Human marking" : result.passed ? "Passed" : "Completed"}</div><h1>{pending ? "Your assessment has been submitted." : result.passed ? "Assessment passed." : "Assessment graded."}</h1><p>{pending ? "Objective questions have been scored. One or more subjective answers are now waiting for an authorized human marker; no AI score has been published as final." : `Your final score is ${result.percentage ?? 0}%. The pass mark was ${workspace.assessment.passPercentage}%.`}</p><div className={styles.resultStats}><span><strong>{result.scorePoints ?? "—"}</strong>points earned</span><span><strong>{result.maxPoints ?? "—"}</strong>points available</span><span><strong>{result.percentage === null ? "Pending" : `${result.percentage}%`}</strong>final percentage</span></div><Link className={styles.primaryLink} href="/assessments">Back to assessments</Link></section></div>;
  }

  return <div className={styles.player}>
    <header className={styles.playerHeader}><div><Link href="/assessments">← Assessments</Link><span>{workspace.assessment.code}</span><h1>{workspace.assessment.title}</h1></div><div className={styles.headerStats}><span><small>Progress</small><strong>{answeredCount}/{workspace.questions.length}</strong></span>{secondsLeft !== null ? <span className={secondsLeft < 300 ? styles.timeUrgent : ""} role="timer" aria-live={secondsLeft <= 60 ? "assertive" : "off"} aria-label={`Time remaining ${formatTime(secondsLeft)}`}><small>Time left</small><strong>{formatTime(secondsLeft)}</strong></span> : null}</div></header>
    {error ? <div className={styles.error} role="alert">{error}<button onClick={() => setError("")} type="button">×</button></div> : null}
    <div className={styles.playerGrid}>
      <aside className={styles.questionNav}><div className={styles.navTitle}>Questions <span>{Math.round((answeredCount / Math.max(1,workspace.questions.length))*100)}%</span></div><div className={styles.questionButtons}>{workspace.questions.map((item,index) => <button type="button" key={item.id} className={`${index === current ? styles.currentQuestion : ""} ${answered(item, answers[item.id]) ? styles.answeredQuestion : ""}`} onClick={() => setCurrent(index)}><span>{index+1}</span><small>{unsaved[item.id] ? "Not saved" : answered(item, answers[item.id]) ? "Answered" : item.required ? "Required" : "Optional"}</small></button>)}</div><div className={styles.navFooter} aria-live="polite"><span>Autosave</span><strong>{saving && saving !== "submit" ? "Saving…" : unsavedCount > 0 ? `${unsavedCount} not saved` : "Up to date"}</strong></div></aside>
      <main className={styles.questionCanvas}>{question ? <QuestionEditor key={question.id} question={question} value={answers[question.id]} onChange={(value) => void save(question.id,value)} onType={(value) => saveDebounced(question.id,value)} disabled={secondsLeft === 0}/>:null}<footer className={styles.canvasFooter}><button type="button" className={styles.secondaryButton} disabled={current===0} onClick={() => setCurrent((value)=>Math.max(0,value-1))}>Previous</button><div>{current < workspace.questions.length-1 ? <button type="button" className={styles.primaryButton} onClick={() => setCurrent((value)=>Math.min(workspace.questions.length-1,value+1))}>Next question</button> : <button type="button" className={styles.submitButton} disabled={saving==="submit"} onClick={() => submit(false)}>{saving==="submit"?"Submitting…":"Submit assessment"}</button>}</div></footer></main>
    </div>
  </div>;
}

function QuestionEditor({ question, value, onChange, onType, disabled }: { question: AttemptWorkspace["questions"][number]; value: unknown; onChange: (value: unknown) => void; onType: (value: unknown) => void; disabled: boolean }) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const choices = choicesOf(question.options);
  const ordering = orderOf(question.options);
  const matching = matchingOf(question.options);
  const [draftText, setDraftText] = useState(String(object.value ?? ""));
  const blurSave = () => onChange({ value: draftText });

  return <section className={styles.question}><div className={styles.questionHead}><div><span>Question {question.position}</span><em>{question.questionType.replaceAll("_"," ")}</em></div><strong>{question.points} {question.points===1?"point":"points"}</strong></div><h2>{question.prompt}</h2>{question.required ? <p className={styles.required}>Required</p>:null}
    {question.questionType === "single_choice" ? <div className={styles.choiceList}>{choices.map((choice,index)=><label className={`${styles.choice} ${object.value===choice.id?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="radio" name={question.id} checked={object.value===choice.id} onChange={()=>onChange({value:choice.id})}/><span>{String.fromCharCode(65+index)}</span><strong>{choice.label}</strong></label>)}</div>:null}
    {question.questionType === "multiple_choice" ? <div className={styles.choiceList}>{choices.map((choice,index)=>{const selected=Array.isArray(object.values)&&object.values.map(String).includes(choice.id);return <label className={`${styles.choice} ${selected?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="checkbox" checked={selected} onChange={()=>{const current=Array.isArray(object.values)?object.values.map(String):[];onChange({values:selected?current.filter((id)=>id!==choice.id):[...current,choice.id]});}}/><span>{String.fromCharCode(65+index)}</span><strong>{choice.label}</strong></label>;})}</div>:null}
    {question.questionType === "true_false" ? <div className={styles.choiceList}>{choices.map((choice)=><label className={`${styles.choice} ${object.value===(choice.id==="true")?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="radio" name={question.id} checked={object.value===(choice.id==="true")} onChange={()=>onChange({value:choice.id==="true"})}/><strong>{choice.label}</strong></label>)}</div>:null}
    {(question.questionType === "short_text" || question.questionType === "long_text") ? <div className={styles.textAnswer}><textarea disabled={disabled} rows={question.questionType==="long_text"?10:4} value={draftText} onChange={(event)=>{setDraftText(event.target.value);onType({value:event.target.value});}} onBlur={blurSave} placeholder={question.questionType==="long_text"?"Write a clear, complete response…":"Type your answer…"}/><small>Saved automatically as you write.</small></div>:null}
    {question.questionType === "numeric" ? <div className={styles.textAnswer}><input disabled={disabled} type="number" step="any" value={draftText} onChange={(event)=>{setDraftText(event.target.value);onType({value:event.target.value});}} onBlur={blurSave} placeholder="Enter a number"/></div>:null}
    {question.questionType === "ordering" ? <OrderingAnswer items={ordering} current={Array.isArray(object.order)?object.order.map(String):[]} onChange={(order)=>onChange({order})} disabled={disabled}/>:null}
    {question.questionType === "matching" ? (matching.left.length && matching.right.length
      ? <MatchingAnswer questionId={question.id} left={matching.left} right={matching.right} pairs={pairsOf(object)} onChange={(pairs)=>onChange({pairs})} disabled={disabled}/>
      // Not a placeholder for unbuilt UI: a matching question whose options lost
      // a side cannot be answered at all, and saying so beats an empty box the
      // learner would keep staring at.
      : <div className={styles.unsupported}><strong>This question cannot be displayed.</strong><span>Its matching lists are incomplete. Tell your assessor which question number this is — it cannot be answered as authored.</span></div>):null}
  </section>;
}

/**
 * Matching answers, one <select> per left item.
 *
 * A <select> rather than drag-and-drop: it is reachable by keyboard, works on
 * touch, and needs no library. The right list may be longer than the left —
 * the extras are distractors — so options are never consumed by being chosen.
 * Each select is labelled with its own left item, so a screen reader announces
 * what is being matched instead of "combo box".
 */
function MatchingAnswer({questionId,left,right,pairs,onChange,disabled}:{questionId:string;left:Choice[];right:Choice[];pairs:Record<string,string>;onChange:(pairs:Record<string,string>)=>void;disabled:boolean}){
  return <div className={styles.matchList}>{left.map((item,index)=>{
    const selectId=`match-${questionId}-${item.id}`;
    return <div className={styles.matchRow} key={item.id}>
      <span className={styles.matchIndex}>{index+1}</span>
      <label className={styles.matchPrompt} htmlFor={selectId}>{item.label}</label>
      <select id={selectId} className={styles.matchSelect} disabled={disabled} value={pairs[item.id]??""} onChange={(event)=>{
        const next={...pairs};
        // An emptied select must delete the pair, not store "": the kernel
        // compares the pair map against the key key-for-key, and a blank entry
        // would both fail the comparison and count the item as matched.
        if(event.target.value)next[item.id]=event.target.value; else delete next[item.id];
        onChange(next);
      }}>
        <option value="">— choose —</option>
        {right.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </div>;
  })}</div>;
}

function OrderingAnswer({items,current,onChange,disabled}:{items:OrderItem[];current:string[];onChange:(order:string[])=>void;disabled:boolean}){
  const order=current.length?current:items.map((item)=>item.id);
  function move(index:number,direction:-1|1){const next=[...order];const target=index+direction;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target],next[index]];onChange(next);}
  return <div className={styles.orderList}>{order.map((id,index)=>{const item=items.find((candidate)=>candidate.id===id);return <div className={styles.orderItem} key={id}><span>{index+1}</span><strong>{item?.label??id}</strong><div><button disabled={disabled||index===0} type="button" onClick={()=>move(index,-1)}>↑</button><button disabled={disabled||index===order.length-1} type="button" onClick={()=>move(index,1)}>↓</button></div></div>;})}</div>;
}
