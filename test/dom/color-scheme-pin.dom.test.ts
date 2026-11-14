/**
 * Real-browser proof that the launch pin keeps `prefers-color-scheme` on the
 * configured scheme once Playwright's emulation override is gone.
 * Not part of `npm test`; run it with `npm run test:dom`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

import { resolveLaunchOptions } from '../../src/runner/run.ts';

type MediaScope = {
  matchMedia: (query: string) => { matches: boolean };
};

for (const colorScheme of ['dark', 'light'] as const) {
  test(`a ${colorScheme} run stays ${colorScheme} when emulation is dropped`, async () => {
    const browser = await chromium.launch(
      resolveLaunchOptions({ browserArgs: [], colorScheme }, { headed: false }),
    );
    try {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: null });

      const matchesConfigured = await page.evaluate(
        (query) =>
          (globalThis as unknown as MediaScope).matchMedia(query).matches,
        `(prefers-color-scheme: ${colorScheme})`,
      );

      assert.ok(matchesConfigured);
    } finally {
      await browser.close();
    }
  });
}
