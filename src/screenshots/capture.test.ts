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
  it('resets scroll to the origin before taking the screenshot', async () => {
    const { page, calls } = fakePage();

    await capturePage(page);

    // Order matters: a sticky/fixed element resolves its offset against the
    // current scroll position, so the reset must land before the capture or
    // the element renders shifted by scrollY in the full-page image.
    assert.deepEqual(
      calls.map((call) => (call.startsWith('evaluate') ? 'evaluate' : call)),
      ['evaluate', 'screenshot'],
    );
  });

  it('scrolls to the top-left corner instantly', async () => {
    const { page, calls } = fakePage();

    await capturePage(page);

    const scroll = calls.find((call) => call.startsWith('evaluate:'));
    assert.ok(scroll, 'expected a scroll evaluate call');
    assert.match(scroll, /scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/);
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
