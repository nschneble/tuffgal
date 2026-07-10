import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PNG } from 'pngjs';

import type { ResolvedConfig } from '../config.ts';
import type { EnvironmentManifest } from './manifest.ts';
import { CAPTURE_SCHEMA, SCHEMA_VERSION } from './manifest.ts';
import type { DeletedBaseline, RunResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import { approveFrom, ApproveFromError } from './approve.ts';

let root: string;
let candidateDir: string;
let baselinesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuffgal-approvefrom-'));
  candidateDir = join(root, 'candidates');
  baselinesDir = join(root, 'baselines');
  await mkdir(candidateDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(): ResolvedConfig {
  return {
    paths: { baselines: baselinesDir },
  } as unknown as ResolvedConfig;
}

/** A real, decodable PNG whose pixels vary per position (a non-trivial image). */
function realPng(seed: number): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const i = (y * 4 + x) * 4;
      png.data[i] = (x * 31 + seed) % 256;
      png.data[i + 1] = (y * 17 + seed) % 256;
      png.data[i + 2] = (x * y + seed) % 256;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function environment(): EnvironmentManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    captureSchema: CAPTURE_SCHEMA,
    tuffgalVersion: '9.9.9',
    playwrightVersion: '1.49.0',
    browser: 'chromium',
    browserVersion: '131.0.0.0',
    platform: 'linux',
    captureMode: 'viewport',
    breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
    deviceScaleFactor: 1,
    frozenTime: '2026-01-15T12:00:00.000Z',
  };
}

/**
 * Writes a `results.json` into the candidate tree. Callers override the
 * `environment` and `deleted` fields; everything else is inert filler that
 * clears `parseRunResult`'s shallow shape check.
 */
async function writeCandidateResults(
  overrides: Partial<Pick<RunResult, 'environment' | 'deleted'>> = {},
): Promise<void> {
  const results = {
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:01.000Z',
    durationMs: 1000,
    mode: 'ci',
    totals: {
      stories: 0,
      passed: 0,
      changed: 0,
      failed: 0,
      new: 0,
      deleted: 0,
    },
    environment:
      'environment' in overrides
        ? overrides.environment
        : {
            expected: null,
            actual: environment(),
            mismatch: false,
            mismatchKeys: [],
          },
    deleted: overrides.deleted ?? [],
    customCoverage: {
      screens: { total: 0, covered: 0, ratio: 1, missing: [] },
      flows: { total: 0, covered: 0, ratio: 1, missing: [] },
    },
    stories: [],
  };
  await writeFile(
    join(candidateDir, 'results.json'),
    JSON.stringify(results),
    'utf8',
  );
}

/** Writes a candidate PNG (+ optional a11y companion) under `<action>/`. */
async function writeCandidatePng(
  action: string,
  breakpoint: string,
  seed = 1,
  a11y?: string,
): Promise<Buffer> {
  const dir = join(candidateDir, action);
  await mkdir(dir, { recursive: true });
  const bytes = realPng(seed);
  await writeFile(join(dir, `${breakpoint}.png`), bytes);
  if (a11y !== undefined) {
    await writeFile(join(dir, `${breakpoint}.a11y.yaml`), a11y, 'utf8');
  }
  return bytes;
}

/** Recursively lists a directory tree as a sorted snapshot of `relpath => bytes`. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else {
        out.set(rel, (await readFile(abs)).toString('base64'));
      }
    }
  }
  await walk(dir, '');
  return out;
}

/**
 * Asserts a failing `approveFrom` left `baselinesDir` byte-identical. Seeds a
 * pre-existing baseline so "zero writes" is a real invariant, not a vacuous
 * empty-vs-empty check.
 */
async function assertZeroWrites(
  run: () => Promise<unknown>,
  message: RegExp,
): Promise<void> {
  await mkdir(join(baselinesDir, 'existing'), { recursive: true });
  await writeFile(join(baselinesDir, 'existing', 'desktop.png'), 'keep-me');
  const before = await snapshot(baselinesDir);
  await assert.rejects(run(), (error: unknown) => {
    assert.ok(error instanceof ApproveFromError, 'expected ApproveFromError');
    assert.match(error.message, message);
    return true;
  });
  const after = await snapshot(baselinesDir);
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
}

