import { expect, Page } from '@playwright/test';

export interface ApiSession {
  csrfToken: string;
  user: { id: string; email: string; displayName: string; roles: string[] };
}

export async function apiLogin(page: Page, email = 'analyst@northstar.example', tenantSlug?: string): Promise<ApiSession> {
  const response = await page.request.post('/api/auth/login', {
    data: { email, password: 'Demo!2026', ...(tenantSlug ? { tenantSlug } : {}) }
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as ApiSession;
  expect(body.csrfToken).toBeTruthy();
  return body;
}

export function writeHeaders(session: ApiSession): Record<string, string> {
  return { 'x-csrf-token': session.csrfToken };
}

