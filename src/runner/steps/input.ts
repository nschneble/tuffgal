import type { Page } from 'playwright';
import type { Hint } from '../../schema/action.ts';
import { LocatorNotFoundError, resolveLocator } from '../resolveLocator.ts';

export async function runInput(
  page: Page,
  hint: Hint,
  value: string,
  timeoutMs: number,
): Promise<void> {
  const locator = resolveLocator(page, hint).first();
  try {
    await locator.fill(value, { timeout: timeoutMs });
  } catch (error) {
    throw new LocatorNotFoundError(hint, error);
  }
}
