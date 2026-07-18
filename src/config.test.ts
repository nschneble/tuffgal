import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  assertValidConfig,
  loadConfig,
  type ResolvedConfig,
} from './config.ts';

const SOURCE = '/fake/tuffgal.config.ts';

function validConfig(): Record<string, unknown> {
  return {
    paths: {
      actions: 'tuffgal/actions',
      stories: 'tuffgal/stories',
      baselines: 'tuffgal/baselines',
      report: 'tuffgal/report',
    },
    baseUrl: 'http://localhost:3000',
  };
}

describe('assertValidConfig', () => {
  it('accepts a minimal valid config', () => {
    assert.doesNotThrow(() => assertValidConfig(validConfig(), SOURCE));
  });

  it('accepts valid optional fields', () => {
    const config = {
      ...validConfig(),
      apiHost: 'http://localhost:4000',
      workers: 4,
      flowInventory: 'docs/flows.md',
    };
    assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
  });

  it('rejects a non-object export, naming the source', () => {
    assert.throws(
      () => assertValidConfig(null, SOURCE),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\/fake\/tuffgal\.config\.ts/);
        return true;
      },
    );
  });

  it('requires paths and its string members', () => {
    assert.throws(() => assertValidConfig({ baseUrl: 'x' }, SOURCE), /paths/);
    const config = validConfig();
    delete (config.paths as Record<string, unknown>).report;
    assert.throws(() => assertValidConfig(config, SOURCE), /paths\.report/);
  });

  it('accepts an optional string paths.localCache', () => {
    const config = validConfig();
    (config.paths as Record<string, unknown>).localCache = 'tuffgal/.cache';
    assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
  });

  it('rejects a non-string paths.localCache', () => {
    const config = validConfig();
    (config.paths as Record<string, unknown>).localCache = 42;
    assert.throws(() => assertValidConfig(config, SOURCE), /paths\.localCache/);
  });

  it('requires a string baseUrl', () => {
    const config = validConfig();
    config.baseUrl = 123;
    assert.throws(() => assertValidConfig(config, SOURCE), /baseUrl/);
  });

  it('rejects a non-positive workers count', () => {
    const config = { ...validConfig(), workers: 0 };
    assert.throws(() => assertValidConfig(config, SOURCE), /workers/);
  });

  it('rejects a non-positive maxFullPagePixels', () => {
    const config = { ...validConfig(), maxFullPagePixels: 0 };
    assert.throws(() => assertValidConfig(config, SOURCE), /maxFullPagePixels/);
  });

  it('accepts a valid breakpoints selection', () => {
    const config = { ...validConfig(), breakpoints: ['mobile', 'desktop'] };
    assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
  });

  it('rejects an unknown breakpoint name, listing the valid names', () => {
    const config = { ...validConfig(), breakpoints: ['mobile', 'phablet'] };
    assert.throws(
      () => assertValidConfig(config, SOURCE),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /phablet/);
        // The message must enumerate the valid registry names so the user
        // can fix the typo without hunting through docs.
        assert.match(error.message, /mobile.*tablet.*laptop.*desktop/);
        return true;
      },
    );
  });

  it('rejects an empty breakpoints array', () => {
    const config = { ...validConfig(), breakpoints: [] };
    assert.throws(() => assertValidConfig(config, SOURCE), /breakpoints/);
  });

  it('accepts breakpoint override objects mixed with bare names', () => {
    const config = {
      ...validConfig(),
      breakpoints: ['mobile', { name: 'desktop', width: 1440, height: 900 }],
    };
    assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
  });

  it('rejects an unknown breakpoint name inside an override object', () => {
    const config = {
      ...validConfig(),
      breakpoints: [{ name: 'phablet', width: 600 }],
    };
    assert.throws(() => assertValidConfig(config, SOURCE), /phablet/);
  });

  it('rejects a non-positive dimension in a breakpoint override', () => {
    const config = {
      ...validConfig(),
      breakpoints: [{ name: 'desktop', width: 0 }],
    };
    assert.throws(() => assertValidConfig(config, SOURCE), /width/);
  });

  it('accepts a valid captureMode', () => {
    for (const mode of ['viewport', 'fullPage']) {
      const config = { ...validConfig(), captureMode: mode };
      assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
    }
  });

  it('rejects an unknown captureMode', () => {
    const config = { ...validConfig(), captureMode: 'full' };
    assert.throws(() => assertValidConfig(config, SOURCE), /captureMode/);
  });

  it('accepts a boolean interactiveMode', () => {
    for (const value of [true, false]) {
      const config = { ...validConfig(), interactiveMode: value };
      assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
    }
  });

  it('rejects a non-boolean interactiveMode', () => {
    const config = { ...validConfig(), interactiveMode: 'yes' };
    assert.throws(() => assertValidConfig(config, SOURCE), /interactiveMode/);
  });
});

