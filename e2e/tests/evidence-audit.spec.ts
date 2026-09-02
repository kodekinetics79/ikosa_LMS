import { expect, test } from '@playwright/test';
import { apiLogin, writeHeaders } from '../fixtures/api-session';

test('@critical manager records evidence and creates a non-training intervention', async ({ page }) => {
  const manager = await apiLogin(page, 'manager@northstar.example', 'northstar');
  const evidence = await page.request.post('/api/evidence', {
    headers: writeHeaders(manager),
    data: { orgUnitId: 'org_ns_south', subjectUserId: 'usr_learner', skillId: 'skill_loto', type: 'observation', proficiencyLevel: 3, strength: 0.9, sourceReference: `PW-OBS-${Date.now()}` }
  });
  expect(evidence.status(), await evidence.text()).toBe(201);
  expect(await evidence.json()).toMatchObject({ tenantId: 'ten_northstar', assessorUserId: 'usr_manager', subjectUserId: 'usr_learner', status: 'verified' });

  const analyst = await apiLogin(page, 'analyst@northstar.example', 'northstar');
  const intervention = await page.request.post('/api/interventions', {
    headers: writeHeaders(analyst),
    data: { gapCaseId: 'gap_loto', type: 'process', title: 'Introduce protected pre-shift equipment-check window', dueDate: '2026-09-12' }
  });
  expect(intervention.status(), await intervention.text()).toBe(201);
  expect(await intervention.json()).toMatchObject({ type: 'process', status: 'planned' });

  await page.goto('/evidence');
  await expect(page.getByRole('heading', { name: /evidence workspace/i })).toBeVisible();
  await page.goto('/interventions');
  await expect(page.getByRole('heading', { name: /intervention scenarios/i })).toBeVisible();
});

test('@critical audit chain validates and learner cannot create evidence for another person', async ({ page }) => {
  const learner = await apiLogin(page, 'technician@northstar.example', 'northstar');
  const denied = await page.request.post('/api/evidence', {
    headers: writeHeaders(learner),
    data: { orgUnitId: 'org_ns_south', subjectUserId: 'usr_manager', skillId: 'skill_loto', proficiencyLevel: 5, strength: 1, sourceReference: 'unauthorized' }
  });
  expect(denied.status()).toBe(403);

  await apiLogin(page, 'admin@northstar.example', 'northstar');
  const audit = await page.request.get('/api/audit');
  expect(audit.status()).toBe(200);
  const body = await audit.json();
  expect(body.integrity).toEqual(expect.objectContaining({ valid: true }));
  expect(body.items.some((event: { action: string; outcome: string }) => event.action === 'auth.login' && event.outcome === 'success')).toBe(true);
});
