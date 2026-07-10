import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
      localCache: join(root, 'cache'),
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

describe('runAction — CI mode never writes committed baselines', () => {
  it('reports new WITHOUT writing into paths.baselines, and writes the candidate instead', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    // Missing baseline in CI mode => status new, but NOTHING under baselines.
    assert.equal(result.status, 'new');
    const baselinePng = join(config.paths.baselines, 'open', 'desktop.png');
    const baselineA11y = join(
      config.paths.baselines,
      'open',
      'desktop.a11y.yaml',
    );
    assert.equal(await pathExists(baselinePng), false);
    assert.equal(await pathExists(baselineA11y), false);

    // The candidate tree carries the proposed baseline (PNG + a11y companion).
    const candidatePng = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.png',
    );
    const candidateA11y = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.a11y.yaml',
    );
    assert.ok(await pathExists(candidatePng));
    assert.ok(await pathExists(candidateA11y));
    assert.equal(await readFile(candidateA11y, 'utf8'), '- document');
  });

  it('writes a candidate for a changed action but never touches baselines', async () => {
    const config = await makeConfig();
    // Seed a breakpoint-keyed committed baseline that the actual will drift from.
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), solidPng(10, 20, 30));
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- document');

    const result = await runAction({
      page: fakePage(solidPng(200, 50, 50)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'changed');
    // Committed baseline stays exactly as seeded — untouched by the run.
    const baselineBytes = await readFile(join(baselineDir, 'desktop.png'));
    assert.deepEqual(baselineBytes, solidPng(10, 20, 30));
    // Candidate carries the proposed new baseline.
    assert.ok(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
    );
  });

  it('writes NO candidate for a passing action in CI mode', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- document');

    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'pass');
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
  });
});

describe('runAction — local mode auto-seeds the cache, never baselines', () => {
  it('auto-seeds a fresh cache entry on a missing-entry run and leaves baselines untouched', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });

    assert.equal(result.status, 'new');
    // Auto-seed lands in the per-machine cache, not the committed baselines.
    assert.ok(
      await pathExists(join(config.paths.localCache, 'open', 'desktop.png')),
    );
    assert.ok(
      await pathExists(
        join(config.paths.localCache, 'open', 'desktop.a11y.yaml'),
      ),
    );
    // paths.baselines is NEVER read or written in local mode.
    assert.equal(
      await pathExists(join(config.paths.baselines, 'open', 'desktop.png')),
      false,
    );
    // The recorded baselinePath points at the cache, so a later `approve` and a
    // re-run both key off the seeded cache entry.
    assert.ok(result.baselinePath?.startsWith(config.paths.localCache));
    // Local mode writes no candidate tree — that is a CI artifact.
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
  });

  it('passes on a second run against the seeded cache entry', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const first = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.equal(first.status, 'new');

    // Same actual, second run — the cache entry now exists, so it gates a pass.
    const second = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.equal(second.status, 'pass');
  });

  it('reports changed against the cache without overwriting it (approve does that)', async () => {
    const config = await makeConfig();
    // Seed the cache entry, then drift the actual away from it.
    const cacheDir = join(config.paths.localCache, 'open');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'desktop.png'), solidPng(10, 20, 30));
    await writeFile(join(cacheDir, 'desktop.a11y.yaml'), '- document');

    const result = await runAction({
      page: fakePage(solidPng(200, 50, 50)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });

    assert.equal(result.status, 'changed');
    // The cache entry is the comparison target, not auto-updated by a run.
    const cacheBytes = await readFile(join(cacheDir, 'desktop.png'));
    assert.deepEqual(cacheBytes, solidPng(10, 20, 30));
  });

  it('never reads a committed baseline in local mode (cache miss => new even with a baseline present)', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // A committed baseline of the SAME pixels exists — if local mode read it,
    // this run would pass. It must not: the cache is empty, so the run seeds it
    // and reports `new`.
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- document');
    const baselineBefore = await readFile(join(baselineDir, 'desktop.png'));

    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });

    assert.equal(result.status, 'new');
    // The committed baseline was neither read (else pass) nor written.
    assert.deepEqual(
      await readFile(join(baselineDir, 'desktop.png')),
      baselineBefore,
    );
    // The seed landed in the cache instead.
    assert.ok(
      await pathExists(join(config.paths.localCache, 'open', 'desktop.png')),
    );
  });
});

