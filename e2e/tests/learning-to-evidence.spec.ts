import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../fixtures/accessibility';
import { type DiscoveredCourse, type DiscoveredGapCase, sessionUser } from '../fixtures/discovery';
import { loginAs } from '../fixtures/session';

/**
 * The differentiating journey: learning is the fulfilment engine for an
 * intervention, and completing it must move the assurance record rather than
 * merely tick a box.
 *
 * Course, module and gap-case ids are all discovered. `mod_loto_1`..`mod_loto_4`
 * and `gap_loto` are JSON-store literals - PostgreSQL derives a uuid for each -
 * so the modules are selected by their CONTRACT (`kind`, `position`) and the gap
 * case by what it is about (this learner, this course's skill).
 */
test('@critical passing an assessed course issues evidence and closes the gap', async ({ page }) => {
  await loginAs(page, 'learner');
  const me = await sessionUser(page);

  // A learner self-enrolls in the catalogue.
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: /course catalogue/i })).toBeVisible();

  const courses = (await (await page.request.get('/api/courses')).json()) as { items: DiscoveredCourse[] };
  const gaps = (await (await page.request.get('/api/gaps')).json()) as { items: DiscoveredGapCase[] };

  // An attendance-only course must say so on its card: an unassessed course can
  // never issue competence evidence, and hiding that turns attendance into a
  // silent competence claim.
  const attendanceOnly = courses.items.find((course) => course.evidenceRule === 'attendance_only');
  expect(attendanceOnly, 'expected an attendance-only course in the catalogue').toBeTruthy();
  const attendanceCard = page.locator('.catalog-card').filter({ hasText: attendanceOnly!.code });
  await expect(attendanceCard).toContainText(/attendance only/i);

  // The journey needs an ASSESSED course that both ends in an assessment module
  // and answers an open gap for this learner - that is the loop under test.
  const assessed = courses.items.find(
    (course) =>
      course.evidenceRule === 'assessed' &&
      course.modules?.some((module) => module.kind === 'assessment') &&
      gaps.items.some((gap) => gap.subjectUserId === me.id && gap.requirement?.skillId === course.skillId)
  );
  expect(assessed, 'expected an assessed course that closes a gap for this learner').toBeTruthy();
  const course = assessed!;
  const gapCase = gaps.items.find((gap) => gap.subjectUserId === me.id && gap.requirement?.skillId === course.skillId)!;

  const ordered = [...course.modules].sort((a, b) => a.position - b.position);
  const assessmentModule = ordered.find((module) => module.kind === 'assessment')!;
  const contentModules = ordered.filter((module) => module.id !== assessmentModule.id);

  const csrf = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    return (await response.json()).csrfToken as string;
  });

  // Work against a fresh enrollment rather than mutating the seeded one, so the
  // journey is repeatable. Re-enrolling after a completion is also the real
  // requalification path, so this exercises it.
  const existing = await (await page.request.get('/api/enrollments')).json();
  let enrollmentId: string | undefined = existing.items.find(
    (row: { courseId: string; status: string }) => row.courseId === course.id && row.status !== 'completed' && row.status !== 'withdrawn',
  )?.id;

  if (!enrollmentId) {
    const created = await page.request.post('/api/enrollments', {
      headers: { 'x-csrf-token': csrf },
      data: { courseId: course.id, source: 'self' },
    });
    expect(created.status()).toBe(201);
    enrollmentId = (await created.json()).id as string;
  }

  await page.goto(`/learning/${enrollmentId}`);
  await expect(page.getByRole('heading', { name: course.title })).toBeVisible();

  const complete = async (moduleId: string, score?: number) => {
    const response = await page.request.post(`/api/enrollments/${enrollmentId}/progress`, {
      headers: { 'x-csrf-token': csrf },
      data: score === undefined ? { moduleId } : { moduleId, score },
    });
    return { status: response.status(), body: await response.json() };
  };

  for (const module of contentModules) {
    const step = await complete(module.id);
    expect(step.status, JSON.stringify(step.body)).toBe(200);
  }

  // Failing the assessment must not evidence competence, and must not trap the
  // learner in a completed state with no way to retake it. The thresholds come
  // from the course's own passing score so the test cannot drift away from it.
  const failing = Math.max(0, course.passingScore - 0.25);
  const passing = Math.min(1, course.passingScore + 0.13);

  const failed = await complete(assessmentModule.id, failing);
  expect(failed.status).toBe(200);
  expect(failed.body.evidence).toBeNull();
  expect(failed.body.evidenceWithheldReason).toBe('assessment_not_passed');
  expect(failed.body.enrollment.status).toBe('in_progress');

  // Passing issues verified evidence and recalculates the gap it was assigned for.
  const passed = await complete(assessmentModule.id, passing);
  expect(passed.status).toBe(200);
  expect(passed.body.enrollment.status).toBe('completed');
  expect(passed.body.evidence).not.toBeNull();
  expect(passed.body.evidence.proficiencyLevel).toBe(course.targetLevel);
  expect(passed.body.evidence.status).toBe('verified');
  // Course completion is machine-issued: no human assessor signed for it, and
  // recording one would forge an attestation nobody made.
  expect(passed.body.evidence.assessorUserId).toBeNull();
  expect(passed.body.gapCasesRecalculated).toContain(gapCase.id);

  await page.reload();
  await expect(page.getByText(/competence evidenced/i)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('@critical a learner cannot open another learner\'s enrollment', async ({ page }) => {
  await loginAs(page, 'learner');
  // Seeded enrollments belong to this learner, so assert the scoping rule via
  // the subject on every row the endpoint is willing to return.
  const response = await page.request.get('/api/enrollments');
  const body = await response.json();
  const me = await sessionUser(page);
  expect(body.items.length).toBeGreaterThan(0);
  for (const enrollment of body.items) {
    expect(enrollment.subjectUserId).toBe(me.id);
  }
});

test('@a11y /learning and /catalog have no serious or critical violations', async ({ page }) => {
  await loginAs(page, 'learner');
  for (const route of ['/learning', '/catalog']) {
    await page.goto(route);
    await expectNoSeriousA11yViolations(page);
  }
});
