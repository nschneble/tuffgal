import type { Page } from 'playwright';

/**
 * Page-level keyboard input. Delegates straight to Playwright's
 * `keyboard.press`, which understands single keys, named keys, and
 * combinations alike. Examples: "A", "Escape", "Shift+A",
 * "Control+Enter".
 */
export async function runType(page: Page, value: string): Promise<void> {
  await page.keyboard.press(value);
}
