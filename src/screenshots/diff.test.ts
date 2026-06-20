import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PNG } from 'pngjs';
import { diffPngs, ScreenshotSizeMismatchError } from './diff.ts';

/**
 * Builds a solid-colour PNG buffer of the given size. The diff core reads PNG
 * buffers and decides pass/changed, so the fixtures here are real encoded PNGs
 * rather than mocks — the same path pngjs takes at runtime.
 */
function solidPng(
  width: number,
  height: number,
  [r, g, b, a]: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    png.data[offset] = r;
    png.data[offset + 1] = g;
    png.data[offset + 2] = b;
    png.data[offset + 3] = a;
  }
  return PNG.sync.write(png);
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

describe('diffPngs — zero-diff boundary', () => {
  it('reports no differing pixels and a perfect SSIM for identical images', () => {
    const png = solidPng(16, 16, WHITE);
    const outcome = diffPngs(png, png, 0.1);

    assert.equal(outcome.diffPixels, 0);
    assert.equal(outcome.diffRatio, 0);
    assert.equal(outcome.totalPixels, 256);
    assert.ok(
      outcome.ssimScore >= 0.9999,
      `expected ssim ~1, got ${outcome.ssimScore}`,
    );
  });
});

describe('diffPngs — full-diff boundary', () => {
  it('reports every pixel differing and a low SSIM for opposite images', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 16, BLACK);
    const outcome = diffPngs(baseline, actual, 0.1);

    assert.equal(outcome.diffPixels, 256);
    assert.equal(outcome.diffRatio, 1);
    assert.ok(
      outcome.ssimScore < 0.5,
      `expected low ssim for opposite images, got ${outcome.ssimScore}`,
    );
  });
});

describe('diffPngs — dimension mismatch', () => {
  it('throws ScreenshotSizeMismatchError carrying both dimension pairs', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 20, WHITE);

    assert.throws(
      () => diffPngs(baseline, actual, 0.1),
      (error: unknown) => {
        assert.ok(error instanceof ScreenshotSizeMismatchError);
        assert.deepEqual(error.baseline, { width: 16, height: 16 });
        assert.deepEqual(error.actual, { width: 16, height: 20 });
        assert.match(error.message, /16x16/);
        assert.match(error.message, /16x20/);
        return true;
      },
    );
  });
});

describe('diffPngs — corrupt input', () => {
  it('propagates the decode failure rather than swallowing it', () => {
    const valid = solidPng(16, 16, WHITE);
    const garbage = Buffer.from('not a png at all');

    assert.throws(() => diffPngs(garbage, valid, 0.1));
  });
});
