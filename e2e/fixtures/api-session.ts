import { expect, Page } from '@playwright/test';
import { DEFAULT_TENANT_SLUG, identityOf, type Persona } from './session';

export interface ApiSession {
  csrfToken: string;
  user: { id: string; tenantId: string; orgUnitId: string; email: string; displayName: string; roles: string[] };
}

export async function apiLogin(
  page: Page,
  email = 'analyst@northstar.example',
  tenantSlug = DEFAULT_TENANT_SLUG,
  password = process.env.E2E_PASSWORD ?? 'Demo!2026'
): Promise<ApiSession> {
  const response = await page.request.post('/api/auth/login', {
    data: { tenantSlug, email, password }
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as ApiSession;
  expect(body.csrfToken).toBeTruthy();
  return body;
}

/**
 * Sign in over the API as a named persona, carrying that persona's workspace.
 * Cross-tenant specs need a foreign tenant's real ids, and the only honest way
 * to get them is to authenticate as somebody who belongs to that tenant.
 */
export async function apiLoginAs(page: Page, persona: Persona): Promise<ApiSession> {
  const identity = identityOf(persona);
  return apiLogin(page, identity.email, identity.tenantSlug, identity.password);
}

export function writeHeaders(session: ApiSession): Record<string, string> {
  return { 'x-csrf-token': session.csrfToken };
}
