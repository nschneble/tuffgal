import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Page } from 'playwright';
import { capturePage, FullPageTooLargeError } from './capture.ts';

/**
 * A minimal stand-in for the bits of `Page` that `capturePage` touches. It
 * records the order of calls so the test can prove the scroll reset happens
 * before the shutter; the whole point of the fix is that ordering.
 */
function fakePage(): {
  page: Page;
  calls: string[];
  options: Array<Record<string, unknown>>;
} {
  const calls: string[] = [];
  const options: Array<Record<string, unknown>> = [];
  const page = {
    async evaluate(expression: unknown): Promise<void> {
      calls.push(`evaluate:${String(expression)}`);
    },
    async screenshot(opts: Record<string, unknown>): Promise<Buffer> {
      calls.push('screenshot');
      options.push(opts);
      return Buffer.from('png');
    },
  } as unknown as Page;
  return { page, calls, options };
}

describe('capturePage', () => {
  it('resets scroll to the origin before a fullPage screenshot', async () => {
    const { page, calls } = fakePage();

    await capturePage(page, [], 'fullPage');

    // Order matters: a sticky/fixed element resolves its offset against the
    // current scroll position, so for a stitched full-page image the reset
    // must land before the capture or the element renders shifted by scrollY.
    assert.deepEqual(
      calls.map((call) => (call.startsWith('evaluate') ? 'evaluate' : call)),
      ['evaluate', 'screenshot'],
    );
  });

  it('scrolls to the top-left corner instantly for fullPage', async () => {
    const { page, calls } = fakePage();

    await capturePage(page, [], 'fullPage');

    const scroll = calls.find((call) => call.startsWith('evaluate:'));
    assert.ok(scroll, 'expected a scroll evaluate call');
    assert.match(
      scroll,
      /scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/,
    );
  });

  it('does not touch scroll for a viewport capture', async () => {
    const { page, calls } = fakePage();

    await capturePage(page);

    // A viewport shot captures exactly the box the flow scrolled to, so
    // resetting the offset would discard the region the story navigated to.
    // Only the shutter fires; no scroll.
    assert.deepEqual(calls, ['screenshot']);
  });

  it('defaults to a viewport-only capture (fullPage: false)', async () => {
    const { page, options } = fakePage();

    await capturePage(page);

    assert.equal(options[0]?.fullPage, false);
  });

  it('composites the whole document when mode is fullPage', async () => {
    const { page, options } = fakePage();

    await capturePage(page, [], 'fullPage');

    assert.equal(options[0]?.fullPage, true);
  });
});

/**
 * A fake page whose scroll-reset evaluate returns fixed layout dimensions ;
 * exactly what the real page-context measurement hands back; so the full-page
 * area guard can be exercised without a browser.
 */
function fakePageWithDimensions(dimensions: {
  width: number;
  height: number;
}): { page: Page; calls: string[] } {
  const calls: string[] = [];
  const page = {
    async evaluate(): Promise<unknown> {
      calls.push('evaluate');
      return dimensions;
    },
    async screenshot(): Promise<Buffer> {
      calls.push('screenshot');
      return Buffer.from('png');
    },
  } as unknown as Page;
  return { page, calls };
}

describe('capturePage: full-page area guard', () => {
  it('throws FullPageTooLargeError before shooting when the page exceeds the cap', async () => {
    const { page, calls } = fakePageWithDimensions({
      width: 1280,
      height: 40_000,
    });

    await assert.rejects(
      capturePage(page, [], 'fullPage', {
        maxPixels: 30_000_000,
        label: 'story "tall.json" action "scroll" (desktop)',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FullPageTooLargeError);
        assert.equal(error.width, 1280);
        assert.equal(error.height, 40_000);
        assert.equal(error.maxPixels, 30_000_000);
        // Actionable message: names the capture, the dimensions, and a remedy.
        assert.match(error.message, /tall\.json/);
        assert.match(error.message, /1280x40000/);
        assert.match(error.message, /maxFullPagePixels/);
        return true;
      },
    );

    // The shutter must NOT fire once the guard trips; that is the whole point,
    // to avoid compositing the oversized image at all.
    assert.ok(
      !calls.includes('screenshot'),
      'screenshot must not be taken when the guard rejects',
    );
  });

  it('captures normally when the full page is under the cap', async () => {
    const { page, calls } = fakePageWithDimensions({
      width: 1280,
      height: 4000,
    });

    const buffer = await capturePage(page, [], 'fullPage', {
      maxPixels: 30_000_000,
      label: 'story "long.json" action "scroll" (desktop)',
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(calls, ['evaluate', 'screenshot']);
  });

  it('captures at the exact cap: the guard is strict >, so area === maxPixels passes', async () => {
    const { page, calls } = fakePageWithDimensions({
      width: 3000,
      height: 10_000,
    });

    // area = 3000 × 10_000 = 30_000_000, exactly the cap. The guard rejects on
    // `area > maxPixels`, so the exact-boundary page is NOT rejected (off-by-one
    // pin: === passes, only a strictly larger page throws).
    const buffer = await capturePage(page, [], 'fullPage', {
      maxPixels: 30_000_000,
      label: 'story "exact.json" action "scroll" (desktop)',
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(calls, ['evaluate', 'screenshot']);
  });

  it('never measures or guards a viewport capture', async () => {
    const { page, calls } = fakePageWithDimensions({
      width: 99_999,
      height: 99_999,
    });

    // A cap far below the page's dimensions; but viewport mode is already
    // bounded by the breakpoint, so the guard must not even measure.
    const buffer = await capturePage(page, [], 'viewport', {
      maxPixels: 1,
      label: 'story "wide.json" action "open" (desktop)',
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(calls, ['screenshot']);
  });
});
