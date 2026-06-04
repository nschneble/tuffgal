import type { Page } from 'playwright';
import type { Hint } from '../../schema/action.ts';
import { LocatorNotFoundError, resolveLocator } from '../resolveLocator.ts';

export async function runClick(
  page: Page,
  hint: Hint,
  timeoutMs: number,
): Promise<void> {
  const locator = resolveLocator(page, hint).first();
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (error) {
    throw new LocatorNotFoundError(hint, error);
  }
}
