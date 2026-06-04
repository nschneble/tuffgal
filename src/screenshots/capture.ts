import type { Locator, Page } from 'playwright';

/**
 * Full-page screenshot with animations disabled, caret hidden, and any masks
 * applied so the same UI renders to bit-identical pixels across runs. Masks
 * are Playwright locators whose bounding boxes are blacked out before the
 * image is encoded — use them to neutralise randomised or time-based regions.
 */
export async function capturePage(
  page: Page,
  masks: Locator[] = [],
): Promise<Buffer> {
  return page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    mask: masks,
  });
}
