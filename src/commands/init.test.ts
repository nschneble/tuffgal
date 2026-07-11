import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../config.ts';
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

  it('the REAL resolved localCache default lands where the scaffolded .gitignore ignores it', async () => {
    await init({ cwd });
    // Comment-vs-gitignore is not enough: a developer who leaves `localCache`
    // OFF gets `resolveConfig`'s default, and THAT is what must fall inside the
    // ignored `tuffgal/.cache/`. Load a config that mirrors the scaffold's
    // `paths` block but omits `localCache`, so the resolved value is the true
    // default — then assert it sits under the `tuffgal/` dir the scaffolded
    // `.gitignore` (with its `.cache/` line) actually covers. If the default
    // ever drifts back to `<configDir>/.cache`, this fails.
    //
    // The scaffolded `.ts` config imports from `'tuffgal'`, which is not
    // resolvable from this tmpdir; drop it and load a plain `.js` mirror of its
    // `paths` block instead, so `loadConfig` exercises the real `resolveConfig`
    // default without a module-resolution detour. The gitignore under test is
    // the one `init` already wrote.
    await rm(join(cwd, 'tuffgal.config.ts'));
    await writeFile(
      join(cwd, 'tuffgal.config.js'),
      `export default {
        paths: {
          actions: 'tuffgal/actions',
          stories: 'tuffgal/stories',
          baselines: 'tuffgal/baselines',
          report: 'tuffgal/report',
        },
        baseUrl: 'http://localhost:3000',
      };`,
      'utf8',
    );
    const resolved = await loadConfig(cwd);

    // The gitignore lives at `tuffgal/.gitignore`; its `.cache/` entry ignores
    // `tuffgal/.cache/`. Prove that path is exactly where the default resolved.
    const gitignoreDir = dirname(join(cwd, 'tuffgal', '.gitignore'));
    assert.match(await gitignore(), /^\.cache\/$/m);
    assert.equal(resolved.paths.localCache, join(gitignoreDir, '.cache'));
  });
});
