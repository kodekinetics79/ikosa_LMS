import { expect, test } from '@playwright/test';
import { apiLogin } from '../fixtures/api-session';

test.describe('Authentication and session protection', () => {
  test('@critical rejects invalid credentials without disclosing account state', async ({ request }) => {
    // A unique address per run. Login is throttled per identity, so reusing one
    // fixed address means later runs get rate-limited instead of exercising the
    // disclosure rule this test exists to protect.
    const unknown = `unknown-${Date.now()}@example.com`;
    const response = await request.post('/api/auth/login', { data: { email: unknown, password: 'incorrect-password' } });
    expect(response.status()).toBe(401);
    const problem = await response.json();
    expect(problem.error).toMatch(/credentials|sign in|unauthorized/i);
    expect(JSON.stringify(problem)).not.toContain(unknown);
  });

  test('@critical real browser login creates a hardened session', async ({ page, context }) => {
    await page.goto('/login');
    await page.getByLabel(/work email/i).fill('analyst@northstar.example');
    await page.getByLabel(/^password/i).fill('Demo!2026');
    await page.getByRole('button', { name: /sign in securely/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('main')).toBeVisible();
    const session = (await context.cookies()).find(({ name }) => name === 'ik_session');
    expect(session, 'Expected the ik_session cookie').toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
  });

  test('@critical logout invalidates the server session', async ({ page }) => {
    await apiLogin(page);
    expect((await page.request.get('/api/auth/session')).status()).toBe(200);
    expect((await page.request.post('/api/auth/logout')).status()).toBe(200);
    expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  });
});
