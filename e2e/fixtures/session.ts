import { expect, Page } from '@playwright/test';

export type Persona = 'admin' | 'analyst' | 'manager' | 'learner' | 'auditor';

const credentials: Record<Persona, { email: string; password: string }> = {
  admin: {
    email: process.env.E2E_ADMIN_EMAIL ?? 'admin@northstar.example',
    password: process.env.E2E_ADMIN_PASSWORD ?? 'Demo!2026'
  },
  analyst: {
    email: process.env.E2E_ANALYST_EMAIL ?? 'analyst@northstar.example',
    password: process.env.E2E_ANALYST_PASSWORD ?? 'Demo!2026'
  },
  manager: {
    email: process.env.E2E_MANAGER_EMAIL ?? 'manager@northstar.example',
    password: process.env.E2E_MANAGER_PASSWORD ?? 'Demo!2026'
  },
  learner: {
    email: process.env.E2E_LEARNER_EMAIL ?? 'technician@northstar.example',
    password: process.env.E2E_LEARNER_PASSWORD ?? 'Demo!2026'
  },
  auditor: {
    email: process.env.E2E_AUDITOR_EMAIL ?? 'admin@northstar.example',
    password: process.env.E2E_AUDITOR_PASSWORD ?? 'Demo!2026'
  }
};

export async function loginAs(page: Page, persona: Persona): Promise<void> {
  const identity = credentials[persona];
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(identity.email);
  await page.getByLabel(/password/i).fill(identity.password);
  await page.getByRole('button', { name: /sign in securely/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('main')).toBeVisible();
}

export async function switchLanguage(page: Page, language: 'English' | 'العربية'): Promise<void> {
  await page.getByRole('button', { name: /language|اللغة/i }).click();
  await page.getByRole('menuitem', { name: language }).click();
}
