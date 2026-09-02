import { expect, test } from '@playwright/test';
import { apiLogin, writeHeaders } from '../fixtures/api-session';

test('@critical creates an evidence-traceable TNA through the real API and reviews it in browser', async ({ page }) => {
  const session = await apiLogin(page);
  const title = `Forklift readiness ${Date.now()}`;
  const create = await page.request.post('/api/tna', {
    headers: writeHeaders(session),
    data: { orgUnitId: 'org_ns_ops', title, objective: 'Reduce loading-bay safety events by 20 percent.', targetRoleIds: ['role_field_tech'], dueDate: '2026-09-30' }
  });
  expect(create.status(), await create.text()).toBe(201);
  const created = await create.json();
  expect(created).toMatchObject({ title, tenantId: 'ten_northstar', status: 'draft' });

  const list = await page.request.get('/api/tna');
  expect(list.status()).toBe(200);
  const listed = await list.json();
  expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, title })]));
  expect(listed.asOf).toBeTruthy();

  await page.goto('/studies');
  await expect(page.getByRole('heading', { name: /TNA studies/i })).toBeVisible();
  // Assert the study this test actually created. The previous assertion named a
  // study that only ever existed in the page's hardcoded markup, so it passed
  // BECAUSE the screen was fabricated and would have kept passing no matter what
  // the API did.
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('link', { name: /gap explorer/i }).click();
  await expect(page.getByRole('heading', { name: /gap/i }).first()).toBeVisible();

  await apiLogin(page, 'admin@northstar.example', 'northstar');
  const audit = await page.request.get('/api/audit');
  expect(audit.status()).toBe(200);
  const auditBody = await audit.json();
  expect(auditBody.integrity).toEqual(expect.objectContaining({ valid: true }));
  expect(auditBody.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'tna.create', resourceId: created.id, tenantId: 'ten_northstar' })]));
});
