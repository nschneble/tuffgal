import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ssim as computeSsim } from 'ssim.js';

export interface DiffScore {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  /**
   * Mean Structural Similarity score for the two images. 1.0 = identical;
   * 0.99 = very close (sub-pixel layout shifts, font rendering); 0.95 =
   * noticeable change; under 0.9 = obvious change. SSIM is more
   * perceptually accurate than pixel-by-pixel diffing because it weights
   * pixels by their structural context.
   */
  ssimScore: number;
}

/**
 * Diffing is split into two phases so the common case stays cheap:
 *
 *   1. {@link scoreDiff} — the gate. Computes SSIM (the pass/changed
 *      decision) plus the pixel metrics reported on every outcome
 *      (`diffPixels`, `diffRatio`). It runs pixelmatch in count-only mode
 *      (no output buffer) and never encodes a diff image.
 *   2. {@link renderDiffOverlay} — the visualisation. Runs pixelmatch again
 *      with an output buffer and deflate-encodes the red-highlight overlay
 *      PNG for the human-facing report.
 *
 * The overlay is only kept when a comparison FAILS; a passing comparison
 * deletes it. Because passing is the common case in a healthy suite,
 * encoding the overlay on every comparison was pure waste — so the caller
 * runs {@link scoreDiff} unconditionally and reaches for
 * {@link renderDiffOverlay} only on the changed branch, where the image is
 * actually written.
 */
export function scoreDiff(
  baseline: Buffer,
  actual: Buffer,
  pixelThreshold: number,
): DiffScore {
  const { baselinePng, actualPng } = decodePair(baseline, actual);
  // Count-only: passing `undefined` as the output buffer makes pixelmatch
  // tally differing pixels without allocating or filling an overlay — the
  // metric feeds `diffPixels`/`diffRatio` reporting, not a written image.
  const diffPixels = pixelmatch(
    baselinePng.data,
    actualPng.data,
    undefined,
    baselinePng.width,
    baselinePng.height,
    { threshold: pixelThreshold },
  );
  const totalPixels = baselinePng.width * baselinePng.height;
  const ssimResult = computeSsim(
    {
      data: new Uint8ClampedArray(
        baselinePng.data.buffer,
        baselinePng.data.byteOffset,
        baselinePng.data.byteLength,
      ),
      width: baselinePng.width,
      height: baselinePng.height,
    },
    {
      data: new Uint8ClampedArray(
        actualPng.data.buffer,
        actualPng.data.byteOffset,
        actualPng.data.byteLength,
      ),
      width: actualPng.width,
      height: actualPng.height,
    },
    { ssim: 'bezkrovny' },
  );
  return {
    diffPixels,
    totalPixels,
    diffRatio: diffPixels / totalPixels,
    ssimScore: ssimResult.mssim,
  };
}

/**
 * Renders the red-highlight overlay PNG for the report. This is the
 * expensive half — pixelmatch fills an output buffer and `PNG.sync.write`
 * deflate-encodes it — so it runs only on the changed/failed branch where
 * the diff image is actually written to disk.
 *
 * The pixel metrics are the caller's from {@link scoreDiff}; this returns
 * only the encoded overlay bytes.
 */
export function renderDiffOverlay(
  baseline: Buffer,
  actual: Buffer,
  pixelThreshold: number,
): Buffer {
  const { baselinePng, actualPng } = decodePair(baseline, actual);
  const diffPng = new PNG({
    width: baselinePng.width,
    height: baselinePng.height,
  });
  pixelmatch(
    baselinePng.data,
    actualPng.data,
    diffPng.data,
    baselinePng.width,
    baselinePng.height,
    { threshold: pixelThreshold },
  );
  return PNG.sync.write(diffPng);
}

/**
 * Decodes both PNG buffers and enforces the invariants both diff phases
 * share: dimensions must match and the pixel data must be tightly-packed
 * RGBA. Dimension mismatch is a regression on its own — fail loudly.
 */
function decodePair(
  baseline: Buffer,
  actual: Buffer,
): { baselinePng: PNG; actualPng: PNG } {
  const baselinePng = PNG.sync.read(baseline);
  const actualPng = PNG.sync.read(actual);
  if (
    baselinePng.width !== actualPng.width ||
    baselinePng.height !== actualPng.height
  ) {
    throw new ScreenshotSizeMismatchError(
      { width: baselinePng.width, height: baselinePng.height },
      { width: actualPng.width, height: actualPng.height },
    );
  }
  // SSIM and pixelmatch both assume tightly-packed RGBA (4 bytes/pixel). If a
  // future pngjs option changed channel depth, the buffer view and the
  // width/height would silently disagree and produce a garbage score rather
  // than throwing. Fail loudly instead.
  assertPackedRgba(baselinePng);
  assertPackedRgba(actualPng);
  return { baselinePng, actualPng };
}

function assertPackedRgba(png: PNG): void {
  const expected = png.width * png.height * 4;
  if (png.data.byteLength !== expected) {
    throw new Error(
      `Unexpected PNG pixel format: ${png.width}x${png.height} should be ${expected} bytes (RGBA) but buffer is ${png.data.byteLength}`,
    );
  }
}

export class ScreenshotSizeMismatchError extends Error {
  readonly baseline: { width: number; height: number };
  readonly actual: { width: number; height: number };
  constructor(
    baseline: { width: number; height: number },
    actual: { width: number; height: number },
  ) {
    super(
      `Screenshot dimensions changed: baseline ${baseline.width}x${baseline.height}, actual ${actual.width}x${actual.height}`,
    );
    this.name = 'ScreenshotSizeMismatchError';
    this.baseline = baseline;
    this.actual = actual;
  }
}
