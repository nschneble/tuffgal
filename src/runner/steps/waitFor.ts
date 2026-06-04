import type { Page } from 'playwright';
import type { Hint } from '../../schema/action.ts';
import { LocatorNotFoundError, resolveLocator } from '../resolveLocator.ts';

export async function runWaitFor(
  page: Page,
  hint: Hint,
  timeoutMs: number,
): Promise<void> {
  const locator = resolveLocator(page, hint).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    throw new LocatorNotFoundError(hint, error);
  }
}
