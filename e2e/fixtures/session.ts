import { expect, Page } from '@playwright/test';

export type Persona = 'admin' | 'analyst' | 'manager' | 'learner' | 'auditor' | 'gulfAdmin';

export interface Identity {
  email: string;
  password: string;
  /**
   * Sign-in is tenant-first: the workspace is part of the credential, not a
   * server-side default. Every persona therefore carries its own slug so a
   * foreign-tenant persona (gulfAdmin) can be driven through the same helper.
   */
  tenantSlug: string;
}

export const DEFAULT_TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'northstar';
export const CROSS_TENANT_SLUG = process.env.E2E_CROSS_TENANT_SLUG ?? 'gulf-energy';

const PASSWORD = process.env.E2E_PASSWORD ?? 'Demo!2026';

const credentials: Record<Persona, Identity> = {
  admin: {
    email: process.env.E2E_ADMIN_EMAIL ?? 'admin@northstar.example',
    password: process.env.E2E_ADMIN_PASSWORD ?? PASSWORD,
    tenantSlug: DEFAULT_TENANT_SLUG
  },
  analyst: {
    email: process.env.E2E_ANALYST_EMAIL ?? 'analyst@northstar.example',
    password: process.env.E2E_ANALYST_PASSWORD ?? PASSWORD,
    tenantSlug: DEFAULT_TENANT_SLUG
  },
  manager: {
    email: process.env.E2E_MANAGER_EMAIL ?? 'manager@northstar.example',
    password: process.env.E2E_MANAGER_PASSWORD ?? PASSWORD,
    tenantSlug: DEFAULT_TENANT_SLUG
  },
  learner: {
    email: process.env.E2E_LEARNER_EMAIL ?? 'technician@northstar.example',
    password: process.env.E2E_LEARNER_PASSWORD ?? PASSWORD,
    tenantSlug: DEFAULT_TENANT_SLUG
  },
  auditor: {
    email: process.env.E2E_AUDITOR_EMAIL ?? 'admin@northstar.example',
    password: process.env.E2E_AUDITOR_PASSWORD ?? PASSWORD,
    tenantSlug: DEFAULT_TENANT_SLUG
  },
  gulfAdmin: {
    email: process.env.E2E_CROSS_TENANT_ADMIN_EMAIL ?? 'admin@gulf.example',
    password: process.env.E2E_CROSS_TENANT_ADMIN_PASSWORD ?? PASSWORD,
    tenantSlug: CROSS_TENANT_SLUG
  }
};

export function identityOf(persona: Persona): Identity {
  return credentials[persona];
}

export async function loginAs(page: Page, persona: Persona): Promise<void> {
  const identity = credentials[persona];
  await page.goto('/login');
  // The Workspace field is `required` on the form and is resolved to a tenant
  // BEFORE the server looks the user up, so leaving it blank does not fall back
  // to a default tenant - it stops the submit entirely. Every browser journey
  // then failed at whatever it asserted after login instead of at the empty
  // field, which is why this helper fills the workspace first.
  await page.getByLabel(/^workspace$/i).fill(identity.tenantSlug);
  await page.getByLabel(/work email/i).fill(identity.email);
  await page.getByLabel(/^password$/i).fill(identity.password);
  await page.getByRole('button', { name: /sign in securely/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('main')).toBeVisible();
}

export async function switchLanguage(page: Page, language: 'English' | 'العربية'): Promise<void> {
  await page.getByRole('button', { name: /language|اللغة/i }).click();
  await page.getByRole('menuitem', { name: language }).click();
}
