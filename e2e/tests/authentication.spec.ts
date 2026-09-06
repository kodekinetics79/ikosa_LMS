import { expect, test } from '@playwright/test';
import { apiLoginAs } from '../fixtures/api-session';
import { CROSS_TENANT_SLUG, DEFAULT_TENANT_SLUG, identityOf, loginAs } from '../fixtures/session';

test.describe('Authentication and session protection', () => {
  test('@critical rejects invalid credentials without disclosing account state', async ({ request }) => {
    const unknown = `unknown-${Date.now()}@example.com`;
    const response = await request.post('/api/auth/login', { data: { tenantSlug: DEFAULT_TENANT_SLUG, email: unknown, password: 'incorrect-password' } });
    expect(response.status()).toBe(401);
    const problem = await response.json();
    expect(problem.error).toMatch(/credentials|sign in|unauthorized/i);
    expect(JSON.stringify(problem)).not.toContain(unknown);

    // A wrong password on a real account must be indistinguishable from a wrong
    // password on an account that does not exist, or the endpoint enumerates
    // users for anyone who can count response bodies.
    const known = await request.post('/api/auth/login', {
      data: { tenantSlug: DEFAULT_TENANT_SLUG, email: identityOf('admin').email, password: 'incorrect-password' }
    });
    expect(known.status()).toBe(response.status());
    expect((await known.json()).error).toBe(problem.error);
  });

  test('@critical the workspace is part of the credential, not a hint', async ({ request }) => {
    // Tenant-first sign-in: the right password in the wrong workspace is not a
    // sign-in, because the same address in two workspaces is two accounts.
    const admin = identityOf('admin');
    const response = await request.post('/api/auth/login', {
      data: { tenantSlug: CROSS_TENANT_SLUG, email: admin.email, password: admin.password }
    });
    expect(response.status()).toBe(401);
  });

  test('@critical real browser login creates a hardened tenant session', async ({ page, context }) => {
    await loginAs(page, 'analyst');
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole('main')).toBeVisible();
    const session = (await context.cookies()).find(({ name }) => name === 'ik_session');
    expect(session, 'Expected the ik_session cookie').toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
  });

  test('@critical logout invalidates the server session', async ({ page }) => {
    await apiLoginAs(page, 'analyst');
    expect((await page.request.get('/api/auth/session')).status()).toBe(200);
    expect((await page.request.post('/api/auth/logout')).status()).toBe(200);
    expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  });
});
