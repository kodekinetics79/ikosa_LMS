import { expect, Page, Response, test } from '@playwright/test';
import { loginAs } from '../fixtures/session';

/**
 * The five critical assessment journeys, driven through the real browser UI.
 *
 * WHAT CHANGED AND WHY IT MATTERS
 *
 * This file used to be a single API-only walk gated behind
 * `ASSESSMENT_E2E_ENABLED`, which is never set. A permanently-skipped test is
 * not coverage: the engine could have been broken in every release and this
 * suite would have reported green. The gate is gone - the engine now runs
 * against a real PostgreSQL instance in CI, which is the only datastore it has.
 *
 * Nothing here names a fixture identifier. Every id used across the journeys is
 * produced by the run itself (read out of the UI or out of the request the UI
 * made), so the suite asserts the CONTRACT rather than the seed, and a re-run
 * against the same database cannot collide on the unique (tenant_id, code)
 * constraints on banks and assessments.
 */

let sequence = 0;
/** Unique per run AND per call, so a re-run never collides on code uniqueness. */
function runId(): string {
  return `${Date.now().toString(36)}${(sequence += 1)}`.toUpperCase();
}

const RUN = runId();

const BANK_CODE = `E2EBANK-${RUN}`;
const BANK_NAME = `Browser bank ${RUN}`;
const EXAM_CODE = `E2EEXAM-${RUN}`;
const EXAM_TITLE = `Browser mixed exam ${RUN}`;

const OBJECTIVE_PROMPT = `Which access model assigns permissions through job roles? (${RUN})`;
const OBJECTIVE_RATIONALE = `Role-based access control binds permission to duty, not to person (${RUN}).`;
const OBJECTIVE_POINTS = 2;

const ESSAY_PROMPT = `Explain how least privilege reduces operational risk. (${RUN})`;
const ESSAY_RATIONALE = `A strong answer connects reduced permissions to unauthorized action and to blast radius (${RUN}).`;
const ESSAY_POINTS = 8;

const ESSAY_ANSWER =
  `Least privilege ${RUN} limits every account to the permissions its duties require, ` +
  'so a compromised identity can take fewer unauthorized actions and the blast radius of that compromise is smaller.';
const ESSAY_MARK = 6;
const ESSAY_FEEDBACK = `Clear on blast radius; say more about revocation. (${RUN})`;

const PASS_PERCENTAGE = 70;
/** 2 objective + 6 manual out of 10 = 80%, which is above the 70% pass mark. */
const EXPECTED_POINTS = OBJECTIVE_POINTS + ESSAY_MARK;
const EXPECTED_MAX_POINTS = OBJECTIVE_POINTS + ESSAY_POINTS;
const EXPECTED_PERCENTAGE = 80;

/**
 * Answer keys and marker rationales are the material a learner must never
 * receive: possessing either turns an assessment into a lookup.
 */
const LEARNER_FORBIDDEN = ['answerKey', 'answer_key', 'rationale', OBJECTIVE_RATIONALE, ESSAY_RATIONALE];

/** Discovered by the journeys, then shared forward. Nothing here is a literal. */
const world = {
  authorOrgUnitId: '',
  assessmentId: '',
  attemptId: '',
  responseId: ''
};

/** A session change must destroy the old one; a stale cookie hides scope bugs. */
async function signOut(page: Page): Promise<void> {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  await page.context().clearCookies();
}

function assessmentsPatch(response: Response): boolean {
  return response.url().includes('/api/assessments') && response.request().method() === 'PATCH';
}

function attemptsCall(method: 'POST' | 'PATCH'): (response: Response) => boolean {
  return (response) => response.url().includes('/api/assessment-attempts') && response.request().method() === method;
}

