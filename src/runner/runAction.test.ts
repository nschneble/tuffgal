import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import type { Page } from 'playwright';

import type { Action } from '../schema/action.ts';
import type { ResolvedConfig } from '../config.ts';
import { pathExists } from '../util.ts';
import { runAction } from './runAction.ts';

/**
 * A 2x2 solid-colour PNG. `diffPngs` parses real PNG bytes, so the fake page's
 * screenshot and any pre-seeded baseline must be genuine images of matching
 * dimensions — a `Buffer.from('png')` stub would throw inside pngjs.
 */
function solidPng(r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Stand-in for the slice of `Page` that an action with a single `wait` step
 * plus a screenshot touches: a no-op timer, a deterministic screenshot, and an
 * aria snapshot. The screenshot bytes are injected so tests can make the
 * actual match (or differ from) a seeded baseline.
 */
function fakePage(screenshot: Buffer, aria = '- document'): Page {
  return {
    async waitForTimeout(): Promise<void> {},
    async evaluate(): Promise<void> {},
    async screenshot(): Promise<Buffer> {
      return screenshot;
    },
    locator() {
      return {
        async ariaSnapshot(): Promise<string> {
          return aria;
        },
      };
    },
  } as unknown as Page;
}

function action(name: string): Action {
  return {
    action: name,
    steps: [{ kind: 'wait', ms: 0 }],
    screenshot: true,
  } as unknown as Action;
}

let tempDirs: string[] = [];

async function makeConfig(): Promise<ResolvedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'tuffgal-runaction-'));
  tempDirs.push(root);
  return {
    paths: {
      baselines: join(root, 'baselines'),
      report: join(root, 'report'),
    },
  } as unknown as ResolvedConfig;
}

afterEach(() => {
  tempDirs = [];
});

describe('runAction — breakpoint threading', () => {
  it('tags the result with the breakpoint it ran at and keys the baseline by it', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'mobile',
    });
    assert.equal(result.breakpoint, 'mobile');
    // First run with no baseline anywhere → new, written under the bp key.
    assert.equal(result.status, 'new');
    assert.ok(result.baselinePath?.endsWith(join('open', 'mobile.png')));
    assert.ok(await pathExists(result.baselinePath!));
  });

  it('keeps two breakpoints of the same action on disjoint baselines', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const mobile = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'mobile',
    });
    const desktop = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // Each breakpoint creates its own baseline — neither sees the other's as
    // pre-existing, so both read as `new` on first capture.
    assert.equal(mobile.status, 'new');
    assert.equal(desktop.status, 'new');
    assert.notEqual(mobile.baselinePath, desktop.baselinePath);
  });
});

describe('runAction — legacy baseline fallback', () => {
  it('compares against the legacy 0.png when the breakpoint baseline is absent and does NOT report new', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Seed a pre-breakpoint baseline at <action>/0.png + its a11y companion,
    // matching what a project committed before this feature existed.
    const legacyDir = join(config.paths.baselines, 'open');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, '0.png'), png);
    await writeFile(join(legacyDir, 'a11y.yaml'), '- document');

    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });

    // Identical image → pass (NOT new): the legacy baseline gated it.
    assert.equal(result.status, 'pass');
    assert.notEqual(result.status, 'new');
    // The legacy file must NOT be auto-promoted to the breakpoint location;
    // migration is `approve`'s job. baselinePath still points at the bp key so
    // a later approve writes there.
    assert.ok(result.baselinePath?.endsWith(join('open', 'desktop.png')));
    assert.equal(await pathExists(join(legacyDir, 'desktop.png')), false);
  });

  it('reports changed against a legacy baseline when the image drifts', async () => {
    const config = await makeConfig();
    const legacyDir = join(config.paths.baselines, 'open');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, '0.png'), solidPng(10, 20, 30));

    const result = await runAction({
      page: fakePage(solidPng(200, 50, 50)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });

    assert.equal(result.status, 'changed');
  });

  it('reports new only when neither breakpoint nor legacy baseline exists', async () => {
    const config = await makeConfig();
    const result = await runAction({
      page: fakePage(solidPng(10, 20, 30)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    assert.equal(result.status, 'new');
  });
});
