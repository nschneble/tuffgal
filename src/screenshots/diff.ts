import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ssim as computeSsim } from 'ssim.js';

export interface DiffOutcome {
  diffPng: Buffer;
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
 * Compares two PNG buffers. Computes SSIM (the perceptual gate) and a
 * pixelmatch overlay (the visualisation). Both are returned so the
 * runner can use SSIM for pass/changed decisions while the reporter
 * still has a red-highlight diff image to show the human.
 *
 * Dimension mismatch is a regression on its own — fail loudly.
 */
export function diffPngs(
  baseline: Buffer,
  actual: Buffer,
  pixelThreshold: number,
): DiffOutcome {
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
  const diffPng = new PNG({
    width: baselinePng.width,
    height: baselinePng.height,
  });
  const diffPixels = pixelmatch(
    baselinePng.data,
    actualPng.data,
    diffPng.data,
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
    diffPng: PNG.sync.write(diffPng),
    diffPixels,
    totalPixels,
    diffRatio: diffPixels / totalPixels,
    ssimScore: ssimResult.mssim,
  };
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