describe('runAction — ${breakpoint} interpolation', () => {
  /** Page that only records the URLs a `navigate` step passes to `goto`. */
  function gotoRecordingPage(urls: string[]): Page {
    return {
      async goto(url: string): Promise<null> {
        urls.push(url);
        return null;
      },
    } as unknown as Page;
  }

  function navigateAction(parameters?: string[]): Action {
    return {
      action: 'visit',
      parameters,
      steps: [{ kind: 'navigate', path: '/u/${breakpoint}' }],
      screenshot: false,
    } as unknown as Action;
  }

  it('resolves ${breakpoint} to the current mode name', async () => {
    const config = await makeConfig();
    // runNavigate resolves the path against baseUrl, so the test config needs
    // one for `new URL()` to succeed.
    Object.assign(config as object, {
      baseUrl: 'http://localhost',
      navigationTimeoutMs: 1000,
    });
    const urls: string[] = [];
    await runAction({
      page: gotoRecordingPage(urls),
      action: navigateAction(),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'mobile',
    });
    assert.deepEqual(urls, ['http://localhost/u/mobile']);
  });

  it('lets a story parameter named breakpoint override the injected value', async () => {
    const config = await makeConfig();
    Object.assign(config as object, {
      baseUrl: 'http://localhost',
      navigationTimeoutMs: 1000,
    });
    const urls: string[] = [];
    await runAction({
      page: gotoRecordingPage(urls),
      // The action must DECLARE `breakpoint` for validateParameters to accept
      // it as an author-supplied parameter.
      action: navigateAction(['breakpoint']),
      parameters: { breakpoint: 'custom' },
      storyFile: 'home.json',
      config,
      breakpoint: 'mobile',
    });
    assert.deepEqual(urls, ['http://localhost/u/custom']);
  });
});

describe('runAction — legacy baseline fallback (local mode, within the cache root)', () => {
  it('compares against the legacy 0.png when the breakpoint entry is absent and does NOT report new', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Seed a pre-breakpoint entry at <action>/0.png + its a11y companion,
    // within the CACHE root (local mode's comparison target).
    const legacyDir = join(config.paths.localCache, 'open');
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

    // Identical image → pass (NOT new): the legacy cache entry gated it.
    assert.equal(result.status, 'pass');
    assert.notEqual(result.status, 'new');
    // The legacy file must NOT be auto-promoted to the breakpoint location;
    // migration is `approve`'s job. baselinePath still points at the bp key.
    assert.ok(result.baselinePath?.endsWith(join('open', 'desktop.png')));
    assert.equal(await pathExists(join(legacyDir, 'desktop.png')), false);
  });

  it('reports changed against a legacy cache entry when the image drifts', async () => {
    const config = await makeConfig();
    const legacyDir = join(config.paths.localCache, 'open');
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

  it('reports new only when neither breakpoint nor legacy cache entry exists', async () => {
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

  it('reads the legacy a11y companion (a11y.yaml) and flags a11yChanged while pixels pass', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Legacy-only entry: matching pixels (→ pass) but a stale a11y tree that
    // differs from the page's current snapshot. The fallback branch must source
    // the a11y companion from the LEGACY path (`<action>/a11y.yaml`) so the
    // a11yChanged signal reflects the entry we actually diffed against.
    const legacyDir = join(config.paths.localCache, 'open');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, '0.png'), png);
    await writeFile(join(legacyDir, 'a11y.yaml'), '- button "Old label"');

    const result = await runAction({
      page: fakePage(png, '- button "New label"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, true);
  });

  it('leaves a11yChanged undefined when only a legacy 0.png exists with no a11y companion', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Legacy pixel entry present, but no `a11y.yaml` alongside it — an older
    // project that predates a11y snapshots. The fallback read must not throw on
    // the absent companion; with no baseline tree to compare, a11yChanged stays
    // undefined.
    const legacyDir = join(config.paths.localCache, 'open');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, '0.png'), png);

    const result = await runAction({
      page: fakePage(png),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, undefined);
  });
});

describe('runAction — legacy baseline fallback (CI mode, within paths.baselines)', () => {
  it('compares against the committed legacy 0.png, passes, and writes NO candidate', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
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
      mode: 'ci',
    });

    assert.equal(result.status, 'pass');
    // Legacy fallback in CI never promotes to the breakpoint key…
    assert.equal(
      await pathExists(join(config.paths.baselines, 'open', 'desktop.png')),
      false,
    );
    // …and a passing action emits no candidate.
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
  });

  it('reports changed against a committed legacy baseline, writes a candidate, leaves baselines untouched', async () => {
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
      mode: 'ci',
    });

    assert.equal(result.status, 'changed');
    // The legacy committed baseline is the comparison target, never rewritten.
    assert.deepEqual(
      await readFile(join(legacyDir, '0.png')),
      solidPng(10, 20, 30),
    );
    // No breakpoint-keyed baseline was written under the committed set.
    assert.equal(
      await pathExists(join(config.paths.baselines, 'open', 'desktop.png')),
      false,
    );
    // The drift proposes a candidate for approval instead.
    assert.ok(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
    );
  });
});

