import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { init } from './init.ts';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'tuffgal-init-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function gitignore(): Promise<string> {
  return readFile(join(cwd, 'tuffgal', '.gitignore'), 'utf8');
}

describe('init — .gitignore scaffold', () => {
  it('ignores the local cache dir alongside .auth/ and report/', async () => {
    await init({ cwd });
    const contents = await gitignore();
    // Every generated-artifact dir the tool writes is ignored so a developer
    // never commits per-machine cache pixels, auth state, or reports.
    assert.match(contents, /^\.auth\/$/m);
    assert.match(contents, /^\.cache\/$/m);
    assert.match(contents, /^report\/$/m);
  });

  it('re-running init does not duplicate the cache entry', async () => {
    await init({ cwd });
    const first = await gitignore();
    // A second init after deleting only the config leaves the existing
    // .gitignore untouched (it is not overwritten), so no entry is duplicated.
    await rm(join(cwd, 'tuffgal.config.ts'));
    await init({ cwd });
    const second = await gitignore();

    assert.equal(second, first);
    const cacheLines = second.split('\n').filter((line) => line === '.cache/');
    assert.equal(cacheLines.length, 1);
  });

  it('scaffolds a config whose commented localCache default matches the .cache entry', async () => {
    await init({ cwd });
    const config = await readFile(join(cwd, 'tuffgal.config.ts'), 'utf8');
    // The scaffolded config documents the cache path the .gitignore ignores, so
    // a developer who uncomments it does not silently un-ignore the cache.
    assert.match(config, /localCache: 'tuffgal\/\.cache'/);
  });
});
