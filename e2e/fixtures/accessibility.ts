import AxeBuilder from '@axe-core/playwright';
import { expect, Page } from '@playwright/test';

/**
 * Colour-contrast conformance is defined against the settled presentation.
 * Screens use `.fade-in` (a 280ms opacity animation), and scanning while it is
 * still running measures part-way blended colours, which both reports failures
 * that do not exist and can mask real ones. Wait for animations to finish so
 * the scan reflects what a user actually reads.
 */
async function waitForStablePresentation(page: Page): Promise<void> {
  // Not `networkidle`: the dev server holds an open HMR socket, so the network
  // never goes idle and the wait would always time out.
  await page.waitForLoadState('domcontentloaded');
  await page
    .waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'), null, { timeout: 5_000 })
    .catch(() => undefined);
}

export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  await waitForStablePresentation(page);
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = scan.violations.filter(
    ({ impact }: { impact?: string | null }) => impact === 'critical' || impact === 'serious'
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}
