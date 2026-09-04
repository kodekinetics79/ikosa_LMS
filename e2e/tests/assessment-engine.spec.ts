import { expect, test } from '@playwright/test';
import { apiLogin, writeHeaders } from '../fixtures/api-session';

const enabled = process.env.ASSESSMENT_E2E_ENABLED === 'true';

async function logout(page: import('@playwright/test').Page) {
  await page.request.post('/api/auth/logout');
  await page.context().clearCookies();
}

test.describe('Assessment engine — configured PostgreSQL journey', () => {
  test.skip(!enabled, 'Set ASSESSMENT_E2E_ENABLED=true only against a disposable database with migrations 004-006 applied.');

  test('@assessment author → learner → assessor mixed exam', async ({ page }) => {
    const suffix = Date.now().toString(36).toUpperCase();
    const title = `Browser Mixed Exam ${suffix}`;

    // Author as the seeded TNA analyst. Their org is an ancestor of the learner,
    // so a published assessment is available down the organization tree.
    const author = await apiLogin(page, 'analyst@northstar.example', 'northstar');
    const authorSession = await page.request.get('/api/auth/session');
    expect(authorSession.status()).toBe(200);
    const authorBody = await authorSession.json();
    const orgUnitId = authorBody.user.orgUnitId as string;

    const bankResponse = await page.request.post('/api/assessment-banks', {
      headers: writeHeaders(author),
      data: { orgUnitId, code: `B-${suffix}`, name: `Browser Bank ${suffix}`, description: 'Disposable browser-assessment fixture' },
    });
    expect(bankResponse.status(), await bankResponse.text()).toBe(201);
    const bank = await bankResponse.json();

    const objectiveResponse = await page.request.post('/api/assessment-questions', {
      headers: writeHeaders(author),
      data: {
        bankId: bank.id,
        questionType: 'single_choice',
        prompt: 'Which access model assigns permissions through job roles?',
        options: { choices: [{ id: 'o1', label: 'RBAC' }, { id: 'o2', label: 'Shared passwords' }, { id: 'o3', label: 'Public access' }] },
        answerKey: { value: 'o1' },
        rationale: 'RBAC is role-based access control.',
        points: 2,
        difficulty: 2,
        bloomLevel: 'understand',
        origin: 'manual',
        reviewStatus: 'approved',
      },
    });
    expect(objectiveResponse.status(), await objectiveResponse.text()).toBe(201);
    const objective = await objectiveResponse.json();

    const essayResponse = await page.request.post('/api/assessment-questions', {
      headers: writeHeaders(author),
      data: {
        bankId: bank.id,
        questionType: 'long_text',
        prompt: 'Explain how least privilege reduces operational risk.',
        options: {},
        answerKey: {},
        rationale: 'Strong answers discuss reduced permissions, unauthorized action and blast radius.',
        points: 8,
        difficulty: 3,
        bloomLevel: 'analyze',
        origin: 'manual',
        reviewStatus: 'approved',
      },
    });
    expect(essayResponse.status(), await essayResponse.text()).toBe(201);
    const essay = await essayResponse.json();

    const assessmentResponse = await page.request.post('/api/assessments', {
      headers: writeHeaders(author),
      data: {
        orgUnitId,
        code: `E-${suffix}`,
        title,
        description: 'Disposable mixed objective and essay assessment',
        assessmentType: 'exam',
        durationMinutes: 30,
        passPercentage: 70,
        attemptLimit: 1,
        feedbackMode: 'after_submit',
      },
    });
    expect(assessmentResponse.status(), await assessmentResponse.text()).toBe(201);
    const assessment = await assessmentResponse.json();

    for (const questionId of [objective.id, essay.id]) {
      const attach = await page.request.patch('/api/assessments', {
        headers: writeHeaders(author),
        data: { action: 'attach_question', assessmentId: assessment.id, questionId },
      });
      expect(attach.status(), await attach.text()).toBe(200);
    }
    const publish = await page.request.patch('/api/assessments', {
      headers: writeHeaders(author),
      data: { action: 'publish', assessmentId: assessment.id },
    });
    expect(publish.status(), await publish.text()).toBe(200);
    await logout(page);

    // Learner takes the published assessment through the actual rendered player.
    await page.goto('/login');
    await page.getByLabel(/^workspace$/i).fill('northstar');
    await page.getByLabel(/work email/i).fill('technician@northstar.example');
    await page.getByLabel(/^password/i).fill('Demo!2026');
    await page.getByRole('button', { name: /sign in securely/i }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await page.goto('/assessments');
    const card = page.getByRole('heading', { name: title }).locator('..');
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await card.getByRole('link', { name: /start/i }).click();
    await expect(page.getByRole('heading', { name: /which access model/i })).toBeVisible();
    await page.getByText('RBAC', { exact: true }).click();
    await page.getByRole('button', { name: /next question/i }).click();
    const essayBox = page.getByPlaceholder(/write a clear, complete response/i);
    await essayBox.fill('Least privilege limits account permissions, reducing unauthorized actions and the blast radius of a compromised identity.');
    await essayBox.blur();
    await page.getByRole('button', { name: /submit assessment/i }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await expect(page.getByRole('heading', { name: /assessment has been submitted/i })).toBeVisible();
    await expect(page.getByText(/waiting for an authorized human marker/i)).toBeVisible();
    await logout(page);

    // Assessor sees the subjective response and makes the final human decision.
    const grader = await apiLogin(page, 'manager@northstar.example', 'northstar');
    expect(grader.user.roles).toContain('assessor');
    await page.goto('/assessments');
    await page.getByRole('tab', { name: /marking/i }).click();
    const markingCard = page.getByText(title, { exact: true }).locator('xpath=ancestor::article');
    await expect(markingCard).toBeVisible();
    await markingCard.getByLabel(/score/i).fill('6');
    await markingCard.getByLabel(/feedback/i).fill('Clear connection between reduced permissions, unauthorized actions and blast radius.');
    await markingCard.getByRole('button', { name: /save mark/i }).click();
    await expect(markingCard).toHaveCount(0);
  });
});
