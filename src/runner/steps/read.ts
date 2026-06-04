import type { Page } from 'playwright';
import type { Hint } from '../../schema/action.ts';
import { LocatorNotFoundError, resolveLocator } from '../resolveLocator.ts';

/**
 * Synchronous existence check. Resolves the hint to a Playwright locator
 * and asserts that exactly one matching element is currently attached. Use
 * after a click or input that should leave a known element on screen.
 */
export async function runRead(page: Page, hint: Hint): Promise<void> {
  const locator = resolveLocator(page, hint).first();
  try {
    const count = await locator.count();
    if (count === 0) {
      throw new Error('no matching element');
    }
  } catch (error) {
    throw new LocatorNotFoundError(hint, error);
  }
}
