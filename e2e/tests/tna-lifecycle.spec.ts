import { expect, test } from '@playwright/test';
import { apiLoginAs, writeHeaders } from '../fixtures/api-session';
import { anyJobRoleId } from '../fixtures/discovery';

test('@critical creates an evidence-traceable TNA through the real API and reviews it in browser', async ({ page }) => {
  const session = await apiLoginAs(page, 'analyst');
  // The org unit and the target role are read back from the caller's own
  // session and bootstrap. Naming `org_ns_ops` / `role_field_tech` bound this
  // spec to the JSON store's literals; PostgreSQL derives a uuid for both and
  // rejected the write with "Organizational unit not found in tenant".
  const orgUnitId = session.user.orgUnitId;
  const targetRoleId = await anyJobRoleId(page);

  const title = `Forklift readiness ${Date.now()}`;
  const create = await page.request.post('/api/tna', {
    headers: writeHeaders(session),
    data: { orgUnitId, title, objective: 'Reduce loading-bay safety events by 20 percent.', targetRoleIds: [targetRoleId], dueDate: '2026-09-30' }
  });
  expect(create.status(), await create.text()).toBe(201);
  const created = await create.json();
  expect(created).toMatchObject({ title, tenantId: session.user.tenantId, status: 'draft' });

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

  const admin = await apiLoginAs(page, 'admin');
  const audit = await page.request.get('/api/audit');
  expect(audit.status()).toBe(200);
  const auditBody = await audit.json();
  expect(auditBody.integrity).toEqual(expect.objectContaining({ valid: true }));
  expect(auditBody.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'tna.create', resourceId: created.id, tenantId: admin.user.tenantId })
  ]));
});
