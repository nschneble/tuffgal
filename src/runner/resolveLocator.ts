import type { Locator, Page } from 'playwright';
import type { Hint } from '../schema/action.ts';

/**
 * Resolves a hint to a Playwright Locator using a precedence chain. The MVP
 * intentionally stays literal — no LLM fallback. When this throws,
 * `runAction` records `LocatorNotFound` and the parent story fails fast.
 *
 * Order:
 *  1. `role + text`  — strongest ARIA contract.
 *  2. `role` alone   — when no name is supplied.
 *  3. `selector`     — explicit escape hatch / cached resolution.
 *  4. `text` alone   — last resort because text-only locators are noisy.
 */
export function resolveLocator(page: Page, hint: Hint): Locator {
  if (hint.role && hint.text) {
    return page.getByRole(hint.role, { name: hint.text, exact: false });
  }
  if (hint.role) {
    return page.getByRole(hint.role);
  }
  if (hint.selector) {
    return page.locator(hint.selector);
  }
  if (hint.text) {
    return page.getByText(hint.text, { exact: false });
  }
  throw new LocatorHintError(
    'hint has no role, selector, or text — cannot resolve',
  );
}

export class LocatorHintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorHintError';
  }
}

export class LocatorNotFoundError extends Error {
  override readonly cause?: unknown;
  constructor(hint: Hint, cause?: unknown) {
    super(`No element matched hint ${JSON.stringify(hint)}`);
    this.name = 'LocatorNotFoundError';
    this.cause = cause;
  }
}
