import type { Locator, Page } from 'playwright';
import type { CaptureMode } from '../config.ts';

/**
 * Screenshot with animations disabled, caret hidden, and any masks applied so
 * the same UI renders to bit-identical pixels across runs. Masks are Playwright
 * locators whose bounding boxes are blacked out before the image is encoded —
 * use them to neutralise randomised or time-based regions.
 *
 * `mode` controls scope: `viewport` (default) captures only the page's current
 * viewport box — what the user sees above the fold — while `fullPage`
 * composites the entire scrollable document however tall.
 */
export async function capturePage(
  page: Page,
  masks: Locator[] = [],
  mode: CaptureMode = 'viewport',
): Promise<Buffer> {
  // `fullPage` composites the whole scrollable document into one image. When
  // the document is captured at a non-zero offset, `position: sticky` / `fixed`
  // chrome (sidebars, headers) resolves against that scroll position and lands
  // shifted down by `scrollY` in the stitch — the same UI produces a different
  // image purely because an earlier step left the viewport scrolled. Resetting
  // to the origin first pins those elements to their static-baseline position
  // so the capture is deterministic. `instant` defeats any `scroll-behavior:
  // smooth` the page sets, which would otherwise animate and reintroduce a
  // timing race.
  //
  // A `viewport` shot captures exactly the box the flow scrolled to, so it must
  // NOT reset — a story that scrolls to a below-the-fold section (a Settings
  // panel, a success banner) would otherwise capture the top of the page
  // instead of the region it navigated to. The flow lands at a deterministic
  // offset, so the viewport shot is deterministic without any reset.
  //
  // String form so the snippet runs in the page (DOM) context without pulling
  // the DOM lib into this Node-side module's type environment.
  if (mode === 'fullPage') {
    await page.evaluate(
      `window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`,
    );
  }
  return page.screenshot({
    fullPage: mode === 'fullPage',
    animations: 'disabled',
    caret: 'hide',
    mask: masks,
  });
}
