import { expect, test } from '@playwright/test';
import { apiLogin } from '../fixtures/api-session';

test.describe('Tenant and authorization isolation', () => {
  test('@critical caller-supplied tenant query cannot widen the Northstar scope', async ({ page }) => {
    await apiLogin(page, 'analyst@northstar.example', 'northstar');
    const response = await page.request.get('/api/platform/bootstrap?tenantId=ten_gulf');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.tenant.id).toBe('ten_northstar');
    expect(JSON.stringify(body)).not.toContain('Gulf Energy Services');
    expect(JSON.stringify(body)).not.toContain('role_gulf_eng');
  });

  test('@critical same endpoint returns a disjoint tenant dataset for Gulf admin', async ({ page }) => {
    await apiLogin(page, 'admin@gulf.example', 'gulf-energy');
    const response = await page.request.get('/api/platform/bootstrap');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.tenant.id).toBe('ten_gulf');
    expect(JSON.stringify(body)).toContain('Gulf Energy Services');
    expect(JSON.stringify(body)).not.toContain('Northstar Utilities');
    expect(JSON.stringify(body)).not.toContain('role_field_tech');
  });

  test('learner is denied audit access even with a valid session', async ({ page }) => {
    await apiLogin(page, 'technician@northstar.example', 'northstar');
    expect((await page.request.get('/api/audit')).status()).toBe(403);
  });
});

