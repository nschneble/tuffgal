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
  // A `fullPage` screenshot composites the whole document, but it does so at
  // the page's current scroll offset. `position: sticky` / `fixed` elements
  // resolve their offset against that scroll position, so a page captured
  // mid-scroll renders its sticky chrome (sidebars, headers) shifted down by
  // `scrollY` — the same UI produces a different image purely because an
  // earlier step left the viewport scrolled. Resetting to the origin first
  // pins those elements to their static-baseline position so the capture is
  // deterministic. `instant` defeats any `scroll-behavior: smooth` the page
  // sets, which would otherwise animate and reintroduce a timing race.
  // String form so the snippet runs in the page (DOM) context without
  // pulling the DOM lib into this Node-side module's type environment.
  await page.evaluate(
    `window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`,
  );
  return page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    mask: masks,
  });
}
