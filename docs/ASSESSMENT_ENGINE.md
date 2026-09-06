# Assessment & Exam Engine — P1

This slice turns the learning platform into an assessment system rather than a
course-completion tracker.

## Current P1 scope

- question banks;
- manual/imported/AI-origin questions;
- human review state for questions;
- quiz / exam / practice assessments;
- assessment question ordering and point overrides;
- timed/open/close windows and attempt limits;
- learner attempts and incremental response saving;
- deterministic auto-scoring for objective question types;
- manual marking for long-form/subjective responses;
- final attempt percentage and pass/fail;
- rubric schema for richer marking;
- tenant RLS + lifecycle gate on every assessment table;
- audit events for authoring, publishing, attempts and grading.

## Authoritative grading rule

AI is not an authoritative grader. Objective scoring is deterministic. Subjective
answers remain `submitted` until an authorized human grader records a score.
Future AI marking may propose rubric-aligned scores/feedback, but the proposal is
not the final grade until policy/human approval records it.

## Answer-key boundary

`osa.assessment_questions.answer_key` and `rationale` are author/grader data.
Learner attempt payloads are constructed from an explicit select list containing
only question id, position, type, prompt, options, points and required state.

## Initial role mapping

P1 intentionally uses roles already proven by the P0 authentication model:

- tenant admin / TNA analyst: author;
- assessor / tenant admin: grader;
- learner: attempt.

The database role vocabulary already reserves `learning_admin` and `instructor`
for the next role-model step, but P1 does not make authentication depend on them
until this vertical slice is proven.

## API surfaces

- `GET/POST /api/assessment-banks`
- `POST /api/assessment-questions`
- `GET/POST/PATCH /api/assessments`
- `POST/PATCH /api/assessment-attempts`

## Next acceptance gate

1. Apply migrations 004 then 005 on an isolated database branch.
2. Grant the assessment table matrix to the restricted runtime role.
3. Author one bank, one mixed objective/long-text exam and publish it.
4. Attempt it as a learner.
5. Prove objective responses auto-score correctly.
6. Prove long-text response remains pending until assessor marking.
7. Prove answer keys never appear in learner API/browser payloads.
8. Prove another tenant cannot read assessment, attempt or response rows.
9. Run Chromium journeys and responsive/accessibility checks.