describe('approveFrom — happy path', () => {
  it('promotes a candidate tree into baselines and writes the manifest', async () => {
    const bytes = await writeCandidatePng('open', 'desktop', 1, 'tree-open');
    await writeCandidateResults();

    const summary = await approveFrom(config(), { from: candidateDir });
    assert.equal(summary.written, 1);
    assert.equal(summary.pruned, 0);

    // Pixels round-trip identically through the recompress write path.
    const written = await readFile(join(baselinesDir, 'open', 'desktop.png'));
    assert.deepEqual(
      PNG.sync.read(written).data,
      PNG.sync.read(bytes).data,
      'promoted PNG decodes to the same pixels',
    );
    // a11y companion travels alongside.
    assert.equal(
      await readFile(join(baselinesDir, 'open', 'desktop.a11y.yaml'), 'utf8'),
      'tree-open',
    );
    // Manifest written from environment.actual, schema stamped from constants.
    const manifest = JSON.parse(
      await readFile(join(baselinesDir, 'manifest.json'), 'utf8'),
    ) as EnvironmentManifest;
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.equal(manifest.captureSchema, CAPTURE_SCHEMA);
    assert.equal(manifest.platform, 'linux');
    assert.equal(manifest.browserVersion, '131.0.0.0');
  });

  it('overwrites an existing baseline entry', async () => {
    await mkdir(join(baselinesDir, 'open'), { recursive: true });
    await writeFile(join(baselinesDir, 'open', 'desktop.png'), 'stale');
    const bytes = await writeCandidatePng('open', 'desktop', 2);
    await writeCandidateResults();

    await approveFrom(config(), { from: candidateDir });
    const written = await readFile(join(baselinesDir, 'open', 'desktop.png'));
    assert.deepEqual(PNG.sync.read(written).data, PNG.sync.read(bytes).data);
  });

  it('refreshes a pre-existing manifest with the new environment', async () => {
    await mkdir(baselinesDir, { recursive: true });
    await writeFile(
      join(baselinesDir, 'manifest.json'),
      JSON.stringify({ ...environment(), platform: 'darwin' }),
      'utf8',
    );
    await writeCandidatePng('open', 'desktop');
    await writeCandidateResults();

    await approveFrom(config(), { from: candidateDir });
    const manifest = JSON.parse(
      await readFile(join(baselinesDir, 'manifest.json'), 'utf8'),
    ) as EnvironmentManifest;
    assert.equal(manifest.platform, 'linux');
  });
});

describe('approveFrom — prune', () => {
  it('deletes orphaned baselines listed in results.deleted', async () => {
    // Seed an orphan (PNG + companion) plus a live baseline that must survive.
    await mkdir(join(baselinesDir, 'gone'), { recursive: true });
    await writeFile(join(baselinesDir, 'gone', 'desktop.png'), 'orphan');
    await writeFile(join(baselinesDir, 'gone', 'desktop.a11y.yaml'), 'orphan');
    await mkdir(join(baselinesDir, 'keep'), { recursive: true });
    await writeFile(join(baselinesDir, 'keep', 'desktop.png'), 'live');

    await writeCandidatePng('open', 'desktop');
    const deleted: DeletedBaseline[] = [
      {
        action: 'gone',
        breakpoint: 'desktop',
        // Absolute paths from another machine — must be IGNORED by prune.
        baselinePaths: ['/evil/gone/desktop.png'],
      },
    ];
    await writeCandidateResults({ deleted });

    const summary = await approveFrom(config(), {
      from: candidateDir,
      prune: true,
    });
    assert.equal(summary.pruned, 1);
    assert.equal(
      await pathExists(join(baselinesDir, 'gone', 'desktop.png')),
      false,
    );
    assert.equal(
      await pathExists(join(baselinesDir, 'gone', 'desktop.a11y.yaml')),
      false,
    );
    // Non-listed baseline untouched.
    assert.equal(
      await pathExists(join(baselinesDir, 'keep', 'desktop.png')),
      true,
    );
  });

  it('prunes legacy (0.png / a11y.yaml) orphans', async () => {
    await mkdir(join(baselinesDir, 'old'), { recursive: true });
    await writeFile(join(baselinesDir, 'old', '0.png'), 'legacy');
    await writeFile(join(baselinesDir, 'old', 'a11y.yaml'), 'legacy');
    await writeCandidatePng('open', 'desktop');
    await writeCandidateResults({
      deleted: [{ action: 'old', breakpoint: 'legacy', baselinePaths: [] }],
    });

    await approveFrom(config(), { from: candidateDir, prune: true });
    assert.equal(await pathExists(join(baselinesDir, 'old', '0.png')), false);
    assert.equal(
      await pathExists(join(baselinesDir, 'old', 'a11y.yaml')),
      false,
    );
  });

  it('does not prune when --prune is absent', async () => {
    await mkdir(join(baselinesDir, 'gone'), { recursive: true });
    await writeFile(join(baselinesDir, 'gone', 'desktop.png'), 'orphan');
    await writeCandidatePng('open', 'desktop');
    await writeCandidateResults({
      deleted: [{ action: 'gone', breakpoint: 'desktop', baselinePaths: [] }],
    });

    const summary = await approveFrom(config(), { from: candidateDir });
    assert.equal(summary.pruned, 0);
    assert.equal(
      await pathExists(join(baselinesDir, 'gone', 'desktop.png')),
      true,
    );
  });
});

