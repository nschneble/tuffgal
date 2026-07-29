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
 * A 2x2 solid-colour PNG. `scoreDiff` parses real PNG bytes, so the fake page's
 * screenshot and any pre-seeded baseline must be genuine images of matching
 * dimensions; a `Buffer.from('png')` stub would throw inside pngjs.
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

/**
 * A base config augmented with the `baseUrl` + `navigationTimeoutMs` a
 * `navigate` step needs (`runNavigate` resolves the path against `baseUrl`, and
 * `page.goto` reads the timeout). Shared by every test that drives a navigate
 * step so the augmentation lives in one place instead of being re-inlined.
 */
async function navConfig(): Promise<ResolvedConfig> {
  const config = await makeConfig();
  Object.assign(config as object, {
    baseUrl: 'http://localhost',
    navigationTimeoutMs: 1000,
  });
  return config;
}

afterEach(() => {
  tempDirs = [];
});

describe('runAction: breakpoint threading', () => {
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
    // Each breakpoint creates its own baseline; neither sees the other's as
    // pre-existing, so both read as `new` on first capture.
    assert.equal(mobile.status, 'new');
    assert.equal(desktop.status, 'new');
    assert.notEqual(mobile.baselinePath, desktop.baselinePath);
  });
});

describe('runAction: CI mode never writes committed baselines', () => {
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
    // Committed baseline stays exactly as seeded; untouched by the run.
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

describe('runAction: local mode auto-seeds the cache, never baselines', () => {
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
    // Local mode writes no candidate tree; that is a CI artifact.
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

    // Same actual, second run; the cache entry now exists, so it gates a pass.
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
    // A committed baseline of the SAME pixels exists; if local mode read it,
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

describe('runAction: ${breakpoint} interpolation', () => {
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
    // runNavigate resolves the path against baseUrl, so the test config needs
    // one for `new URL()` to succeed; navConfig supplies it.
    const config = await navConfig();
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
    const config = await navConfig();
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

describe('runAction: navigation timeout is retryable, infra faults are not', () => {
  /**
   * A page whose `goto` replays a scripted sequence of outcomes: `'timeout'`
   * throws a Playwright-shaped TimeoutError, `'infra'` throws a generic fault,
   * `'ok'` resolves. Records the call count so a test can prove whether a retry
   * fired. Anything past the end of the script resolves `ok`.
   */
  function scriptedGotoPage(script: Array<'timeout' | 'infra' | 'ok'>): {
    page: Page;
    calls: () => number;
  } {
    let call = 0;
    const page = {
      async goto(): Promise<null> {
        const outcome = script[call] ?? 'ok';
        call += 1;
        if (outcome === 'timeout') {
          const error = new Error('page.goto: Timeout 15000ms exceeded');
          // Playwright's navigation timeout surfaces as a TimeoutError; the
          // classifier keys on this name.
          error.name = 'TimeoutError';
          throw error;
        }
        if (outcome === 'infra') {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }
        return null;
      },
    } as unknown as Page;
    return { page, calls: () => call };
  }

  function navigateOnlyAction(attempts: number): Action {
    return {
      action: 'visit',
      steps: [{ kind: 'navigate', path: '/' }],
      screenshot: false,
      // backoffMs 0 keeps the retry loop from actually sleeping between tries.
      retry: { attempts, backoffMs: 0 },
    } as unknown as Action;
  }

  it('retries a navigation timeout and succeeds on the second attempt', async () => {
    const config = await navConfig();
    const { page, calls } = scriptedGotoPage(['timeout', 'ok']);
    const result = await runAction({
      page,
      action: navigateOnlyAction(2),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // The first timeout was retried; the retry navigated cleanly.
    assert.equal(calls(), 2);
    assert.equal(result.status, 'pass');
  });

  it('fails the action when every navigation attempt times out (retry budget exhausted)', async () => {
    const config = await navConfig();
    const { page, calls } = scriptedGotoPage(['timeout', 'timeout']);
    const result = await runAction({
      page,
      action: navigateOnlyAction(2),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // Both attempts were made, then the action failed on the exhausted budget.
    assert.equal(calls(), 2);
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStepIndex, 0);
  });

  it('does NOT retry a generic infrastructure fault: it fails on the first throw', async () => {
    const config = await navConfig();
    const { page, calls } = scriptedGotoPage(['infra', 'ok']);
    const result = await runAction({
      page,
      action: navigateOnlyAction(2),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // A non-timeout, non-locator fault rethrows immediately: goto ran ONCE, so
    // the scripted `ok` second entry was never reached.
    assert.equal(calls(), 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureMessage, 'net::ERR_CONNECTION_REFUSED');
  });
});

describe('runAction: legacy baseline fallback (local mode, within the cache root)', () => {
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
    // Legacy pixel entry present, but no `a11y.yaml` alongside it; an older
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

describe('runAction: legacy baseline fallback (CI mode, within paths.baselines)', () => {
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

describe('runAction: CI mode a11y-only drift', () => {
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
    // No pixel diff was produced; a11y-only drift carries no diff image, which
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

  it('records the breakpoint-keyed a11y baseline path when the drift came from a breakpoint-source baseline', async () => {
    // Baseline-source is `breakpoint` (a `desktop.a11y.yaml` exists), so the
    // recorded a11yBaselinePath must be the breakpoint-keyed file that was
    // actually diffed against; a real, on-disk path.
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
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

    assert.equal(result.a11yChanged, true);
    const keyedA11y = join(baselineDir, 'desktop.a11y.yaml');
    assert.equal(result.a11yBaselinePath, keyedA11y);
    // The recorded path is the file that was actually diffed against, so it
    // exists on disk.
    assert.equal(await pathExists(result.a11yBaselinePath ?? ''), true);
  });

  it('records the legacy a11y baseline path when the drift came from a legacy-source baseline', async () => {
    // Baseline-source is `legacy` (only `0.png` / `a11y.yaml` exist, no
    // breakpoint-keyed entry). The recorded a11yBaselinePath must mirror the
    // legacy file that was diffed against; NOT the breakpoint-keyed
    // `desktop.a11y.yaml`, which does not exist on disk and would be a dangling
    // pointer for any consumer (report, approve) that reads it back.
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const legacyDir = join(config.paths.baselines, 'open');
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
      mode: 'ci',
    });

    // A11y-only drift against the legacy companion.
    assert.equal(result.status, 'changed');
    assert.equal(result.a11yChanged, true);
    // The recorded path is the LEGACY a11y file that was diffed against…
    const legacyA11y = join(legacyDir, 'a11y.yaml');
    assert.equal(result.a11yBaselinePath, legacyA11y);
    // …and it exists on disk, unlike the breakpoint-keyed path that the pre-fix
    // code unconditionally recorded.
    assert.equal(await pathExists(result.a11yBaselinePath ?? ''), true);
    assert.equal(await pathExists(join(legacyDir, 'desktop.a11y.yaml')), false);
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
    // pixel-drift branch ran and the pixels-pass branch did NOT; the two are an
    // if/else, and the a11y-only candidate write lives solely in the pass branch.
    // So reaching here proves that write never fired, i.e. no second candidate
    // pair: exactly one pair is written, from the pixel-drift path alone.
    assert.ok(result.diffPath);
    // Exactly one candidate pair on disk; the files exist and hold the proposed
    // render (the actual bytes, uncorrupted by any competing second write).
    assert.ok(await pathExists(candidatePng));
    assert.ok(await pathExists(candidateA11y));
    assert.equal(await readFile(candidateA11y, 'utf8'), '- button "New"');
    assert.deepEqual(await readFile(candidatePng), solidPng(200, 50, 50));
  });
});

describe('runAction: local mode a11y-only drift stays advisory', () => {
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

describe('runAction: a11y drift compares parsed trees, not raw text', () => {
  it('does NOT flag drift when the baseline differs only in YAML quote style', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    // Committed baseline wraps the aria scalar in YAML single-quotes; the live
    // capture leaves it as a plain scalar. Same accessibility tree, different
    // serialized text: YAML.parse normalises both to `['button "Save"']`, so
    // the pre-fix string comparison would have (wrongly) flagged this as drift.
    await writeFile(
      join(baselineDir, 'desktop.a11y.yaml'),
      `- 'button "Save"'`,
    );

    const result = await runAction({
      page: fakePage(png, '- button "Save"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    // A formatting-only difference must behave exactly like an identical
    // baseline: pixels pass, no a11y drift, so CI stays `pass` (no status flip)
    // and proposes no candidate.
    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, undefined);
    assert.equal(
      await pathExists(
        join(config.paths.report, 'candidates', 'open', 'desktop.png'),
      ),
      false,
    );
  });

  it('does NOT flag drift when the baseline differs only in indentation and trailing whitespace', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    // Committed baseline nests the child four spaces deep with a trailing blank
    // line; the live capture nests two spaces deep with no trailing newline.
    // Both parse to `[{ listbox: ['option "A"'] }]`.
    await writeFile(
      join(baselineDir, 'desktop.a11y.yaml'),
      '- listbox:\n    - option "A"\n\n',
    );

    const result = await runAction({
      page: fakePage(png, '- listbox:\n  - option "A"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.a11yChanged, undefined);
  });

  it('STILL flags drift on a genuine tree change (changed accessible name)', async () => {
    const config = await makeConfig();
    const png = solidPng(10, 20, 30);
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(join(baselineDir, 'desktop.png'), png);
    // A real semantic change (the button's accessible name) must survive the
    // parse-then-deep-equal comparison and still read as drift, so the fix does
    // not blunt genuine a11y regressions.
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

    // Pixels match but the tree genuinely moved → CI flips to `changed`.
    assert.equal(result.status, 'changed');
    assert.equal(result.a11yChanged, true);
  });
});

describe('runAction: CI mode size-mismatch drift', () => {
  it('treats a dimension change as changed, writes a candidate, and never rewrites the baseline', async () => {
    const config = await makeConfig();
    // Seed a breakpoint-keyed committed baseline whose dimensions the actual
    // will NOT match; a 2x2 baseline vs a 4x4 actual. `scoreDiff` throws
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
    // The structured mirror copies the error's baseline/actual dimensions
    // verbatim (2x2 seeded baseline vs 4x4 actual), so a transposed or dropped
    // field here would fail loudly instead of hiding behind the prose message.
    assert.deepEqual(result.sizeMismatch, {
      baseline: { width: 2, height: 2 },
      actual: { width: 4, height: 4 },
    });
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

  it('never carries a11yChanged (locks the a11y-only-drift discriminator)', async () => {
    // The a11y-only-drift discriminator is POSITIVE: `a11yChanged === true`. This
    // pixel-drift (size-mismatch) branch carries no `diffPath`, so were it to also
    // emit `a11yChanged`, a `!diffPath` heuristic consumer would misclassify it.
    // The branch deliberately omits `a11yChanged`; this test fails if a future
    // "natural cleanup" adds it back; even when the aria tree genuinely drifted.
    const config = await makeConfig();
    const baselineDir = join(config.paths.baselines, 'open');
    await mkdir(baselineDir, { recursive: true });
    // Seed a 2x2 baseline AND a stale a11y tree, so the aria snapshot really does
    // drift; proving the omission is the branch's own contract, not an artifact
    // of a matching tree.
    await writeFile(join(baselineDir, 'desktop.png'), solidPng(10, 20, 30));
    await writeFile(join(baselineDir, 'desktop.a11y.yaml'), '- button "Old"');

    const bigger = new PNG({ width: 4, height: 4 });
    for (let i = 0; i < bigger.data.length; i += 4) {
      bigger.data[i] = 10;
      bigger.data[i + 1] = 20;
      bigger.data[i + 2] = 30;
      bigger.data[i + 3] = 255;
    }
    const biggerPng = PNG.sync.write(bigger);

    const result = await runAction({
      page: fakePage(biggerPng, '- button "New"'),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'ci',
    });

    assert.equal(result.status, 'changed');
    // Pixel drift → a failureMessage is present, but the a11y discriminator stays
    // unset so the size-mismatch result is never misread as a11y-only drift.
    assert.ok(result.failureMessage);
    assert.equal(result.a11yChanged, undefined);
  });
});

describe('runAction: step-level retry on a locator miss (not just nav timeout)', () => {
  /**
   * A page whose click replays a scripted sequence: `'miss'` throws (runClick
   * wraps ANY click error into the retryable LocatorNotFoundError), `'hit'`
   * resolves. Records the click count so a test can prove how many attempts
   * fired. The `{ role, text }` hint routes through getByRole, so that returns
   * the scripted handle; getByText/locator mirror it for completeness.
   */
  function clickScriptPage(script: Array<'miss' | 'hit'>): {
    page: Page;
    clicks: () => number;
  } {
    let call = 0;
    const handle = {
      async click(): Promise<void> {
        const outcome = script[call] ?? 'hit';
        call += 1;
        if (outcome === 'miss') {
          throw new Error('locator.click: Timeout 1000ms exceeded');
        }
      },
    };
    const locator = { first: () => handle };
    const page = {
      getByRole: () => locator,
      getByText: () => locator,
      locator: () => locator,
    } as unknown as Page;
    return { page, clicks: () => call };
  }

  function clickAction(attempts: number, backoffMs: number): Action {
    return {
      action: 'save',
      steps: [{ kind: 'click', hint: { role: 'button', text: 'Save' } }],
      screenshot: false,
      retry: { attempts, backoffMs },
    } as unknown as Action;
  }

  it('retries a locator miss and succeeds when the element hydrates on the next attempt', async () => {
    const config = await makeConfig();
    const { page, clicks } = clickScriptPage(['miss', 'hit']);
    const result = await runAction({
      page,
      action: clickAction(2, 0),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // First click missed, the retry hit; two attempts, then success.
    assert.equal(clicks(), 2);
    assert.equal(result.status, 'pass');
  });

  it('fails the action once the attempts budget is exhausted by repeated misses', async () => {
    const config = await makeConfig();
    const { page, clicks } = clickScriptPage(['miss', 'miss', 'miss']);
    const result = await runAction({
      page,
      action: clickAction(3, 0),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    // All three attempts missed → the step fails on the exhausted budget.
    assert.equal(clicks(), 3);
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStepIndex, 0);
  });

  it('scales the backoff by the attempt number (backoffMs * attempt)', async (t) => {
    const config = await makeConfig();
    // Spy on the timer `sleep` schedules, calling through so the promise still
    // resolves. Only `sleep` schedules a timer on this fake page (screenshot is
    // off), so every recorded delay is a retry backoff.
    const timeout = t.mock.method(globalThis, 'setTimeout');
    const before = timeout.mock.callCount();
    const { page } = clickScriptPage(['miss', 'miss', 'miss']);
    const result = await runAction({
      page,
      action: clickAction(3, 50),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    assert.equal(result.status, 'failed');
    const delays = timeout.mock.calls
      .slice(before)
      .map((call) => call.arguments[1]);
    // Sleeps fire only BETWEEN attempts: after attempt 1 (50×1) and attempt 2
    // (50×2). The final failing attempt (3) rethrows with no trailing sleep.
    assert.deepEqual(delays, [50, 100]);
  });
});

describe('runAction: expect.anyOf race and timeout', () => {
  /**
   * A page for expect-only runs (empty steps): getByRole and getByText each
   * hand back a locator whose `first().waitFor` resolves or rejects per the
   * flags, so a test can make one candidate win the race or make all of them
   * time out.
   */
  function expectPage(opts: { role: boolean; text: boolean }): Page {
    const makeLocator = (visible: boolean) => ({
      first: () => ({
        async waitFor(): Promise<void> {
          if (!visible) throw new Error('waitFor: element not visible');
        },
      }),
    });
    return {
      getByRole: () => makeLocator(opts.role),
      getByText: () => makeLocator(opts.text),
    } as unknown as Page;
  }

  function expectAction(timeoutMs: number): Action {
    return {
      action: 'await-toast',
      steps: [],
      screenshot: false,
      expect: {
        anyOf: [{ role: 'status' }, { text: 'Saved' }],
        timeoutMs,
      },
    } as unknown as Action;
  }

  it('passes as soon as one anyOf candidate becomes visible while the other never does', async () => {
    const config = await makeConfig();
    // The role candidate resolves, the text candidate never; Promise.any still
    // fulfils on the single winner. This is the "success looks like X OR Y"
    // contract: the story need not know which renderer the app chose.
    const result = await runAction({
      page: expectPage({ role: true, text: false }),
      action: expectAction(1000),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    assert.equal(result.status, 'pass');
  });

  it('fails with an ExpectationTimedOutError message when no candidate resolves', async () => {
    const config = await makeConfig();
    const result = await runAction({
      page: expectPage({ role: false, text: false }),
      action: expectAction(5),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
    });
    assert.equal(result.status, 'failed');
    // Steps ran clean (there are none), so the failure indexes one past them.
    assert.equal(result.failedStepIndex, 0);
    assert.match(
      result.failureMessage ?? '',
      /expect\.anyOf did not resolve within 5ms/,
    );
  });
});

describe('runAction: mask resolution', () => {
  /**
   * A page that records the `mask` array handed to `page.screenshot`, and hands
   * back tagged locators from each resolver so a test can prove which hint
   * mapped to which Playwright call. `locator('body')` additionally answers
   * `ariaSnapshot` for the a11y capture that runs alongside the shot; other
   * selectors stay bare so a mask locator deep-equals cleanly.
   */
  function maskRecordingPage(shot: Buffer): {
    page: Page;
    masks: () => unknown[];
  } {
    let recorded: unknown[] = [];
    const page = {
      async waitForTimeout(): Promise<void> {},
      async evaluate(): Promise<void> {},
      async screenshot(opts: { mask?: unknown[] }): Promise<Buffer> {
        recorded = opts.mask ?? [];
        return shot;
      },
      getByRole(role: string) {
        return { tag: 'role', role };
      },
      getByText(text: string) {
        return { tag: 'text', text };
      },
      locator(selector: string) {
        if (selector === 'body') {
          return {
            tag: 'selector',
            selector,
            async ariaSnapshot(): Promise<string> {
              return '- document';
            },
          };
        }
        return { tag: 'selector', selector };
      },
    } as unknown as Page;
    return { page, masks: () => recorded };
  }

  function maskAction(mask?: unknown[]): Action {
    return {
      action: 'open',
      steps: [{ kind: 'wait', ms: 0 }],
      screenshot: true,
      mask,
    } as unknown as Action;
  }

  it('passes an empty mask array to the shutter when mask is undefined', async () => {
    const config = await makeConfig();
    const { page, masks } = maskRecordingPage(solidPng(10, 20, 30));
    await runAction({
      page,
      action: maskAction(undefined),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.deepEqual(masks(), []);
  });

  it('short-circuits an explicitly empty mask list to no locators', async () => {
    const config = await makeConfig();
    const { page, masks } = maskRecordingPage(solidPng(10, 20, 30));
    await runAction({
      page,
      action: maskAction([]),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.deepEqual(masks(), []);
  });

  it('resolves each mask hint through the locator precedence and forwards them in order', async () => {
    const config = await makeConfig();
    const { page, masks } = maskRecordingPage(solidPng(10, 20, 30));
    await runAction({
      page,
      action: maskAction([{ role: 'status' }, { selector: '.toast' }]),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    // Two hints → two resolved locators, in order, each routed to the method its
    // hint shape selects: role → getByRole, selector → page.locator.
    assert.deepEqual(masks(), [
      { tag: 'role', role: 'status' },
      { tag: 'selector', selector: '.toast' },
    ]);
  });
});

describe('runAction: custom diff thresholds move the SSIM gate', () => {
  async function seedCache(config: ResolvedConfig, png: Buffer): Promise<void> {
    const cacheDir = join(config.paths.localCache, 'open');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'desktop.png'), png);
    await writeFile(join(cacheDir, 'desktop.a11y.yaml'), '- document');
  }

  function diffAction(diff: {
    ssimThreshold?: number;
    pixelThreshold?: number;
  }): Action {
    return {
      action: 'open',
      steps: [{ kind: 'wait', ms: 0 }],
      screenshot: true,
      diff,
    } as unknown as Action;
  }

  it('a tightened ssimThreshold flips a would-be pass into changed', async () => {
    const config = await makeConfig();
    // This pair scores SSIM ~0.997; a pass under the 0.99 default…
    await seedCache(config, solidPng(100, 100, 100));
    const tightened = await runAction({
      page: fakePage(solidPng(108, 108, 108)),
      action: diffAction({ ssimThreshold: 0.999 }),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    // …but 0.997 < 0.999, so the tighter gate marks it changed.
    assert.equal(tightened.status, 'changed');
  });

  it('the same pair passes under the default ssimThreshold (the flip baseline)', async () => {
    const config = await makeConfig();
    await seedCache(config, solidPng(100, 100, 100));
    const result = await runAction({
      page: fakePage(solidPng(108, 108, 108)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.equal(result.status, 'pass');
  });

  it('a loosened ssimThreshold flips a would-be changed into pass', async () => {
    const config = await makeConfig();
    // This pair scores SSIM ~0.971; changed under the 0.99 default…
    await seedCache(config, solidPng(10, 20, 30));
    const loosened = await runAction({
      page: fakePage(solidPng(15, 25, 35)),
      action: diffAction({ ssimThreshold: 0.95 }),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    // …but 0.971 >= 0.95, so the looser gate accepts it as a pass.
    assert.equal(loosened.status, 'pass');
  });

  it('the same pair is changed under the default ssimThreshold (the flip baseline)', async () => {
    const config = await makeConfig();
    await seedCache(config, solidPng(10, 20, 30));
    const result = await runAction({
      page: fakePage(solidPng(15, 25, 35)),
      action: action('open'),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    assert.equal(result.status, 'changed');
  });

  it('pixelThreshold tunes the reported pixel-diff metric WITHOUT moving the pass/changed gate', async () => {
    // pixelThreshold governs the diff-PNG pixel count only; SSIM alone gates
    // pass vs changed (see the schema doc). This pair scores SSIM ~0.984, so it
    // is `changed` under both thresholds; but its per-pixel colour delta
    // straddles the two pixel thresholds, so only the reported diffPixels move.
    const config = await makeConfig();
    await seedCache(config, solidPng(100, 100, 100));
    const tight = await runAction({
      page: fakePage(solidPng(120, 120, 120)),
      action: diffAction({ pixelThreshold: 0.01 }),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    const loose = await runAction({
      page: fakePage(solidPng(120, 120, 120)),
      action: diffAction({ pixelThreshold: 0.1 }),
      parameters: {},
      storyFile: 'home.json',
      config,
      breakpoint: 'desktop',
      mode: 'local',
    });
    // Both changed; the gate did not move…
    assert.equal(tight.status, 'changed');
    assert.equal(loose.status, 'changed');
    // …but the tighter pixel threshold flags all four pixels while the default
    // flags none, proving the override reaches the pixel-diff metric.
    assert.equal(tight.diffPixels, 4);
    assert.equal(loose.diffPixels, 0);
  });
});
