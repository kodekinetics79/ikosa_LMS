import { expect, test } from '@playwright/test';
import { apiLoginAs, writeHeaders } from '../fixtures/api-session';
import { anyGapCaseId, anySkillId } from '../fixtures/discovery';

test('@critical manager records evidence and creates a non-training intervention', async ({ page }) => {
  // Every participant id is read back from the API. `org_ns_south`,
  // `usr_learner`, `usr_manager` and `skill_loto` are JSON-store literals;
  // PostgreSQL derives a uuid for each, so a spec that spells them out asserts
  // the seed file rather than the product.
  const learner = await apiLoginAs(page, 'learner');
  const manager = await apiLoginAs(page, 'manager');
  const skillId = await anySkillId(page);

  const evidence = await page.request.post('/api/evidence', {
    headers: writeHeaders(manager),
    data: {
      orgUnitId: manager.user.orgUnitId,
      subjectUserId: learner.user.id,
      skillId,
      type: 'observation',
      proficiencyLevel: 3,
      strength: 0.9,
      sourceReference: `PW-OBS-${Date.now()}`
    }
  });
  expect(evidence.status(), await evidence.text()).toBe(201);
  expect(await evidence.json()).toMatchObject({
    tenantId: manager.user.tenantId,
    assessorUserId: manager.user.id,
    subjectUserId: learner.user.id,
    // An assessor-held role verifies on write; anything else would leave
    // competence claimed but unverified.
    status: 'verified'
  });

  const analyst = await apiLoginAs(page, 'analyst');
  const gapCaseId = await anyGapCaseId(page);
  const intervention = await page.request.post('/api/interventions', {
    headers: writeHeaders(analyst),
    data: { gapCaseId, type: 'process', title: 'Introduce protected pre-shift equipment-check window', dueDate: '2026-09-12' }
  });
  expect(intervention.status(), await intervention.text()).toBe(201);
  expect(await intervention.json()).toMatchObject({ type: 'process', status: 'planned' });

  await page.goto('/evidence');
  await expect(page.getByRole('heading', { name: /evidence workspace/i })).toBeVisible();
  await page.goto('/interventions');
  await expect(page.getByRole('heading', { name: /intervention scenarios/i })).toBeVisible();
});

test('@critical audit chain validates and learner cannot create evidence for another person', async ({ page }) => {
  const manager = await apiLoginAs(page, 'manager');
  const skillId = await anySkillId(page);

  const learner = await apiLoginAs(page, 'learner');
  const denied = await page.request.post('/api/evidence', {
    headers: writeHeaders(learner),
    data: {
      orgUnitId: manager.user.orgUnitId,
      subjectUserId: manager.user.id,
      skillId,
      proficiencyLevel: 5,
      strength: 1,
      sourceReference: 'unauthorized'
    }
  });
  expect(denied.status()).toBe(403);

  const admin = await apiLoginAs(page, 'admin');
  const audit = await page.request.get('/api/audit');
  expect(audit.status()).toBe(200);
  const body = await audit.json();
  expect(body.integrity).toEqual(expect.objectContaining({ valid: true }));
  expect(body.items.every((event: { tenantId: string }) => event.tenantId === admin.user.tenantId)).toBe(true);
  expect(body.items.some((event: { action: string; outcome: string }) => event.action === 'auth.login' && event.outcome === 'success')).toBe(true);
});
