import type { Page } from 'playwright';

import { explainKeyPressFailure, normalizeKey } from './keys.ts';

/**
 * Page-level keyboard input. Delegates to Playwright's `keyboard.press`,
 * which understands single keys, named keys, and combinations alike, after
 * resolving the glyph and abbreviation aliases in keys.ts. Examples: "A",
 * "Esc", "Cmd+K", "Shift+A", "Control+Enter".
 */
export async function runType(page: Page, value: string): Promise<void> {
  try {
    await page.keyboard.press(normalizeKey(value));
  } catch (error) {
    throw explainKeyPressFailure(value, error);
  }
}
