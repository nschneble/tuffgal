import type { Page } from 'playwright';

const DEFAULT_AMOUNT = 600;

export async function runScroll(
  page: Page,
  direction: 'up' | 'down',
  amount: number | undefined,
): Promise<void> {
  const delta = (amount ?? DEFAULT_AMOUNT) * (direction === 'up' ? -1 : 1);
  await page.mouse.wheel(0, delta);
}
