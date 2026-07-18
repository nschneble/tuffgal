import type { Locator, Page } from 'playwright';
import type { CaptureMode } from '../config.ts';

/**
 * Safety bound for a `fullPage` capture. `maxPixels` caps the composited image's
 * total area (width × height); `label` identifies the capture in the error the
 * guard throws so the operator knows exactly which story/action to fix.
 */
export interface FullPageGuard {
  maxPixels: number;
  label: string;
}

/**
 * Thrown when a `fullPage` capture's measured layout area exceeds its
 * {@link FullPageGuard} cap. Carries the offending dimensions and the cap so
 * callers (and the message) can report precisely. Failing here is deliberate:
 * compositing and decoding a runaway-tall page to an RGBA array risks exhausting
 * memory, so a loud, actionable error beats an OOM crash.
 */
export class FullPageTooLargeError extends Error {
  readonly width: number;
  readonly height: number;
  readonly maxPixels: number;
  constructor(
    label: string,
    dimensions: { width: number; height: number },
    maxPixels: number,
  ) {
    const area = dimensions.width * dimensions.height;
    super(
      `Full-page screenshot for ${label} would composite a ` +
        `${dimensions.width}x${dimensions.height} image ` +
        `(${area.toLocaleString('en-US')} pixels), exceeding the ` +
        `${maxPixels.toLocaleString('en-US')}-pixel safety cap. A page this ` +
        `tall decodes to a huge RGBA array and risks exhausting memory. Bound ` +
        `the page height (e.g. cap infinite-scroll content), switch this story ` +
        `to captureMode 'viewport', or raise maxFullPagePixels in your tuffgal ` +
        `config.`,
    );
    this.name = 'FullPageTooLargeError';
    this.width = dimensions.width;
    this.height = dimensions.height;
    this.maxPixels = maxPixels;
  }
}

/**
 * Screenshot with animations disabled, caret hidden, and any masks applied so
 * the same UI renders to bit-identical pixels across runs. Masks are Playwright
 * locators whose bounding boxes are blacked out before the image is encoded.
 * Use them to neutralise randomised or time-based regions.
 *
 * `mode` controls scope: `viewport` (default) captures only the page's current
 * viewport box (what the user sees above the fold) while `fullPage`
 * composites the entire scrollable document however tall.
 *
 * `fullPageGuard`, when supplied, bounds a `fullPage` capture's area: the page's
 * measured layout dimensions are checked against the cap before the shutter
 * fires, and an over-cap page throws {@link FullPageTooLargeError} rather than
 * compositing an array large enough to risk an OOM. It is ignored for `viewport`
 * captures (already bounded by the breakpoint) and when omitted.
 */
export async function capturePage(
  page: Page,
  masks: Locator[] = [],
  mode: CaptureMode = 'viewport',
  fullPageGuard?: FullPageGuard,
): Promise<Buffer> {
  // `fullPage` composites the whole scrollable document into one image. When
  // the document is captured at a non-zero offset, `position: sticky` / `fixed`
  // chrome (sidebars, headers) resolves against that scroll position and lands
  // shifted down by `scrollY` in the stitch. The same UI produces a different
  // image purely because an earlier step left the viewport scrolled. Resetting
  // to the origin first pins those elements to their static-baseline position
  // so the capture is deterministic. `instant` defeats any `scroll-behavior:
  // smooth` the page sets, which would otherwise animate and reintroduce a
  // timing race.
  //
  // A `viewport` shot captures exactly the box the flow scrolled to, so it must
  // NOT reset. A story that scrolls to a below-the-fold section (a Settings
  // panel, a success banner) would otherwise capture the top of the page
  // instead of the region it navigated to. The flow lands at a deterministic
  // offset, so the viewport shot is deterministic without any reset.
  //
  // The same page-context call that resets scroll also returns the document's
  // layout dimensions, so the guard measures the true (unclipped) full-page size
  // (Chromium may clip the actual screenshot, but the layout height reflects the
  // real pathology) in one round-trip, with no extra evaluate. String form so
  // the snippet runs in the page (DOM) context without pulling the DOM lib into
  // this Node-side module's type environment.
  if (mode === 'fullPage') {
    const dimensions = (await page.evaluate(
      `(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        const el = document.documentElement;
        const body = document.body;
        return {
          width: Math.max(el.scrollWidth, el.clientWidth, body ? body.scrollWidth : 0),
          height: Math.max(el.scrollHeight, el.clientHeight, body ? body.scrollHeight : 0),
        };
      })()`,
    )) as { width: number; height: number };
    // Guard only when a cap is supplied. The measurement above always runs (it
    // is also the scroll reset), but an unbounded caller (e.g. a test) simply
    // ignores the returned dimensions.
    if (
      fullPageGuard &&
      dimensions.width * dimensions.height > fullPageGuard.maxPixels
    ) {
      throw new FullPageTooLargeError(
        fullPageGuard.label,
        dimensions,
        fullPageGuard.maxPixels,
      );
    }
  }
  return page.screenshot({
    fullPage: mode === 'fullPage',
    animations: 'disabled',
    caret: 'hide',
    mask: masks,
  });
}