describe('approveFrom — fail closed (zero writes)', () => {
  it('rejects a stray top-level file (.sh)', async () => {
    await writeCandidatePng('open', 'desktop');
    await writeCandidateResults();
    await writeFile(join(candidateDir, 'evil.sh'), 'rm -rf /', 'utf8');
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /unexpected top-level file/,
    );
  });

  it('rejects a stray file inside an action dir (.html)', async () => {
    await writeCandidatePng('open', 'desktop');
    await writeFile(join(candidateDir, 'open', 'x.html'), '<b>', 'utf8');
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /unexpected file in candidate tree/,
    );
  });

  it('rejects a nested-too-deep path', async () => {
    await writeCandidatePng('open', 'desktop');
    await mkdir(join(candidateDir, 'open', 'deeper'), { recursive: true });
    await writeFile(join(candidateDir, 'open', 'deeper', 'x.png'), 'x');
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /unexpected non-file entry/,
    );
  });

  it('rejects an invalid action name (uppercase)', async () => {
    await writeCandidatePng('BadName', 'desktop');
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /invalid action directory name/,
    );
  });

  it('rejects an invalid breakpoint stem', async () => {
    const dir = join(candidateDir, 'open');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'has spaces.png'), realPng(1));
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /invalid breakpoint name/,
    );
  });

  it('rejects a corrupt PNG payload', async () => {
    const dir = join(candidateDir, 'open');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'desktop.png'), 'not-a-png', 'utf8');
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /not a decodable PNG/,
    );
  });

  it('rejects a missing results.json', async () => {
    await writeCandidatePng('open', 'desktop');
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /missing results\.json/,
    );
  });

  it('rejects results.json with no environment block', async () => {
    await writeCandidatePng('open', 'desktop');
    await writeCandidateResults({ environment: undefined });
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /no environment block/,
    );
  });

  it('rejects a symlinked candidate file', async () => {
    const dir = join(candidateDir, 'open');
    await mkdir(dir, { recursive: true });
    const target = join(root, 'outside.png');
    await writeFile(target, realPng(1));
    await symlink(target, join(dir, 'desktop.png'));
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /symlink not allowed/,
    );
  });

  it('rejects a dotfile', async () => {
    await writeCandidatePng('open', 'desktop');
    await writeFile(join(candidateDir, '.env'), 'SECRET=1', 'utf8');
    await writeCandidateResults();
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir }),
      /dotfile/,
    );
  });

  it('rejects a --from directory that does not exist', async () => {
    await assert.rejects(
      approveFrom(config(), { from: join(root, 'nope') }),
      /directory not found/,
    );
  });
});

describe('approveFrom — prune safety', () => {
  it('never deletes outside baselines even for a traversal action name', async () => {
    await writeCandidatePng('open', 'desktop');
    // An invalid action name in results.deleted must abort before any delete.
    await writeCandidateResults({
      deleted: [
        { action: '../../etc', breakpoint: 'desktop', baselinePaths: [] },
      ],
    });
    await assertZeroWrites(
      () => approveFrom(config(), { from: candidateDir, prune: true }),
      /invalid action name/,
    );
  });
});
