import { expect, test } from '@playwright/test';
import { apiLoginAs } from '../fixtures/api-session';
import { bootstrap } from '../fixtures/discovery';
import { CROSS_TENANT_SLUG, DEFAULT_TENANT_SLUG } from '../fixtures/session';

test.describe('Tenant and authorization isolation', () => {
  test('@critical caller-supplied tenant query cannot widen the Northstar scope', async ({ page }) => {
    // The foreign tenant's id is fetched by signing in as somebody who belongs
    // to that tenant. It cannot be written down: PostgreSQL derives a uuid for
    // it, and the literal this test used to carry (`ten_gulf`) only ever existed
    // in the JSON fixture store - so the widening attempt it "proved" was
    // refused was in fact an unresolvable id being refused for the wrong reason.
    await apiLoginAs(page, 'gulfAdmin');
    const foreign = await bootstrap(page);
    expect(foreign.tenant.slug).toBe(CROSS_TENANT_SLUG);
    expect(foreign.jobRoles.length, 'the foreign tenant has job roles to leak').toBeGreaterThan(0);

    await apiLoginAs(page, 'analyst');
    const response = await page.request.get(`/api/platform/bootstrap?tenantId=${encodeURIComponent(foreign.tenant.id)}`);
    expect(response.status()).toBe(200);
    const body = await response.json();

    // Scope is derived from the session, so a caller-supplied tenantId is inert.
    expect(body.tenant.slug).toBe(DEFAULT_TENANT_SLUG);
    expect(body.tenant.id).not.toBe(foreign.tenant.id);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(foreign.tenant.id);
    expect(serialized).not.toContain(foreign.tenant.name);
    for (const role of foreign.jobRoles) {
      expect(serialized, `foreign job role ${role.code} leaked into the Northstar payload`).not.toContain(role.id);
    }
  });

  test('@critical same endpoint returns a disjoint tenant dataset for Gulf admin', async ({ page }) => {
    await apiLoginAs(page, 'admin');
    const home = await bootstrap(page);
    expect(home.jobRoles.length, 'the home tenant has job roles to leak').toBeGreaterThan(0);

    await apiLoginAs(page, 'gulfAdmin');
    const foreign = await bootstrap(page);
    expect(foreign.tenant.slug).toBe(CROSS_TENANT_SLUG);
    expect(foreign.tenant.id).not.toBe(home.tenant.id);

    const serialized = JSON.stringify(foreign);
    expect(serialized).toContain(foreign.tenant.name);
    expect(serialized).not.toContain(home.tenant.id);
    expect(serialized).not.toContain(home.tenant.name);
    for (const role of home.jobRoles) {
      expect(serialized, `home job role ${role.code} leaked into the Gulf payload`).not.toContain(role.id);
    }
  });

  test('learner is denied audit access even with a valid session', async ({ page }) => {
    await apiLoginAs(page, 'learner');
    expect((await page.request.get('/api/audit')).status()).toBe(403);
  });
});
