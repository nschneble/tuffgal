import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { StoryFile } from '../schema/load.ts';
import { computeFlowCoverage } from './flows.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tuffgal-flows-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function story(flow?: string): StoryFile {
  return {
    file: `${flow ?? 'none'}.json`,
    story: { story: flow ?? 'none', actions: [{ action: 'noop' }], flow },
  };
}

const INVENTORY = [
  '| Journey | Notes |',
  '| --- | --- |',
  '| Sign in | auth |',
  '| Check out | cart |',
  '',
  'Some prose after the table.',
].join('\n');

describe('computeFlowCoverage', () => {
  it('returns full coverage when no inventory path is configured', async () => {
    const result = await computeFlowCoverage(undefined, [story('Sign in')]);
    assert.deepEqual(result, { total: 0, covered: 0, ratio: 1, missing: [] });
  });

  it('returns full coverage when the inventory file cannot be read', async () => {
    const result = await computeFlowCoverage(join(dir, 'does-not-exist.md'), [
      story('Sign in'),
    ]);
    assert.equal(result.ratio, 1);
    assert.equal(result.total, 0);
  });

  it('counts covered journeys and lists missing ones (case/space-insensitive)', async () => {
    const path = join(dir, 'flows.md');
    await writeFile(path, INVENTORY, 'utf8');
    const result = await computeFlowCoverage(path, [story('  sign   IN ')]);
    assert.equal(result.total, 2);
    assert.equal(result.covered, 1);
    assert.deepEqual(result.missing, ['Check out']);
    assert.equal(result.ratio, 0.5);
  });

  it('returns ratio 1 (not NaN) for a table with zero journey rows', async () => {
    const path = join(dir, 'empty.md');
    await writeFile(path, '| Journey | Notes |\n| --- | --- |\n', 'utf8');
    const result = await computeFlowCoverage(path, []);
    assert.equal(result.total, 0);
    assert.equal(result.ratio, 1);
  });
});
