import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Page } from 'playwright';
import { capturePage } from './capture.ts';

/**
 * A minimal stand-in for the bits of `Page` that `capturePage` touches. It
 * records the order of calls so the test can prove the scroll reset happens
 * before the shutter — the whole point of the fix is that ordering.
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
    // Only the shutter fires — no scroll.
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
