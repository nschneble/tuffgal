import type { Page } from 'playwright';
import type { Hint } from '../../schema/action.ts';
import { LocatorNotFoundError, resolveLocator } from '../resolveLocator.ts';

/**
 * Synchronous existence check. Resolves the hint to a Playwright locator
 * and asserts that at least one matching element is currently attached.
 * Does not poll — the element must already be on screen by the time the
 * step runs. Use after a click or input that synchronously updates the
 * DOM, when you want a checkpoint that fails fast on a broken hint.
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
