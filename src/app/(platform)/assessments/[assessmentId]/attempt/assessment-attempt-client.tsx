"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttemptWorkspace } from "@/lib/server/assessment-store";
import type { QuestionType } from "@/lib/server/domain";
import styles from "./attempt.module.css";

type ApiProblem = { error?: string; fields?: Record<string, string> };
type AnswerMap = Record<string, unknown>;

type Choice = { id: string; label: string };
type OrderItem = { id: string; label: string };

function problem(payload: ApiProblem, fallback: string): string {
  return payload.error ?? (payload.fields ? Object.values(payload.fields)[0] : undefined) ?? fallback;
}

function choicesOf(options: unknown): Choice[] {
  if (!options || typeof options !== "object") return [];
  const value = (options as Record<string, unknown>).choices;
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: String(object.id ?? `o${index + 1}`), label: String(object.label ?? object.text ?? `Option ${index + 1}`) };
  });
}

function orderOf(options: unknown): OrderItem[] {
  if (!options || typeof options !== "object") return [];
  const value = (options as Record<string, unknown>).items;
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: String(object.id ?? `o${index + 1}`), label: String(object.label ?? object.text ?? `Item ${index + 1}`) };
  });
}

function answered(type: QuestionType, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (type === "multiple_choice") return Array.isArray(object.values) && object.values.length > 0;
  if (type === "ordering") return Array.isArray(object.order) && object.order.length > 0;
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
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AttemptWorkspace["attempt"] | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const submittedRef = useRef(false);

  const start = useCallback(async () => {
    setLoading(true); setError("");
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
      if (payload.assessment.durationMinutes) {
        const elapsed = Math.floor((Date.now() - Date.parse(payload.attempt.startedAt)) / 1000);
        setSecondsLeft(Math.max(0, payload.assessment.durationMinutes * 60 - elapsed));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start assessment"); }
    finally { setLoading(false); }
  }, [assessmentId, csrfToken]);

  useEffect(() => { void start(); }, [start]);

  const submit = useCallback(async (automatic = false) => {
    if (!workspace || submittedRef.current) return;
    if (!automatic) {
      const missing = workspace.questions.filter((question) => question.required && !answered(question.questionType, answers[question.id]));
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

  async function save(questionId: string, responseValue: unknown) {
    if (!workspace || result || secondsLeft === 0) return;
    setAnswers((currentAnswers) => ({ ...currentAnswers, [questionId]: responseValue }));
    setSaving(questionId);
    try {
      const response = await fetch("/api/assessment-attempts", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "save_response", attemptId: workspace.attempt.id, questionId, response: responseValue }),
      });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(problem(payload, "Unable to save answer"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save answer"); }
    finally { setSaving(null); }
  }

  const answeredCount = useMemo(() => workspace ? workspace.questions.filter((question) => answered(question.questionType, answers[question.id])).length : 0, [answers, workspace]);
  const question = workspace?.questions[current];

  if (loading) return <div className={styles.loading}><div className={styles.spinner}/><strong>Preparing your assessment…</strong><span>Opening the latest saved attempt and question set.</span></div>;
  if (!workspace) return <div className={styles.failure}><strong>Assessment unavailable</strong><p>{error || "This assessment cannot be opened right now."}</p><Link href="/assessments">Return to assessments</Link></div>;

  if (result) {
    const pending = result.status === "submitted";
    return <div className={styles.resultPage}><section className={styles.resultCard}><div className={pending ? styles.pendingMark : styles.completeMark}>{pending ? "Human marking" : result.passed ? "Passed" : "Completed"}</div><h1>{pending ? "Your assessment has been submitted." : result.passed ? "Assessment passed." : "Assessment graded."}</h1><p>{pending ? "Objective questions have been scored. One or more subjective answers are now waiting for an authorized human marker; no AI score has been published as final." : `Your final score is ${result.percentage ?? 0}%. The pass mark was ${workspace.assessment.passPercentage}%.`}</p><div className={styles.resultStats}><span><strong>{result.scorePoints ?? "—"}</strong>points earned</span><span><strong>{result.maxPoints ?? "—"}</strong>points available</span><span><strong>{result.percentage === null ? "Pending" : `${result.percentage}%`}</strong>final percentage</span></div><Link className={styles.primaryLink} href="/assessments">Back to assessments</Link></section></div>;
  }

  return <div className={styles.player}>
    <header className={styles.playerHeader}><div><Link href="/assessments">← Assessments</Link><span>{workspace.assessment.code}</span><h1>{workspace.assessment.title}</h1></div><div className={styles.headerStats}><span><small>Progress</small><strong>{answeredCount}/{workspace.questions.length}</strong></span>{secondsLeft !== null ? <span className={secondsLeft < 300 ? styles.timeUrgent : ""}><small>Time left</small><strong>{formatTime(secondsLeft)}</strong></span> : null}</div></header>
    {error ? <div className={styles.error} role="alert">{error}<button onClick={() => setError("")} type="button">×</button></div> : null}
    <div className={styles.playerGrid}>
      <aside className={styles.questionNav}><div className={styles.navTitle}>Questions <span>{Math.round((answeredCount / Math.max(1,workspace.questions.length))*100)}%</span></div><div className={styles.questionButtons}>{workspace.questions.map((item,index) => <button type="button" key={item.id} className={`${index === current ? styles.currentQuestion : ""} ${answered(item.questionType, answers[item.id]) ? styles.answeredQuestion : ""}`} onClick={() => setCurrent(index)}><span>{index+1}</span><small>{answered(item.questionType, answers[item.id]) ? "Answered" : item.required ? "Required" : "Optional"}</small></button>)}</div><div className={styles.navFooter}><span>Autosave</span><strong>{saving && saving !== "submit" ? "Saving…" : "Up to date"}</strong></div></aside>
      <main className={styles.questionCanvas}>{question ? <QuestionEditor question={question} value={answers[question.id]} onChange={(value) => save(question.id,value)} disabled={secondsLeft === 0}/>:null}<footer className={styles.canvasFooter}><button type="button" className={styles.secondaryButton} disabled={current===0} onClick={() => setCurrent((value)=>Math.max(0,value-1))}>Previous</button><div>{current < workspace.questions.length-1 ? <button type="button" className={styles.primaryButton} onClick={() => setCurrent((value)=>Math.min(workspace.questions.length-1,value+1))}>Next question</button> : <button type="button" className={styles.submitButton} disabled={saving==="submit"} onClick={() => submit(false)}>{saving==="submit"?"Submitting…":"Submit assessment"}</button>}</div></footer></main>
    </div>
  </div>;
}

function QuestionEditor({ question, value, onChange, disabled }: { question: AttemptWorkspace["questions"][number]; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const choices = choicesOf(question.options);
  const ordering = orderOf(question.options);
  const [draftText, setDraftText] = useState(String(object.value ?? ""));
  const blurSave = () => onChange({ value: draftText });

  return <section className={styles.question}><div className={styles.questionHead}><div><span>Question {question.position}</span><em>{question.questionType.replaceAll("_"," ")}</em></div><strong>{question.points} {question.points===1?"point":"points"}</strong></div><h2>{question.prompt}</h2>{question.required ? <p className={styles.required}>Required</p>:null}
    {question.questionType === "single_choice" ? <div className={styles.choiceList}>{choices.map((choice,index)=><label className={`${styles.choice} ${object.value===choice.id?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="radio" name={question.id} checked={object.value===choice.id} onChange={()=>onChange({value:choice.id})}/><span>{String.fromCharCode(65+index)}</span><strong>{choice.label}</strong></label>)}</div>:null}
    {question.questionType === "multiple_choice" ? <div className={styles.choiceList}>{choices.map((choice,index)=>{const selected=Array.isArray(object.values)&&object.values.map(String).includes(choice.id);return <label className={`${styles.choice} ${selected?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="checkbox" checked={selected} onChange={()=>{const current=Array.isArray(object.values)?object.values.map(String):[];onChange({values:selected?current.filter((id)=>id!==choice.id):[...current,choice.id]});}}/><span>{String.fromCharCode(65+index)}</span><strong>{choice.label}</strong></label>;})}</div>:null}
    {question.questionType === "true_false" ? <div className={styles.choiceList}>{choices.map((choice)=><label className={`${styles.choice} ${object.value===(choice.id==="true")?styles.choiceSelected:""}`} key={choice.id}><input disabled={disabled} type="radio" name={question.id} checked={object.value===(choice.id==="true")} onChange={()=>onChange({value:choice.id==="true"})}/><strong>{choice.label}</strong></label>)}</div>:null}
    {(question.questionType === "short_text" || question.questionType === "long_text") ? <div className={styles.textAnswer}><textarea disabled={disabled} rows={question.questionType==="long_text"?10:4} value={draftText} onChange={(event)=>setDraftText(event.target.value)} onBlur={blurSave} placeholder={question.questionType==="long_text"?"Write a clear, complete response…":"Type your answer…"}/><small>Your response saves when you leave this field.</small></div>:null}
    {question.questionType === "numeric" ? <div className={styles.textAnswer}><input disabled={disabled} type="number" step="any" value={draftText} onChange={(event)=>setDraftText(event.target.value)} onBlur={blurSave} placeholder="Enter a number"/></div>:null}
    {question.questionType === "ordering" ? <OrderingAnswer items={ordering} current={Array.isArray(object.order)?object.order.map(String):[]} onChange={(order)=>onChange({order})} disabled={disabled}/>:null}
    {question.questionType === "matching" ? <div className={styles.unsupported}><strong>Matching response UI is being finalized.</strong><span>This question type is supported by the engine but is not enabled for learner delivery in this P1 slice.</span></div>:null}
  </section>;
}

function OrderingAnswer({items,current,onChange,disabled}:{items:OrderItem[];current:string[];onChange:(order:string[])=>void;disabled:boolean}){
  const order=current.length?current:items.map((item)=>item.id);
  function move(index:number,direction:-1|1){const next=[...order];const target=index+direction;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target],next[index]];onChange(next);}
  return <div className={styles.orderList}>{order.map((id,index)=>{const item=items.find((candidate)=>candidate.id===id);return <div className={styles.orderItem} key={id}><span>{index+1}</span><strong>{item?.label??id}</strong><div><button disabled={disabled||index===0} type="button" onClick={()=>move(index,-1)}>↑</button><button disabled={disabled||index===order.length-1} type="button" onClick={()=>move(index,1)}>↓</button></div></div>;})}</div>;
}