test.describe.serial('Assessment engine', () => {
  /* ---------------------------------------------------------------------
   * 1. Author.
   *
   * Everything below is done with the mouse and keyboard through
   * /assessments. The authoring API is already covered by the integration
   * suite; what is NOT covered anywhere else is that the studio actually
   * wires those calls up, which is what a learner's exam depends on.
   * ------------------------------------------------------------------ */
  test('@critical author creates a bank, an objective and an essay question, an exam, and publishes it', async ({ page }) => {
    await loginAs(page, 'analyst');
    // The author's own org unit, read back from their session. The cross-tenant
    // journey later re-uses it to prove a foreign caller cannot write into it.
    world.authorOrgUnitId = (await (await page.request.get('/api/auth/session')).json()).user.orgUnitId;
    expect(world.authorOrgUnitId).toBeTruthy();

    await page.goto('/assessments');
    await expect(page.getByRole('heading', { name: /design, deliver and grade/i })).toBeVisible();

    // --- question bank ---------------------------------------------------
    await page.getByRole('tab', { name: /question library/i }).click();
    await page.getByRole('button', { name: /^new bank$/i }).click();
    const bankDialog = page.getByRole('dialog');
    await bankDialog.getByLabel(/^code$/i).fill(BANK_CODE);
    await bankDialog.getByLabel(/bank name/i).fill(BANK_NAME);
    await bankDialog.getByLabel(/^description$/i).fill('Disposable bank created by the browser journey.');
    await bankDialog.getByRole('button', { name: /^create bank$/i }).click();
    await expect(bankDialog).toHaveCount(0);
    await expect(page.getByText(BANK_CODE, { exact: true })).toBeVisible();

    // --- objective question ----------------------------------------------
    await page.getByRole('button', { name: /^new question$/i }).click();
    const objectiveDialog = page.getByRole('dialog');
    await objectiveDialog.getByLabel(/question bank/i).selectOption({ label: BANK_NAME });
    await objectiveDialog.getByLabel(/question type/i).selectOption('single_choice');
    await objectiveDialog.getByLabel(/^prompt$/i).fill(OBJECTIVE_PROMPT);
    await objectiveDialog.getByLabel(/^options/i).fill('RBAC\nShared passwords\nPublic access');
    await objectiveDialog.getByLabel(/^correct answer/i).fill('1');
    await objectiveDialog.getByLabel(/^points$/i).fill(String(OBJECTIVE_POINTS));
    await objectiveDialog.getByLabel(/^difficulty/i).selectOption('2');
    await objectiveDialog.getByLabel(/bloom level/i).selectOption('understand');
    await objectiveDialog.getByLabel(/rationale/i).fill(OBJECTIVE_RATIONALE);
    await objectiveDialog.getByRole('button', { name: /create approved question/i }).click();
    await expect(objectiveDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: OBJECTIVE_PROMPT })).toBeVisible();

    // --- essay question ---------------------------------------------------
    await page.getByRole('button', { name: /^new question$/i }).click();
    const essayDialog = page.getByRole('dialog');
    await essayDialog.getByLabel(/question bank/i).selectOption({ label: BANK_NAME });
    await essayDialog.getByLabel(/question type/i).selectOption('long_text');
    // A long-text question has no key to enter, and the studio must stop asking
    // for one: an essay with an "answer" would be autoscored against a string.
    await expect(essayDialog.getByLabel(/^correct answer/i)).toHaveCount(0);
    await essayDialog.getByLabel(/^prompt$/i).fill(ESSAY_PROMPT);
    await essayDialog.getByLabel(/^points$/i).fill(String(ESSAY_POINTS));
    await essayDialog.getByLabel(/^difficulty/i).selectOption('3');
    await essayDialog.getByLabel(/bloom level/i).selectOption('analyze');
    await essayDialog.getByLabel(/rationale/i).fill(ESSAY_RATIONALE);
    await essayDialog.getByRole('button', { name: /create approved question/i }).click();
    await expect(essayDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: ESSAY_PROMPT })).toBeVisible();

    // --- the exam ---------------------------------------------------------
    await page.getByRole('button', { name: /^create assessment$/i }).click();
    const examDialog = page.getByRole('dialog');
    await examDialog.getByLabel(/^code$/i).fill(EXAM_CODE);
    await examDialog.getByLabel(/^title$/i).fill(EXAM_TITLE);
    await examDialog.getByLabel(/^description$/i).fill('One objective question and one essay.');
    await examDialog.getByLabel(/^type/i).selectOption('exam');
    await examDialog.getByLabel(/duration/i).fill('30');
    await examDialog.getByLabel(/pass percentage/i).fill(String(PASS_PERCENTAGE));
    // Two attempts: the secrecy journey later opens a second, live attempt so it
    // can inspect a real rendered player rather than a remembered one.
    await examDialog.getByLabel(/attempt limit/i).fill('2');
    await examDialog.getByLabel(/^feedback/i).selectOption('after_submit');
    await examDialog.getByRole('button', { name: /create draft/i }).click();
    await expect(examDialog).toHaveCount(0);

    // --- attach and publish, in the assessment builder --------------------
    await page.getByRole('tab', { name: /^assessments$/i }).click();
    const card = page.locator('article').filter({ hasText: EXAM_CODE });
    await expect(card).toContainText('Draft');
    await card.getByRole('link', { name: /open builder/i }).click();
    await expect(page.getByRole('heading', { name: EXAM_TITLE, level: 1 })).toBeVisible();

    // The builder's own URL carries the assessment's real id. Reading it here is
    // how every later journey addresses this exam without writing an id down.
    world.assessmentId = new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? '';
    expect(world.assessmentId, 'the builder is addressed by the assessment id').toMatch(/^[0-9a-f-]{36}$/i);

    // An assessment with no questions must be unpublishable AND must say why.
    // A disabled button with no stated reason is a dead end for the author.
    const readiness = page.getByRole('region', { name: /publish readiness/i });
    await expect(readiness).toContainText(/add at least one question/i);
    await expect(page.getByRole('button', { name: /^publish$/i })).toBeDisabled();

    const questionsPanel = page.getByRole('region', { name: 'Questions' });
    const library = page.getByRole('region', { name: /add from your library/i });
    // Filter to this run's questions: the library accumulates across runs and
    // only the first 50 matches are offered.
    await library.getByRole('searchbox', { name: /search questions/i }).fill(RUN);
    for (const prompt of [OBJECTIVE_PROMPT, ESSAY_PROMPT]) {
      const attaching = page.waitForResponse(assessmentsPatch);
      await library.getByRole('listitem').filter({ hasText: prompt }).getByRole('button', { name: 'Add' }).click();
      const attached = await attaching;
      expect(attached.status(), await attached.text()).toBe(200);
      await expect(questionsPanel.getByRole('listitem').filter({ hasText: prompt })).toHaveCount(1);
    }

    await expect(questionsPanel).toContainText('2 items');
    await expect(questionsPanel).toContainText(`${EXPECTED_MAX_POINTS} points`);
    // The machine/human split is decided here and nowhere else. If the essay
    // were classified auto-scored it would never reach a marker, and a learner
    // would be given a final percentage for an answer nobody read.
    await expect(questionsPanel.getByRole('listitem').filter({ hasText: OBJECTIVE_PROMPT })).toContainText('Auto-scored');
    await expect(questionsPanel.getByRole('listitem').filter({ hasText: ESSAY_PROMPT })).toContainText('Human marking');

    await expect(readiness).toContainText(/ready to publish/i);
    const publishing = page.waitForResponse(assessmentsPatch);
    await page.getByRole('button', { name: /^publish$/i }).click();
    const publishResponse = await publishing;
    expect(publishResponse.status(), await publishResponse.text()).toBe(200);
    await expect(page.getByRole('status')).toContainText(/learners in scope can now start it/i);

    // A published assessment is no longer editable in place: the publish action
    // is replaced by an explicit way back to draft, not left available to click
    // twice.
    await expect(page.getByRole('button', { name: /^publish$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /return to draft/i })).toBeVisible();

    // Re-read the list from the server rather than trusting client state: the
    // workspace card's counters are updated locally, so asserting them without
    // a fresh render would pass even if nothing had been persisted.
    await page.goto('/assessments');
    const persisted = page.locator('article').filter({ hasText: EXAM_CODE });
    await expect(persisted).toContainText('Published');
    await expect(persisted).toContainText('2 questions');
  });

  /* ---------------------------------------------------------------------
   * 2. Learner.
   * ------------------------------------------------------------------ */
  test('@critical learner sits the exam; the objective item autoscores and the essay stays pending marking', async ({ page }) => {
    await signOut(page);
    await loginAs(page, 'learner');
    await page.goto('/assessments');

    const card = page.locator('article').filter({ hasText: EXAM_CODE });
    await expect(card.getByRole('heading', { name: EXAM_TITLE })).toBeVisible();

    const starting = page.waitForResponse(attemptsCall('POST'));
    await card.getByRole('link', { name: /start|continue/i }).click();
    const startResponse = await starting;
    expect(startResponse.status(), await startResponse.text()).toBe(201);
    const workspace = await startResponse.json();
    world.attemptId = workspace.attempt.id;
    expect(world.attemptId).toBeTruthy();

    // The deadline is stated by the server against the server's own clock. A
    // learner who sets their device clock back must not get extra time.
    expect(workspace.deadlineAt).toBeTruthy();
    expect(workspace.serverNow).toBeTruthy();
    expect(Date.parse(workspace.deadlineAt)).toBeGreaterThan(Date.parse(workspace.serverNow));

    await expect(page.getByRole('heading', { name: OBJECTIVE_PROMPT })).toBeVisible();
    // The radio itself is styled away and the choice card sits on top of it, so
    // click the card - which is what a learner clicks - and then assert the
    // control underneath actually changed state.
    const savingObjective = page.waitForResponse(attemptsCall('PATCH'));
    await page.locator('label').filter({ hasText: 'RBAC' }).click();
    await expect(page.getByRole('radio', { name: /RBAC/ })).toBeChecked();
    expect((await savingObjective).status()).toBe(200);

    await page.getByRole('button', { name: /next question/i }).click();
    await expect(page.getByRole('heading', { name: ESSAY_PROMPT })).toBeVisible();
    const essayBox = page.getByPlaceholder(/write a clear, complete response/i);
    await essayBox.fill(ESSAY_ANSWER);
    const savingEssay = page.waitForResponse(attemptsCall('PATCH'));
    await essayBox.blur();
    expect((await savingEssay).status()).toBe(200);

    page.once('dialog', (dialog) => dialog.accept());
    const submitting = page.waitForResponse(attemptsCall('PATCH'));
    await page.getByRole('button', { name: /submit assessment/i }).click();
    const submitResponse = await submitting;
    expect(submitResponse.status(), await submitResponse.text()).toBe(200);
    const submitted = await submitResponse.json();

    // The objective half is machine-scored on submit; the essay is not, so the
    // attempt must stop at `submitted` with NO percentage. Publishing a
    // percentage here would present a half-marked paper as a final result.
    expect(submitted.attempt.status).toBe('submitted');
    expect(submitted.attempt.scorePoints).toBe(OBJECTIVE_POINTS);
    expect(submitted.attempt.maxPoints).toBe(EXPECTED_MAX_POINTS);
    expect(submitted.attempt.percentage).toBeNull();
    expect(submitted.attempt.passed).toBeNull();

    // And the learner is told exactly that, rather than shown a provisional score.
    await expect(page.getByRole('heading', { name: /your assessment has been submitted/i })).toBeVisible();
    await expect(page.getByText(/waiting for an authorized human marker/i)).toBeVisible();
    await expect(page.getByText('Human marking', { exact: true })).toBeVisible();
    await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  });

  /* ---------------------------------------------------------------------
   * 4. Tenant isolation.
   *
   * Deliberately placed BEFORE marking. The marking record only exists while
   * the attempt is `submitted`, so this is the one window in which "the other
   * tenant cannot see it" is a real check rather than a check against a queue
   * that is empty for everybody. It also makes the cross-tenant grade refusal
   * unambiguous: the response IS markable right now, so a 404 can only be
   * about tenancy, not about an already-finalized attempt.
   * ------------------------------------------------------------------ */
  test('@critical a second tenant cannot reach the assessment, the attempt, the responses or the marking record', async ({ page }) => {
    // Positive control first. Without it, every "the other tenant sees nothing"
    // assertion below would also pass if nothing existed to see - which is
    // exactly how an isolation test rots into a tautology.
    await signOut(page);
    await loginAs(page, 'manager');
    const ownQueue = (await (await page.request.get('/api/assessment-marking')).json()).items as {
      attemptId: string; responseId: string; questionType: string; maxPoints: number;
    }[];
    const ownItem = ownQueue.find((item) => item.attemptId === world.attemptId);
    expect(ownItem, 'the submitted essay is markable right now by its own tenant').toBeTruthy();
    expect(ownItem!.questionType).toBe('long_text');
    expect(ownItem!.maxPoints).toBe(ESSAY_POINTS);
    world.responseId = ownItem!.responseId;

    await signOut(page);
    await loginAs(page, 'gulfAdmin');
    const foreign = await (await page.request.get('/api/auth/session')).json();
    expect(foreign.tenant.slug).not.toBe('northstar');
    // A Gulf tenant administrator holds BOTH authoring and grading permission in
    // their own workspace, so every refusal below is about tenancy and not about
    // a missing role - which is the only version of this test worth running.
    expect(foreign.user.roles).toContain('tenant_admin');

    await page.goto('/assessments');
    await expect(page.getByRole('tab', { name: /^assessments$/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: EXAM_TITLE })).toHaveCount(0);

    await page.getByRole('tab', { name: /question library/i }).click();
    await expect(page.getByText(BANK_CODE, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: OBJECTIVE_PROMPT })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: ESSAY_PROMPT })).toHaveCount(0);

    await page.getByRole('tab', { name: /^marking/i }).click();
    await expect(page.getByRole('heading', { name: EXAM_TITLE })).toHaveCount(0);
    await expect(page.getByText(ESSAY_ANSWER)).toHaveCount(0);

    // The RSC payload, not only what is painted: a leak that arrives in the
    // flight data and is merely not rendered is still a leak.
    const rendered = await page.content();
    for (const secret of [EXAM_CODE, EXAM_TITLE, BANK_CODE, OBJECTIVE_PROMPT, ESSAY_PROMPT, ESSAY_ANSWER, world.assessmentId, world.attemptId]) {
      expect(rendered, `${secret} reached the foreign tenant's page`).not.toContain(secret);
    }

    const assessments = await page.request.get('/api/assessments');
    expect(assessments.status()).toBe(200);
    const visible = (await assessments.json()).items as { id: string }[];
    expect(visible.some((item) => item.id === world.assessmentId)).toBe(false);

    const marking = await page.request.get('/api/assessment-marking');
    expect(marking.status()).toBe(200);
    const queue = (await marking.json()).items as { attemptId: string; responseId: string }[];
    expect(queue.some((item) => item.attemptId === world.attemptId)).toBe(false);

    // No UI can address another tenant's response id - the studio only ever
    // renders ids it was given - so the direct-object probe below has to be an
    // API call. There is no "grade an arbitrary response" screen, by design.
    // The response is markable at this instant (asserted above), so a refusal
    // here can only be about tenancy.
    const csrf = foreign.csrfToken as string;
    const crossTenantGrade = await page.request.patch('/api/assessment-attempts', {
      headers: { 'x-csrf-token': csrf },
      data: { action: 'grade_response', responseId: world.responseId, score: ESSAY_POINTS, feedback: 'cross-tenant' }
    });
    expect(crossTenantGrade.status(), await crossTenantGrade.text()).toBe(404);

    // Supplying a foreign org unit must not widen scope either: this is the
    // write-side twin of the read-side checks above.
    const northstarOrgProbe = await page.request.post('/api/assessment-banks', {
      headers: { 'x-csrf-token': csrf },
      data: { orgUnitId: world.authorOrgUnitId, code: `XT-${runId()}`, name: 'Cross-tenant bank', description: '' }
    });
    expect(northstarOrgProbe.status(), await northstarOrgProbe.text()).toBe(403);
  });

  /* ---------------------------------------------------------------------
   * 3. Assessor.
   * ------------------------------------------------------------------ */
  test('@critical assessor marks the essay, finalizes the attempt, and the ledger records it', async ({ page }) => {
    await signOut(page);
    await loginAs(page, 'manager');
    await page.goto('/assessments');
    await page.getByRole('tab', { name: /^marking/i }).click();

    const markingCard = page.locator('article').filter({ hasText: EXAM_CODE });
    await expect(markingCard).toHaveCount(1);
    await expect(markingCard).toContainText(ESSAY_PROMPT);
    await expect(markingCard).toContainText(ESSAY_ANSWER);
    // The rationale is marker guidance. It belongs here and nowhere a learner
    // can reach - the secrecy journey asserts the other half of that rule.
    await expect(markingCard).toContainText(ESSAY_RATIONALE);
    // Only the subjective item is queued. If the autoscored question also
    // appeared, human marking would be being asked for work already done.
    await expect(markingCard).not.toContainText(OBJECTIVE_PROMPT);

    await markingCard.getByLabel(/^score/i).fill(String(ESSAY_MARK));
    await markingCard.getByLabel(/^feedback$/i).fill(ESSAY_FEEDBACK);

    const grading = page.waitForResponse(attemptsCall('PATCH'));
    await markingCard.getByRole('button', { name: /save mark/i }).click();
    const gradeResponse = await grading;
    expect(gradeResponse.status(), await gradeResponse.text()).toBe(200);
    // The studio must submit the mark against the response the queue actually
    // listed. Grading the wrong row would still return 200 and still clear the
    // card, so the only way to catch it is to compare the ids.
    expect(gradeResponse.request().postDataJSON().responseId).toBe(world.responseId);

    const graded = await gradeResponse.json();
    expect(graded.attempt.status).toBe('graded');
    expect(graded.attempt.scorePoints).toBe(EXPECTED_POINTS);
    expect(graded.attempt.maxPoints).toBe(EXPECTED_MAX_POINTS);
    expect(graded.attempt.percentage).toBe(EXPECTED_PERCENTAGE);
    expect(graded.attempt.passed).toBe(true);
    expect(EXPECTED_PERCENTAGE).toBeGreaterThanOrEqual(PASS_PERCENTAGE);

    // A cleared item must leave the queue, or the same paper gets marked twice.
    await expect(markingCard).toHaveCount(0);

    await signOut(page);
    await loginAs(page, 'admin');
    await page.goto('/audit');
    const integrity = page.locator('.metric').filter({ hasText: 'Ledger integrity' });
    await expect(integrity).toContainText('Verified');

    // The marking decision is visible in the audit room itself, keyed on the
    // response it graded rather than on "a grade event happened somewhere".
    const ledger = page.getByRole('region', { name: /audit event ledger/i });
    await expect(ledger.getByRole('row').filter({ hasText: world.responseId })).toContainText('assessment.response.grade');

    // The submission is older than the audit room's 25-row window can be relied
    // on to hold, so it is asserted against the same ledger through the JSON
    // view the page itself links to.
    const ledgerJson = await page.request.get('/api/audit?limit=500');
    expect(ledgerJson.status()).toBe(200);
    const events = await ledgerJson.json();
    expect(events.integrity.valid, 'the chain verifies under the secret that signed it').toBe(true);
    expect(
      events.items.some((event: { action: string; resourceId: string }) =>
        event.action === 'assessment.attempt.submit' && event.resourceId === world.attemptId)
    ).toBe(true);
    expect(
      events.items.some((event: { action: string; resourceId: string }) =>
        event.action === 'assessment.response.grade' && event.resourceId === world.responseId)
    ).toBe(true);
  });

  /* ---------------------------------------------------------------------
   * 5. Answer-key secrecy.
   * ------------------------------------------------------------------ */
  test('@critical no answer key or rationale reaches the learner, in the API or in the rendered page', async ({ page }) => {
    await signOut(page);
    await loginAs(page, 'learner');
    await page.goto('/assessments');

    const card = page.locator('article').filter({ hasText: EXAM_CODE });
    const starting = page.waitForResponse(attemptsCall('POST'));
    await card.getByRole('link', { name: /start|continue/i }).click();
    const startResponse = await starting;
    expect(startResponse.status(), await startResponse.text()).toBe(201);

    // 1. The learner-facing API payload, as raw text so a key nested at any
    //    depth is caught, not only one at the top level.
    const payloadText = await startResponse.text();
    for (const secret of LEARNER_FORBIDDEN) {
      expect(payloadText, `"${secret}" reached the learner in the attempt payload`).not.toContain(secret);
    }
    const payload = JSON.parse(payloadText);
    expect(payload.questions.length).toBe(2);
    for (const question of payload.questions) {
      expect(Object.keys(question)).not.toContain('answerKey');
      expect(Object.keys(question)).not.toContain('rationale');
    }
    // The options ARE delivered - a learner needs something to choose between -
    // so this is not passing merely because the payload is empty.
    const objective = payload.questions.find((item: { questionType: string }) => item.questionType === 'single_choice');
    expect(objective.options.choices.map((choice: { label: string }) => choice.label)).toContain('RBAC');

    // 2. The rendered player, including the RSC flight payload inlined in it.
    await expect(page.getByRole('heading', { name: OBJECTIVE_PROMPT })).toBeVisible();
    const player = await page.content();
    expect(player, 'the player renders the question it is hiding the key for').toContain('RBAC');
    for (const secret of LEARNER_FORBIDDEN) {
      expect(player, `"${secret}" reached the learner in the rendered attempt page`).not.toContain(secret);
    }

    // 3. The assessment list the learner lands on, both rendered and over the API.
    await page.goto('/assessments');
    await expect(page.getByRole('heading', { name: EXAM_TITLE })).toBeVisible();
    const list = await page.content();
    for (const secret of LEARNER_FORBIDDEN) {
      expect(list, `"${secret}" reached the learner in the rendered assessment list`).not.toContain(secret);
    }
    const listApi = await (await page.request.get('/api/assessments')).text();
    for (const secret of LEARNER_FORBIDDEN) {
      expect(listApi, `"${secret}" reached the learner from /api/assessments`).not.toContain(secret);
    }

    // 4. The authoring and marking surfaces are not merely hidden in the UI:
    //    a learner asking for them directly must be refused.
    expect((await page.request.get('/api/assessment-questions')).status()).toBe(403);
    expect((await page.request.get('/api/assessment-marking')).status()).toBe(403);
  });
});
