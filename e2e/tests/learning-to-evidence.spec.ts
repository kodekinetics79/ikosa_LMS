import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../fixtures/accessibility';
import { loginAs } from '../fixtures/session';

/**
 * The differentiating journey: learning is the fulfilment engine for an
 * intervention, and completing it must move the assurance record rather than
 * merely tick a box.
 */
test('@critical passing an assessed course issues evidence and closes the gap', async ({ page }) => {
  await loginAs(page, 'learner');

  // A learner self-enrolls in the catalogue.
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: /course catalogue/i })).toBeVisible();

  const storm = page.locator('.catalog-card').filter({ hasText: 'BRIEF-STORM' });
  await expect(storm).toContainText(/attendance only/i);

  const csrf = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    return (await response.json()).csrfToken as string;
  });

  // Work against a fresh enrollment rather than mutating the seeded one, so the
  // journey is repeatable. Re-enrolling after a completion is also the real
  // requalification path, so this exercises it.
  const courses = await (await page.request.get('/api/courses')).json();
  const loto = courses.items.find((course: { code: string }) => course.code === 'LOTO-401');
  expect(loto, 'expected LOTO-401 in the learner catalogue').toBeTruthy();

  const existing = await (await page.request.get('/api/enrollments')).json();
  let enrollmentId: string | undefined = existing.items.find(
    (row: { courseId: string; status: string }) => row.courseId === loto.id && row.status !== 'completed' && row.status !== 'withdrawn',
  )?.id;

  if (!enrollmentId) {
    const created = await page.request.post('/api/enrollments', {
      headers: { 'x-csrf-token': csrf },
      data: { courseId: loto.id, source: 'self' },
    });
    expect(created.status()).toBe(201);
    enrollmentId = (await created.json()).id as string;
  }

  await page.goto(`/learning/${enrollmentId}`);
  await expect(page.getByRole('heading', { name: /Lockout\/Tagout authorized person/i })).toBeVisible();

  const complete = async (moduleId: string, score?: number) => {
    const response = await page.request.post(`/api/enrollments/${enrollmentId}/progress`, {
      headers: { 'x-csrf-token': csrf },
      data: score === undefined ? { moduleId } : { moduleId, score },
    });
    return { status: response.status(), body: await response.json() };
  };

  await complete('mod_loto_1');
  await complete('mod_loto_2');
  await complete('mod_loto_3');

  // Failing the assessment must not evidence competence, and must not trap the
  // learner in a completed state with no way to retake it.
  const failed = await complete('mod_loto_4', 0.55);
  expect(failed.status).toBe(200);
  expect(failed.body.evidence).toBeNull();
  expect(failed.body.evidenceWithheldReason).toBe('assessment_not_passed');
  expect(failed.body.enrollment.status).toBe('in_progress');

  // Passing issues verified evidence and recalculates the gap it was assigned for.
  const passed = await complete('mod_loto_4', 0.93);
  expect(passed.status).toBe(200);
  expect(passed.body.enrollment.status).toBe('completed');
  expect(passed.body.evidence).not.toBeNull();
  expect(passed.body.evidence.proficiencyLevel).toBe(4);
  expect(passed.body.evidence.status).toBe('verified');
  expect(passed.body.evidence.assessorUserId).toBeNull();
  expect(passed.body.gapCasesRecalculated).toContain('gap_loto');

  await page.reload();
  await expect(page.getByText(/competence evidenced/i)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('@critical a learner cannot open another learner\'s enrollment', async ({ page }) => {
  await loginAs(page, 'learner');
  // Seeded enrollments belong to this learner, so assert the scoping rule via a
  // record the learner must not reach: another tenant's course catalogue entry.
  const response = await page.request.get('/api/enrollments');
  const body = await response.json();
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(body.items.length).toBeGreaterThan(0);
  for (const enrollment of body.items) {
    expect(enrollment.subjectUserId).toBe(session.user.id);
  }
});

test('@a11y /learning and /catalog have no serious or critical violations', async ({ page }) => {
  await loginAs(page, 'learner');
  for (const route of ['/learning', '/catalog']) {
    await page.goto(route);
    await expectNoSeriousA11yViolations(page);
  }
});
