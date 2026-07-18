import type { Page } from 'playwright';

// `amount` is always concrete here: the schema supplies its 600px default
// (see `scroll.amount` in src/schema/action.ts), so the handler never has to.
export async function runScroll(
  page: Page,
  direction: 'up' | 'down',
  amount: number,
): Promise<void> {
  const delta = amount * (direction === 'up' ? -1 : 1);
  await page.mouse.wheel(0, delta);
}
