import type { Page } from 'playwright';

export async function runWait(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}
