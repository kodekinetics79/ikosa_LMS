import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../fixtures/accessibility';
import { anyTnaStudyId } from '../fixtures/discovery';
import { loginAs } from '../fixtures/session';

// Every route reachable from primary navigation is gated, not a sample of four.
// A screen that is not scanned is a screen that regresses silently.
const AUDIT_ONLY = new Set(['/audit']);
const STATIC_ROUTES = ['/', '/signals', '/studies', '/learning', '/catalog', '/notifications', '/evidence', '/interventions', '/audit'];

for (const route of STATIC_ROUTES) {
  test(`@a11y ${route} has no serious or critical automated violations`, async ({ page }) => {
    await loginAs(page, AUDIT_ONLY.has(route) ? 'auditor' : 'analyst');
    await page.goto(route);
    await expectNoSeriousA11yViolations(page);
  });
}

// The gap explorer is addressed by study id. `tna_field_2026` is a JSON-store
// literal; PostgreSQL derives a uuid, so the id is read back from /api/tna and
// the scan runs against a study that actually exists.
test('@a11y the gap explorer for a real study has no serious or critical automated violations', async ({ page }) => {
  await loginAs(page, 'analyst');
  const studyId = await anyTnaStudyId(page);
  await page.goto(`/studies/${studyId}/gaps`);
  await expectNoSeriousA11yViolations(page);
});

test('@critical Arabic switches document direction and critical content remains usable', async ({ page }) => {
  await loginAs(page, 'analyst');
  await page.getByRole('button', { name: /switch language direction/i }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await expectNoSeriousA11yViolations(page);
});

test('keyboard user can reach main content and primary navigation', async ({ page, browserName }) => {
  await page.goto('/login');
  const skipLink = page.getByRole('link', { name: /skip to main content/i });
  await expect(skipLink).toBeVisible();

  // WebKit omits links from sequential tab order unless the user turns on
  // "Press Tab to highlight each item on a webpage", so on that engine Tab
  // lands on the first input instead. That is the platform's default, not a
  // defect in the page, so assert tab ORDER only where the engine provides it -
  // and assert the skip link's actual PURPOSE everywhere.
  if (browserName !== 'webkit') {
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
  } else {
    await skipLink.focus();
  }

  await skipLink.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});
