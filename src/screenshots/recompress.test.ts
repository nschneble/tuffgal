import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PNG } from 'pngjs';

import { scoreDiff } from './diff.ts';
import {
  readBaseline,
  recompressPng,
  writeDurablePng,
  writeTransientPng,
} from './baselineStore.ts';

/**
 * Builds a real encoded PNG whose pixels are a deterministic gradient/noise mix.
 * A flat solid colour compresses to almost nothing and hides size differences,
 * so this fixture varies every channel per pixel; representative of the busy,
 * high-frequency captures the recompress pass actually targets. The default
 * pngjs encoder here mirrors nothing about the source encoder Playwright uses;
 * we deliberately hand recompress a buffer it can improve on by first writing
 * the fixture with the *worst* settings (level 0, no filtering) so the size
 * assertion exercises a real win rather than a no-op tie.
 */
function noisyPng(
  width: number,
  height: number,
  options?: { deflateLevel?: number; filterType?: number },
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 7 + y * 3) % 256;
      png.data[i + 1] = (x * 3 + y * 11) % 256;
      png.data[i + 2] = (x * 5 + y * 13) % 256;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, options);
}

/** Reads a PNG buffer back to its raw RGBA pixel bytes for exact comparison. */
function pixelsOf(png: Buffer): Buffer {
  return PNG.sync.read(png).data;
}

describe('recompressPng: losslessness', () => {
  it('decodes pixel-identical to the input (round-trip)', () => {
    const input = noisyPng(64, 48);
    const output = recompressPng(input);

    assert.deepEqual(
      pixelsOf(output),
      pixelsOf(input),
      'recompressed PNG must decode to the same RGBA pixels as the input',
    );
  });

  it('preserves dimensions and full alpha channel', () => {
    const input = noisyPng(20, 10);
    const decoded = PNG.sync.read(recompressPng(input));

    assert.equal(decoded.width, 20);
    assert.equal(decoded.height, 10);
    // Every pixel in the fixture is fully opaque; a palette-quantise or
    // colour-type downgrade would drop or alter the alpha channel.
    for (let i = 3; i < decoded.data.length; i += 4) {
      assert.equal(decoded.data[i], 255);
    }
  });
});

describe('recompressPng: size', () => {
  it('is no larger than the input for a representative fixture', () => {
    // Encode the fixture with the weakest settings pngjs offers, then recompress.
    const bloated = noisyPng(96, 96, { deflateLevel: 0, filterType: 0 });
    const output = recompressPng(bloated);

    assert.ok(
      output.length <= bloated.length,
      `recompressed (${output.length}B) must not exceed input (${bloated.length}B)`,
    );
    assert.ok(
      output.length < bloated.length,
      'a level-0/no-filter fixture should actually shrink under recompress',
    );
  });

  it('returns the original buffer unchanged when recompress would grow it', () => {
    // A buffer already at the recompressor's own settings cannot get smaller;
    // recompress must hand back the identical bytes, never a larger re-encode.
    const alreadyOptimal = noisyPng(32, 32);
    const output = recompressPng(alreadyOptimal);

    assert.ok(output.length <= alreadyOptimal.length);
    assert.deepEqual(
      pixelsOf(output),
      pixelsOf(alreadyOptimal),
      'pixels stay identical even when the smaller buffer is kept',
    );
  });

  it('returns a non-PNG buffer untouched rather than throwing', () => {
    const garbage = Buffer.from('not a png at all');
    assert.equal(recompressPng(garbage), garbage);
  });
});

describe('writeDurablePng: recompress integration', () => {
  it('recompresses a durable write and stays readable by the diff path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tuffgal-recompress-'));
    try {
      const source = noisyPng(48, 48, { deflateLevel: 0, filterType: 0 });
      const path = join(dir, 'action', 'desktop.png');
      await writeDurablePng(path, source);

      const onDisk = await readFile(path);
      // writeDurablePng routed the bytes through recompressPng, so the file is
      // the recompressed (strictly smaller here) form, not the bloated source.
      assert.ok(
        onDisk.length < source.length,
        `durable write should shrink the level-0 fixture (${onDisk.length}B vs ${source.length}B)`,
      );

      // The written baseline must round-trip through the exact read helper and
      // diff core the runner uses; same file, zero pixel diff, perfect SSIM.
      const readBack = await readBaseline(path);
      assert.ok(
        readBack !== undefined,
        'readBaseline must find the written PNG',
      );
      assert.deepEqual(pixelsOf(readBack), pixelsOf(source));

      const { score } = scoreDiff(readBack, source, { pixelThreshold: 0.1 });
      assert.equal(score.diffPixels, 0);
      assert.ok(score.ssimScore >= 0.9999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeTransientPng: skips recompress', () => {
  it('writes the given bytes verbatim, without the recompress pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tuffgal-transient-'));
    try {
      // A deliberately bloated (level-0, no-filter) source: a durable write
      // would shrink it, so if the transient file matches the source byte-for-
      // byte we have proven no recompress ran.
      const source = noisyPng(48, 48, { deflateLevel: 0, filterType: 0 });
      const path = join(dir, 'story', 'action.desktop.actual.png');
      await writeTransientPng(path, source);

      const onDisk = await readFile(path);
      assert.equal(
        onDisk.length,
        source.length,
        'transient write must not shrink the source; no recompress',
      );
      assert.deepEqual(
        onDisk,
        source,
        'transient write must land the source bytes verbatim',
      );

      // Still a valid, diff-consumable PNG despite skipping recompress.
      const readBack = await readBaseline(path);
      assert.ok(readBack !== undefined);
      assert.deepEqual(pixelsOf(readBack), pixelsOf(source));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('durable and transient writes of the same bloated source differ in size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tuffgal-both-'));
    try {
      const source = noisyPng(64, 64, { deflateLevel: 0, filterType: 0 });
      const durablePath = join(dir, 'durable.png');
      const transientPath = join(dir, 'transient.png');
      await writeDurablePng(durablePath, source);
      await writeTransientPng(transientPath, source);

      const durable = await readFile(durablePath);
      const transient = await readFile(transientPath);
      // Same pixels, different bytes: the durable write paid the recompress and
      // shrank; the transient one kept the bloated source as-is.
      assert.ok(
        durable.length < transient.length,
        `durable (${durable.length}B) must be smaller than transient (${transient.length}B)`,
      );
      assert.deepEqual(transient, source);
      assert.deepEqual(pixelsOf(durable), pixelsOf(transient));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