describe('loadConfig breakpoint resolution', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tuffgal-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Writes a tuffgal.config.js whose default export is the given body, then
  // resolves it through the real loader. We exercise resolution end-to-end
  // (rather than poking the private resolveConfig) so the test pins the same
  // path the CLI takes. `extra` is spliced verbatim into the object literal.
  async function load(extra: string): Promise<ResolvedConfig> {
    const body = `export default {
      paths: {
        actions: 'tuffgal/actions',
        stories: 'tuffgal/stories',
        baselines: 'tuffgal/baselines',
        report: 'tuffgal/report',
      },
      baseUrl: 'http://localhost:3000',
      ${extra}
    };`;
    await writeFile(join(dir, 'tuffgal.config.js'), body, 'utf8');
    return loadConfig(dir);
  }

  it('defaults captureMode to viewport when nothing is set', async () => {
    const resolved = await load('');
    assert.equal(resolved.captureMode, 'viewport');
  });

  it('resolves an explicit captureMode', async () => {
    const resolved = await load("captureMode: 'fullPage',");
    assert.equal(resolved.captureMode, 'fullPage');
  });

  it('defaults maxFullPagePixels to 30_000_000 when nothing is set', async () => {
    const resolved = await load('');
    assert.equal(resolved.maxFullPagePixels, 30_000_000);
  });

  it('resolves an explicit maxFullPagePixels', async () => {
    const resolved = await load('maxFullPagePixels: 12_000_000,');
    assert.equal(resolved.maxFullPagePixels, 12_000_000);
  });

  it('defaults interactiveMode to false when nothing is set', async () => {
    const resolved = await load('');
    assert.equal(resolved.interactiveMode, false);
  });

  it('resolves an explicit interactiveMode', async () => {
    const resolved = await load('interactiveMode: true,');
    assert.equal(resolved.interactiveMode, true);
  });

  it('defaults paths.localCache to the cache dir the scaffolded .gitignore covers', async () => {
    const resolved = await load('');
    // The default must resolve INSIDE the `tuffgal/` subtree, where the
    // scaffolded `tuffgal/.gitignore`'s `.cache/` entry actually ignores it —
    // not `<configDir>/.cache`, which sits a level up and is un-ignored, so a
    // consumer omitting the key would stage hundreds of per-machine PNGs. Derive
    // the covered path from `paths.baselines` (its parent is the `tuffgal/` dir
    // the gitignore lives in) rather than restating a literal, so this asserts
    // the REAL resolved default against what the gitignore covers.
    const gitignoreCovers = join(dirname(resolved.paths.baselines), '.cache');
    assert.equal(resolved.paths.localCache, gitignoreCovers);
    assert.equal(resolved.paths.localCache, join(dir, 'tuffgal', '.cache'));
  });

  it('resolves an explicit paths.localCache relative to the config dir', async () => {
    // `load` hardcodes its own `paths` block, so an explicit localCache can't
    // ride in via `extra` (a second `paths` key would clobber it). Write the
    // config directly for this one case.
    const body = `export default {
      paths: {
        actions: 'tuffgal/actions',
        stories: 'tuffgal/stories',
        baselines: 'tuffgal/baselines',
        report: 'tuffgal/report',
        localCache: 'custom/cache',
      },
      baseUrl: 'http://localhost:3000',
    };`;
    await writeFile(join(dir, 'tuffgal.config.js'), body, 'utf8');
    const resolved = await loadConfig(dir);
    assert.equal(resolved.paths.localCache, join(dir, 'custom/cache'));
  });

  it('defaults to a single desktop breakpoint when nothing is set', async () => {
    const resolved = await load('');
    assert.deepEqual(resolved.breakpoints, [
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    // The lone resolved breakpoint preserves the historical 1280x800 default.
    assert.deepEqual(resolved.breakpoints[0], {
      name: 'desktop',
      width: 1280,
      height: 800,
    });
  });

  it('resolves named breakpoints to their registry dimensions', async () => {
    const resolved = await load("breakpoints: ['mobile', 'tablet'],");
    assert.deepEqual(resolved.breakpoints, [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'tablet', width: 768, height: 1024 },
    ]);
    // The first resolved breakpoint is the first named mode, not the default.
    assert.deepEqual(resolved.breakpoints[0], {
      name: 'mobile',
      width: 375,
      height: 667,
    });
  });

  it('preserves order and drops duplicates', async () => {
    const resolved = await load(
      "breakpoints: ['desktop', 'mobile', 'desktop', 'mobile'],",
    );
    assert.deepEqual(
      resolved.breakpoints.map((b) => b.name),
      ['desktop', 'mobile'],
    );
  });

  it('layers per-entry overrides over registry dimensions', async () => {
    const resolved = await load(
      "breakpoints: [{ name: 'desktop', width: 1440, height: 900 }, 'mobile'],",
    );
    assert.deepEqual(resolved.breakpoints, [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 375, height: 667 },
    ]);
  });

  it('inherits the registry dimension for an axis an override omits', async () => {
    const resolved = await load(
      "breakpoints: [{ name: 'desktop', width: 1440 }],",
    );
    assert.deepEqual(resolved.breakpoints, [
      { name: 'desktop', width: 1440, height: 800 },
    ]);
  });

  it('keeps the first entry when a name is duplicated with differing dimensions', async () => {
    const resolved = await load(
      "breakpoints: [{ name: 'desktop', width: 1440 }, { name: 'desktop', width: 1600 }],",
    );
    // First wins: the later duplicate (and its dimensions) is dropped.
    assert.deepEqual(resolved.breakpoints, [
      { name: 'desktop', width: 1440, height: 800 },
    ]);
  });

  it('resolves a single overridden breakpoint', async () => {
    const resolved = await load(
      "breakpoints: [{ name: 'laptop', width: 1024, height: 768 }],",
    );
    assert.deepEqual(resolved.breakpoints, [
      { name: 'laptop', width: 1024, height: 768 },
    ]);
    assert.deepEqual(resolved.breakpoints[0], {
      name: 'laptop',
      width: 1024,
      height: 768,
    });
  });
});
