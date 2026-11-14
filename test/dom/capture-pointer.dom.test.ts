/**
 * Real-browser proof that a capture clears the hover a click leaves behind.
 * Not part of `npm test`; run it with `npm run test:dom`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

import { capturePage } from '../../src/screenshots/capture.ts';

const HOVER_TARGET_PAGE = `
  <style>
    body { margin: 0; }
    button { display: block; width: 200px; height: 100px; border: 0; background: rgb(0, 0, 255); }
    button:hover { background: rgb(255, 0, 0); }
  </style>
  <button type="button">target</button>
`;

test('a capture never paints the hover state of whatever sits under the pointer', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 400, height: 300 },
    });
    await page.setContent(HOVER_TARGET_PAGE, { waitUntil: 'load' });
    await page.mouse.move(100, 50);

    const isHoveredBeforeCapture = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            document: { querySelector: (selector: string) => unknown };
          }
        ).document.querySelector('button:hover') !== null,
    );
    assert.ok(isHoveredBeforeCapture, 'the setup must start with a hover');

    const image = PNG.sync.read(await capturePage(page));
    const offset = (50 * image.width + 100) * 4;
    const red = image.data[offset] ?? 0;
    const blue = image.data[offset + 2] ?? 0;

    // the host color profile shifts exact values, so compare channels
    assert.ok(
      blue > red,
      `expected the resting blue, got rgb(${red}, _, ${blue})`,
    );
  } finally {
    await browser.close();
  }
});
