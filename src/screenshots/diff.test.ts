import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { PNG } from 'pngjs';
import {
  renderDiffOverlay,
  ScreenshotSizeMismatchError,
  scoreDiff,
} from './diff.ts';

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

describe('scoreDiff — zero-diff boundary', () => {
  it('reports no differing pixels and a perfect SSIM for identical images', () => {
    const png = solidPng(16, 16, WHITE);
    const outcome = scoreDiff(png, png, 0.1);

    assert.equal(outcome.diffPixels, 0);
    assert.equal(outcome.diffRatio, 0);
    assert.equal(outcome.totalPixels, 256);
    assert.ok(
      outcome.ssimScore >= 0.9999,
      `expected ssim ~1, got ${outcome.ssimScore}`,
    );
  });
});

describe('scoreDiff — full-diff boundary', () => {
  it('reports every pixel differing and a low SSIM for opposite images', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 16, BLACK);
    const outcome = scoreDiff(baseline, actual, 0.1);

    assert.equal(outcome.diffPixels, 256);
    assert.equal(outcome.diffRatio, 1);
    assert.ok(
      outcome.ssimScore < 0.5,
      `expected low ssim for opposite images, got ${outcome.ssimScore}`,
    );
  });
});

describe('scoreDiff — never encodes an overlay', () => {
  it('does not deflate-encode a diff PNG while scoring, even for a full diff', (t) => {
    const write = t.mock.method(PNG.sync, 'write');
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 16, BLACK);
    // The solidPng fixtures above encode PNGs, but the spy is installed after
    // they are built, so any call it records is scoreDiff's own — and there
    // should be none. Scoring is the common (passing) case; encoding the
    // discarded overlay on every comparison was the waste this split removes.
    const before = write.mock.callCount();
    scoreDiff(baseline, actual, 0.1);

    assert.equal(write.mock.callCount() - before, 0);
  });
});

describe('scoreDiff — dimension mismatch', () => {
  it('throws ScreenshotSizeMismatchError carrying both dimension pairs', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 20, WHITE);

    assert.throws(
      () => scoreDiff(baseline, actual, 0.1),
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

describe('scoreDiff — corrupt input', () => {
  it('propagates the decode failure rather than swallowing it', () => {
    const valid = solidPng(16, 16, WHITE);
    const garbage = Buffer.from('not a png at all');

    assert.throws(() => scoreDiff(garbage, valid, 0.1));
  });
});

describe('renderDiffOverlay — changed branch', () => {
  it('encodes a decodable overlay that marks the differing pixels', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 16, BLACK);
    const overlay = renderDiffOverlay(baseline, actual, 0.1);

    // The overlay is a real, decodable PNG of the same dimensions.
    const decoded = PNG.sync.read(overlay);
    assert.equal(decoded.width, 16);
    assert.equal(decoded.height, 16);

    // Every pixel changed, so pixelmatch paints the whole overlay its diff
    // colour (default red). Sample the first pixel to prove the fill ran.
    assert.equal(decoded.data[0], 255, 'red channel of a differing pixel');
    assert.equal(decoded.data[1], 0, 'green channel of a differing pixel');
    assert.equal(decoded.data[2], 0, 'blue channel of a differing pixel');
  });

  it('deflate-encodes exactly once per overlay', () => {
    const write = mock.method(PNG.sync, 'write');
    try {
      const baseline = solidPng(16, 16, WHITE);
      const actual = solidPng(16, 16, BLACK);
      const before = write.mock.callCount();
      renderDiffOverlay(baseline, actual, 0.1);

      assert.equal(write.mock.callCount() - before, 1);
    } finally {
      write.mock.restore();
    }
  });
});

describe('renderDiffOverlay — dimension mismatch', () => {
  it('throws ScreenshotSizeMismatchError before encoding anything', () => {
    const baseline = solidPng(16, 16, WHITE);
    const actual = solidPng(16, 20, WHITE);

    assert.throws(
      () => renderDiffOverlay(baseline, actual, 0.1),
      ScreenshotSizeMismatchError,
    );
  });
});