describe('runAction — CI mode a11y-only drift', () => {
  it('flips status to changed and writes a candidate pair when pixels pass but the aria snapshot drifts', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Committed baseline: identical pixels (→ pixels pass) but a stale a11y tree
    // that differs from the page's current snapshot. Under the sole-writer model
    // this drift must become `changed` with a candidate, else the drifted
    // committed a11y.yaml is permanently unre-approvable.
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- button "Old"');

    const result = await runAction({
      page: fakePage(png, '- button "New"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    // Pixels matched, aria drifted → changed (not pass), a11yChanged recorded.
    assert.equal(result.status, 'changed');
    assert.equal(result.a11yChanged, true);
    // No pixel diff was produced — a11y-only drift carries no diff image, which
    // (with a11yChanged) is what tells this apart from pixel drift downstream.
    assert.equal(result.diffPath, undefined);

    // A full candidate PAIR is written so `approve --from` can promote the new
    // snapshot: the proposed PNG plus its a11y companion (the drifted tree).
    const candidatePng = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.png',
    );
    const candidateA11y = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.a11y.yaml',
    );
    assert.ok(await pathExists(candidatePng));
    assert.ok(await pathExists(candidateA11y));
    assert.equal(await readFile(candidateA11y, 'utf8'), '- button "New"');
    // The committed baseline is never rewritten by the run.
    assert.deepEqual(await readFile(join(baselineDir, 'desktop.png')), png);
  });

  it('stays pass with no candidate when CI pixels pass AND the aria snapshot matches', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- document');

    const result = await runAction({
      // Same aria as the seeded baseline → no a11y drift.
      page: fakePage(png, '- document'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    // Both channels clean → pass, and no candidate is proposed. This is the
    // other direction of the a11y-drift toggle: the flip is gated on drift.
    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, undefined);
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
  });

  it('writes exactly ONE candidate pair when BOTH pixels and aria drift (no double write)', async () => {
    const config = await makeConfig();
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    // Baseline drifts on BOTH channels: different pixels AND a different tree.
    await writeFile(join(baselineDir, 'desktop.png'), solidPng(10, 20, 30));
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- button "Old"');

    const candidatePng = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.png',
    );
    const candidateA11y = join(
      config.paths.report,
      'candidates',
      'open',
      'desktop.a11y.yaml',
    );

    const result = await runAction({
      page: fakePage(solidPng(200, 50, 50), '- button "New"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'changed');
    assert.equal(result.a11yChanged, true);
    // Pixel drift ⇒ a diff image IS produced. A present `diffPath` proves the
    // pixel-drift branch ran and the pixels-pass branch did NOT — the two are an
    // if/else, and the a11y-only candidate write lives solely in the pass branch.
    // So reaching here proves that write never fired, i.e. no second candidate
    // pair: exactly one pair is written, from the pixel-drift path alone.
    assert.ok(result.diffPath);
    // Exactly one candidate pair on disk — the files exist and hold the proposed
    // render (the actual bytes, uncorrupted by any competing second write).
    assert.ok(await pathExists(candidatePng));
    assert.ok(await pathExists(candidateA11y));
    assert.equal(await readFile(candidateA11y, 'utf8'), '- button "New"');
    assert.deepEqual(await readFile(candidatePng), solidPng(200, 50, 50));
  });
});

describe('runAction — local mode a11y-only drift stays advisory', () => {
  it('keeps pass (no status flip, no candidate) when local pixels pass but aria drifts', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    // Seed the cache entry with a stale a11y tree; drift the page's aria only.
    const cacheDir = join(config.paths.localCache, 'open');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'desktop.png'), png);
    await writeFile(join(cacheDir, 'desktop.a11y.yaml'), '- button "Old"');

    const result = await runAction({
      page: fakePage(png, '- button "New"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });

    // Local mode is advisory: aria drift is flagged but never flips status or
    // proposes a candidate (that is the CI-only sole-writer promotion path).
    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, true);
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.a11y.yaml'),
      ),
      false,
    );
  });
});

describe('runAction — CI mode size-mismatch drift', () => {
  it('treats a dimension change as changed, writes a candidate, and never rewrites the baseline', async () => {
    const config = await makeConfig();
    // Seed a breakpoint-keyed committed baseline whose dimensions the actual
    // will NOT match — a 2x2 baseline vs a 4x4 actual. `diffPngs` throws
    // ScreenshotSizeMismatchError, which the runner maps to `changed`.
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    const seededBaseline = solidPng(10, 20, 30);
    await writeFile(join(baselineDir, 'desktop.png'), seededBaseline);
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- document');

    const bigger = new PNG({ width: 4, height: 4 });
    for (let i = 0; i < bigger.data.length; i += 4) {
      bigger.data[i] = 10;
      bigger.data[i + 1] = 20;
      bigger.data[i + 2] = 30;
      bigger.data[i + 3] = 255;
    }
    const biggerPng = PNG.sync.write(bigger);

    const result = await runAction({
      page: fakePage(biggerPng),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'changed');
    assert.ok(result.failureMessage);
    // The seeded baseline bytes are untouched by the run.
    assert.deepEqual(
      await readFile(join(baselineDir, 'desktop.png')),
      seededBaseline,
    );
    // A candidate carries the proposed (differently-sized) new baseline.
    assert.ok(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
    );
    assert.ok(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.a11y.yaml'),
      ),
    );
  });
});
