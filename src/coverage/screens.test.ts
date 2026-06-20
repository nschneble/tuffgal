import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { computeScreenCoverage } from './screens.ts';

let root: string;
let actionsDir: string;
let baselinesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuffgal-screens-'));
  actionsDir = join(root, 'actions');
  baselinesDir = join(root, 'baselines');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function screen(name: string): Promise<void> {
  const dir = join(actionsDir, 'screens');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), '{}', 'utf8');
}

async function baseline(name: string): Promise<void> {
  const dir = join(baselinesDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '0.png'), 'fake', 'utf8');
}

describe('computeScreenCoverage', () => {
  it('returns full coverage when the screens directory is absent', async () => {
    const result = await computeScreenCoverage(actionsDir, baselinesDir);
    assert.deepEqual(result, { total: 0, covered: 0, ratio: 1, missing: [] });
  });

  it('marks screens without a committed baseline as missing', async () => {
    await screen('visit-home');
    await screen('visit-settings');
    await baseline('visit-home');

    const result = await computeScreenCoverage(actionsDir, baselinesDir);
    assert.equal(result.total, 2);
    assert.equal(result.covered, 1);
    assert.deepEqual(result.missing, ['visit-settings']);
    assert.equal(result.ratio, 0.5);
  });

  it('returns ratio 1 (not NaN) when there are zero screens', async () => {
    await mkdir(join(actionsDir, 'screens'), { recursive: true });
    const result = await computeScreenCoverage(actionsDir, baselinesDir);
    assert.equal(result.total, 0);
    assert.equal(result.ratio, 1);
  });
});
