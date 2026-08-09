import type { Page } from 'playwright';
import { explainKeyPressFailure, normaliseKey } from './keys.ts';

/**
 * Page-level keyboard input. Resolves the glyph and abbreviation aliases
 * in keys.ts, then delegates to Playwright's `keyboard.press`, which
 * understands single keys, named keys, and combinations alike. Examples:
 * "A", "Esc", "Cmd+K", "Shift+A", "Control+Enter".
 */
export async function runType(page: Page, value: string): Promise<void> {
  try {
    await page.keyboard.press(normaliseKey(value));
  } catch (error) {
    throw explainKeyPressFailure(value, error);
  }
}
