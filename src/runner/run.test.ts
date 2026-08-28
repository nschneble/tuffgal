import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import type { Browser, BrowserContext, Page } from 'playwright';

import type { ResolvedConfig } from '../config.ts';
import type { CapturedBrowser } from './manifest.ts';
import type { ActionResult, RunResult, StoryResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import {
  copyResultsIntoCandidates,
  coverageComparisonRoot,
  createRunTeardown,
  createSignalTeardownHandler,
  drivingBreakpoints,
  formatResultLine,
  formatSummaryBullet,
  resolveEnvironmentReport,
  runAll,
  summarise,
} from './run.ts';

function action(
  breakpoint: string,
  status: ActionResult['status'],
): ActionResult {
  return {
    action: 'a',
    breakpoint,
    status,
    startedAt: 'x',
    finishedAt: 'x',
    durationMs: 1,
  };
}

function story(
  status: StoryResult['status'],
  actions: ActionResult[],
): StoryResult {
  return {
    story: 's',
    file: 'f.json',
    status,
    startedAt: 'x',
    finishedAt: 'x',
    durationMs: 1,
    actions,
  };
}

describe('drivingBreakpoints', () => {
  it('returns nothing for a single-breakpoint story (nothing to disambiguate)', () => {
    const result = story('changed', [
      action('desktop', 'pass'),
      action('desktop', 'changed'),
    ]);
    assert.deepEqual(drivingBreakpoints(result), []);
  });

  it('names only the breakpoint that drove a changed status', () => {
    const result = story('changed', [
      action('desktop', 'pass'),
      action('desktop', 'changed'),
      action('mobile', 'pass'),
      action('mobile', 'pass'),
    ]);
    assert.deepEqual(drivingBreakpoints(result), ['desktop']);
  });

  it('names every driving breakpoint, in first-seen order', () => {
    const result = story('changed', [
      action('desktop', 'changed'),
      action('mobile', 'changed'),
    ]);
    assert.deepEqual(drivingBreakpoints(result), ['desktop', 'mobile']);
  });

  it('treats a skipped action as a failure driver', () => {
    const result = story('failed', [
      action('desktop', 'failed'),
      action('mobile', 'pass'),
      // mobile stayed clean; desktop is the only failing mode
    ]);
    assert.deepEqual(drivingBreakpoints(result), ['desktop']);
  });

  it('attributes a skipped breakpoint to failed too', () => {
    const result = story('failed', [
      action('mobile', 'skipped'),
      action('desktop', 'pass'),
    ]);
    assert.deepEqual(drivingBreakpoints(result), ['mobile']);
  });

  it('names the new breakpoint when the story is new', () => {
    const result = story('new', [
      action('desktop', 'pass'),
      action('mobile', 'new'),
    ]);
    assert.deepEqual(drivingBreakpoints(result), ['mobile']);
  });
});

describe('summarise', () => {
  it('counts new-status stories distinctly from changed', () => {
    const results = [
      story('new', [action('desktop', 'new')]),
      story('new', [action('desktop', 'new')]),
      story('changed', [action('desktop', 'changed')]),
      story('pass', [action('desktop', 'pass')]),
    ];
    const totals = summarise(results);
    assert.equal(totals.new, 2);
    assert.equal(totals.changed, 1);
    assert.equal(totals.passed, 1);
    assert.equal(totals.stories, 4);
  });

  it('seeds deleted at 0: orphans are a run-level count, not a story outcome', () => {
    assert.equal(
      summarise([story('pass', [action('desktop', 'pass')])]).deleted,
      0,
    );
  });
});

describe('copyResultsIntoCandidates', () => {
  it('copies results.json into a freshly-created candidates dir', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'tuffgal-run-'));
    await writeFile(
      join(reportDir, 'results.json'),
      JSON.stringify({ mode: 'ci', stories: [] }),
      'utf8',
    );

    // candidates/ does not exist yet; an all-pass run writes no candidate
    // renders; so the copy must create it rather than fail.
    assert.equal(await pathExists(join(reportDir, 'candidates')), false);
    await copyResultsIntoCandidates(reportDir);

    const copied = await readFile(
      join(reportDir, 'candidates', 'results.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(copied), { mode: 'ci', stories: [] });
  });

  it('overwrites an existing candidates/results.json (candidate renders already present)', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'tuffgal-run-'));
    await writeFile(
      join(reportDir, 'results.json'),
      JSON.stringify({ mode: 'ci', totals: { changed: 1 } }),
      'utf8',
    );
    await mkdir(join(reportDir, 'candidates'), { recursive: true });
    await writeFile(
      join(reportDir, 'candidates', 'results.json'),
      'stale',
      'utf8',
    );

    await copyResultsIntoCandidates(reportDir);

    const copied = await readFile(
      join(reportDir, 'candidates', 'results.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(copied), {
      mode: 'ci',
      totals: { changed: 1 },
    });
  });
});

describe('formatResultLine', () => {
  it('leads with the symbol for each status', () => {
    assert.match(formatResultLine('pass', 1, 1000, 'f.json'), /^✓ /);
    assert.match(formatResultLine('changed', 1, 1000, 'f.json'), /^~ /);
    assert.match(formatResultLine('new', 1, 1000, 'f.json'), /^\+ /);
    assert.match(formatResultLine('failed', 1, 1000, 'f.json'), /^✗ /);
  });

  it('rounds elapsed milliseconds to hundredths of a second', () => {
    assert.equal(
      formatResultLine('pass', 4, 3974, 'screen-tour-unauthenticated.json'),
      '✓ 4 3.97s screen-tour-unauthenticated',
    );
    assert.equal(
      formatResultLine(
        'pass',
        1,
        890,
        'unauthenticated-user-visits-extension-authorize.json',
      ),
      '✓ 1 0.89s unauthenticated-user-visits-extension-authorize',
    );
  });

  it('strips only a trailing .json from the story stem', () => {
    assert.equal(
      formatResultLine(
        'changed',
        2,
        2710,
        'user-crashes-app-via-failwhale.json',
      ),
      '~ 2 2.71s user-crashes-app-via-failwhale',
    );
  });
});

describe('formatSummaryBullet', () => {
  const counts = (over: Partial<RunResult['totals']>): RunResult['totals'] => ({
    stories: 0,
    passed: 0,
    changed: 0,
    failed: 0,
    new: 0,
    deleted: 0,
    ...over,
  });

  it('joins multiple nonzero categories in passed/new/changed/failed order', () => {
    assert.equal(
      formatSummaryBullet('mobile', counts({ passed: 2, changed: 1 })),
      '• 2 passed, 1 changed on "mobile" breakpoint',
    );
  });

  it('emits a single bullet category when only one is nonzero', () => {
    assert.equal(
      formatSummaryBullet('desktop', counts({ passed: 3 })),
      '• 3 passed on "desktop" breakpoint',
    );
  });

  it('omits zero categories while keeping the fixed order', () => {
    assert.equal(
      formatSummaryBullet('tablet', counts({ passed: 1, new: 2, failed: 3 })),
      '• 1 passed, 2 new, 3 failed on "tablet" breakpoint',
    );
  });

  it('falls back to 0 passed for an all-zero pass', () => {
    assert.equal(
      formatSummaryBullet('laptop', counts({})),
      '• 0 passed on "laptop" breakpoint',
    );
  });
});

/** A ResolvedConfig stub carrying just the fields the mode-gated seams read. */
function envConfig(): ResolvedConfig {
  return {
    paths: {
      baselines: '/repo/tuffgal/baselines',
      localCache: '/repo/tuffgal/.cache',
    },
    captureMode: 'viewport',
    frozenTime: '2026-01-15T12:00:00.000Z',
    breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
  } as unknown as ResolvedConfig;
}

describe('coverageComparisonRoot', () => {
  it('measures against committed baselines in CI mode', () => {
    assert.equal(
      coverageComparisonRoot(envConfig(), 'ci'),
      '/repo/tuffgal/baselines',
    );
  });

  it('measures against the per-machine cache in local mode (never paths.baselines)', () => {
    // PRD invariant: a local run never reads paths.baselines. The metric must
    // point at the cache it actually diffed against.
    assert.equal(
      coverageComparisonRoot(envConfig(), 'local'),
      '/repo/tuffgal/.cache',
    );
  });
});

describe('resolveEnvironmentReport: browser probe gating', () => {
  it('does NOT launch the browser probe in local mode', async () => {
    let probed = 0;
    const probe = async (): Promise<CapturedBrowser> => {
      probed += 1;
      return { name: 'chromium', version: '131.0.0.0' };
    };
    const report = await resolveEnvironmentReport(envConfig(), 'local', probe);

    // The whole point: local mode never gates on browserVersion, so it must not
    // pay for a throwaway chromium launch.
    assert.equal(probed, 0, 'probe must not run in local mode');
    assert.equal(report.expected, null);
    assert.equal(report.mismatch, false);
    // The env block is still recorded (provenance), with an empty sentinel
    // version standing in for the skipped probe.
    assert.equal(report.actual.browserVersion, '');
    assert.equal(report.actual.browser, 'chromium');
  });

  it('DOES launch the browser probe in CI mode', async () => {
    let probed = 0;
    const probe = async (): Promise<CapturedBrowser> => {
      probed += 1;
      return { name: 'chromium', version: '131.0.0.0' };
    };
    // Bootstrap case: no manifest on disk under this fake baselines dir, so the
    // comparison is missing → no mismatch, but the probe still ran.
    const report = await resolveEnvironmentReport(envConfig(), 'ci', probe);

    assert.equal(probed, 1, 'probe must run once in CI mode');
    assert.equal(report.actual.browserVersion, '131.0.0.0');
  });
});

/**
 * A 2x2 solid-colour PNG; `runAction` diffs real PNG bytes via pngjs, so the
 * fake page's screenshot must be a genuine image, not a stub buffer.
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

/** The slice of `Page` one screenshot action of a story touches. */
function fakePage(screenshot: Buffer): Page {
  return {
    clock: { async install(): Promise<void> {} },
    async waitForTimeout(): Promise<void> {},
    async evaluate(): Promise<void> {},
    async screenshot(): Promise<Buffer> {
      return screenshot;
    },
    locator() {
      return {
        async ariaSnapshot(): Promise<string> {
          return '- document';
        },
      };
    },
  } as unknown as Page;
}

/**
 * A `BrowserContext` over a single fake page; the per-story isolation unit.
 * `storageState` writes the file it is handed, as the real one does, so a
 * producer story leaves auth on disk for its consumer to resolve.
 */
function fakeContext(page: Page): BrowserContext {
  return {
    setDefaultTimeout(): void {},
    tracing: {
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
    },
    async newPage(): Promise<Page> {
      return page;
    },
    async storageState(opts?: { path?: string }): Promise<unknown> {
      if (opts?.path) {
        await writeFile(
          opts.path,
          JSON.stringify({ cookies: [], origins: [] }),
        );
      }
      return {};
    },
    async close(): Promise<void> {},
  } as unknown as BrowserContext;
}

describe('runAll: shared browser lifecycle', () => {
  it('launches ONE browser, reuses it across stories, and closes it once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tuffgal-runall-'));
    const actionsDir = join(root, 'actions');
    const storiesDir = join(root, 'stories');
    await mkdir(actionsDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      join(actionsDir, 'open.json'),
      JSON.stringify({ action: 'open', steps: [{ kind: 'wait', ms: 0 }] }),
    );
    // Two independent stories (no needs/produces) so both are ready at once ;
    // the shared browser must serve both without a second launch.
    await writeFile(
      join(storiesDir, 'home.json'),
      JSON.stringify({ story: 'home', actions: [{ action: 'open' }] }),
    );
    await writeFile(
      join(storiesDir, 'about.json'),
      JSON.stringify({ story: 'about', actions: [{ action: 'open' }] }),
    );

    const config = {
      baseUrl: 'http://localhost:3000',
      defaultTimeoutMs: 1000,
      frozenTime: '2026-01-15T12:00:00.000Z',
      captureMode: 'viewport',
      interactiveMode: false,
      breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
      paths: {
        actions: actionsDir,
        stories: storiesDir,
        baselines: join(root, 'baselines'),
        localCache: join(root, 'cache'),
        report: join(root, 'report'),
        authState: join(root, 'auth'),
      },
    } as unknown as ResolvedConfig;

    let launches = 0;
    let contextsCreated = 0;
    let closes = 0;
    const distinctContexts = new Set<BrowserContext>();
    const browser = {
      async newContext(): Promise<BrowserContext> {
        contextsCreated += 1;
        const context = fakeContext(fakePage(solidPng(9, 9, 9)));
        distinctContexts.add(context);
        return context;
      },
      version(): string {
        return '131.0.0.0';
      },
      async close(): Promise<void> {
        closes += 1;
      },
    } as unknown as Browser;
    const launchBrowser = async (): Promise<Browser> => {
      launches += 1;
      return browser;
    };

    // Snapshot the signal-listener counts before the run so we can prove the
    // finally removes exactly the handlers it installed.
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const result = await runAll(
      config,
      { headed: false, mode: 'local' },
      launchBrowser,
    );

    // ONE launch for the whole run; not one per (story × breakpoint) pass.
    assert.equal(launches, 1, 'browser must launch exactly once');
    // The single browser was reused: one context per story (2 stories ×
    // 1 breakpoint), each a DISTINCT context so per-story isolation survives a
    // shared browser.
    assert.equal(contextsCreated, 2, 'one fresh context per story');
    assert.equal(distinctContexts.size, 2, 'contexts must not be shared');
    // Closed exactly once, on the normal finally path; no leak, no double-close.
    assert.equal(closes, 1, 'browser closed once on completion');
    assert.equal(result.totals.stories, 2);
    // The finally removes both SIGINT/SIGTERM listeners it installed: net zero
    // added across a full runAll, so repeated in-process runs don't leak
    // handlers (the no-listener-leak invariant the docstring claims).
    assert.equal(
      process.listenerCount('SIGINT'),
      sigintBefore,
      'SIGINT listener must be removed after runAll',
    );
    assert.equal(
      process.listenerCount('SIGTERM'),
      sigtermBefore,
      'SIGTERM listener must be removed after runAll',
    );
  });
});

describe('runAll: each breakpoint pass renders at its own viewport', () => {
  // nothing else pins this: folding breakpoint into base stays green
  it('varies the viewport per pass and tags each story with both breakpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tuffgal-runall-bp-'));
    const actionsDir = join(root, 'actions');
    const storiesDir = join(root, 'stories');
    await mkdir(actionsDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      join(actionsDir, 'open.json'),
      JSON.stringify({ action: 'open', steps: [{ kind: 'wait', ms: 0 }] }),
    );
    await writeFile(
      join(storiesDir, 'home.json'),
      JSON.stringify({ story: 'home', actions: [{ action: 'open' }] }),
    );
    await writeFile(
      join(storiesDir, 'about.json'),
      JSON.stringify({ story: 'about', actions: [{ action: 'open' }] }),
    );

    const config = {
      baseUrl: 'http://localhost:3000',
      defaultTimeoutMs: 1000,
      frozenTime: '2026-01-15T12:00:00.000Z',
      captureMode: 'viewport',
      interactiveMode: false,
      breakpoints: [
        { name: 'mobile', width: 390, height: 844 },
        { name: 'desktop', width: 1280, height: 800 },
      ],
      paths: {
        actions: actionsDir,
        stories: storiesDir,
        baselines: join(root, 'baselines'),
        localCache: join(root, 'cache'),
        report: join(root, 'report'),
        authState: join(root, 'auth'),
      },
    } as unknown as ResolvedConfig;

    const viewports: string[] = [];
    const browser = {
      async newContext(options: {
        viewport?: { width: number; height: number };
      }): Promise<BrowserContext> {
        viewports.push(
          `${options.viewport?.width}x${options.viewport?.height}`,
        );
        return fakeContext(fakePage(solidPng(9, 9, 9)));
      },
      version(): string {
        return '131.0.0.0';
      },
      async close(): Promise<void> {},
    } as unknown as Browser;

    const result = await runAll(
      config,
      { headed: false, mode: 'local' },
      async () => browser,
    );

    assert.deepEqual(viewports.toSorted(), [
      '1280x800',
      '1280x800',
      '390x844',
      '390x844',
    ]);
    assert.equal(result.totals.stories, 2);
    for (const storyResult of result.stories) {
      assert.deepEqual(
        storyResult.actions.map((each) => each.breakpoint).toSorted(),
        ['desktop', 'mobile'],
        `${storyResult.file} must carry an action per breakpoint`,
      );
    }
  });
});

describe('runAll: a consumer prefers its producer auth over a pre-seeded file', () => {
  // The only place the produced-before-pre-seeded ranking is exercised end to
  // end. runStory.test.ts proves the resolver ranks correctly when it is handed
  // the produced set; this proves runAll actually hands it over.
  it('loads the producer file even though the pre-seeded label is listed first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tuffgal-runall-auth-'));
    const actionsDir = join(root, 'actions');
    const storiesDir = join(root, 'stories');
    const authStateDir = join(root, 'auth');
    await mkdir(actionsDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await mkdir(authStateDir, { recursive: true });
    await writeFile(
      join(actionsDir, 'open.json'),
      JSON.stringify({ action: 'open', steps: [{ kind: 'wait', ms: 0 }] }),
    );
    await writeFile(
      join(storiesDir, 'login.json'),
      JSON.stringify({
        story: 'login',
        produces: ['auth'],
        actions: [{ action: 'open' }],
      }),
    );
    await writeFile(
      join(storiesDir, 'profile.json'),
      JSON.stringify({
        story: 'profile',
        needs: ['seeded', 'auth'],
        actions: [{ action: 'open' }],
      }),
    );
    // The pre-seeded file is on disk before the run and `seededLabels` below
    // declares it, which together are why buildSchedule accepts a `seeded`
    // label no story produces.
    const seededFile = join(authStateDir, 'seeded.json');
    await writeFile(seededFile, JSON.stringify({ cookies: [], origins: [] }));

    const config = {
      baseUrl: 'http://localhost:3000',
      defaultTimeoutMs: 1000,
      frozenTime: '2026-01-15T12:00:00.000Z',
      captureMode: 'viewport',
      interactiveMode: false,
      seededLabels: ['seeded'],
      breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
      paths: {
        actions: actionsDir,
        stories: storiesDir,
        baselines: join(root, 'baselines'),
        localCache: join(root, 'cache'),
        report: join(root, 'report'),
        authState: authStateDir,
      },
    } as unknown as ResolvedConfig;

    const storageStates: Array<string | undefined> = [];
    const browser = {
      async newContext(options: {
        storageState?: string;
      }): Promise<BrowserContext> {
        storageStates.push(options.storageState);
        return fakeContext(fakePage(solidPng(9, 9, 9)));
      },
      version(): string {
        return '131.0.0.0';
      },
      async close(): Promise<void> {},
    } as unknown as Browser;

    await runAll(config, { headed: false, mode: 'local' }, async () => browser);

    // The producer runs first with no auth of its own, then the consumer, whose
    // `needs` lists `seeded` ahead of `auth`, loads what the producer wrote.
    assert.deepEqual(storageStates, [
      undefined,
      join(authStateDir, 'auth.json'),
    ]);
  });
});

describe('runAll: a --story filter does not reclassify a produced label', () => {
  // `collectProducedLabels` reads the WHOLE schedule, not the filtered subset,
  // so filtering a producer out of the run cannot demote its label to
  // pre-seeded. Nothing else pins that: moving the collect below the filter
  // leaves the rest of the suite green.
  it('loads the filtered-out producer file, not the pre-seeded one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tuffgal-runall-filter-'));
    const actionsDir = join(root, 'actions');
    const storiesDir = join(root, 'stories');
    const authStateDir = join(root, 'auth');
    await mkdir(actionsDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await mkdir(authStateDir, { recursive: true });
    await writeFile(
      join(actionsDir, 'open.json'),
      JSON.stringify({ action: 'open', steps: [{ kind: 'wait', ms: 0 }] }),
    );
    await writeFile(
      join(storiesDir, 'login.json'),
      JSON.stringify({
        story: 'login',
        produces: ['auth'],
        actions: [{ action: 'open' }],
      }),
    );
    await writeFile(
      join(storiesDir, 'profile.json'),
      JSON.stringify({
        story: 'profile',
        needs: ['seeded', 'auth'],
        actions: [{ action: 'open' }],
      }),
    );
    // Both files are on disk before the run: `seeded.json` because the project
    // seeds it, `auth.json` as residue a previous unfiltered run left behind.
    // So the only thing left to decide which one loads is whether `auth` is
    // still ranked as a produced label with its producer filtered out.
    await writeFile(
      join(authStateDir, 'seeded.json'),
      JSON.stringify({ cookies: [], origins: [] }),
    );
    await writeFile(
      join(authStateDir, 'auth.json'),
      JSON.stringify({ cookies: [], origins: [] }),
    );

    const config = {
      baseUrl: 'http://localhost:3000',
      defaultTimeoutMs: 1000,
      frozenTime: '2026-01-15T12:00:00.000Z',
      captureMode: 'viewport',
      interactiveMode: false,
      seededLabels: ['seeded'],
      breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
      paths: {
        actions: actionsDir,
        stories: storiesDir,
        baselines: join(root, 'baselines'),
        localCache: join(root, 'cache'),
        report: join(root, 'report'),
        authState: authStateDir,
      },
    } as unknown as ResolvedConfig;

    const storageStates: Array<string | undefined> = [];
    const browser = {
      async newContext(options: {
        storageState?: string;
      }): Promise<BrowserContext> {
        storageStates.push(options.storageState);
        return fakeContext(fakePage(solidPng(9, 9, 9)));
      },
      version(): string {
        return '131.0.0.0';
      },
      async close(): Promise<void> {},
    } as unknown as Browser;

    const result = await runAll(
      config,
      { headed: false, mode: 'local', storyFilter: 'profile' },
      async () => browser,
    );

    // The producer never ran, so only the consumer opened a context.
    assert.equal(result.totals.stories, 1);
    // `needs` lists `seeded` first and both files exist, so a filter that
    // demoted `auth` to pre-seeded would load `seeded.json` here.
    assert.deepEqual(storageStates, [join(authStateDir, 'auth.json')]);
  });
});

describe('createRunTeardown', () => {
  it('closes the shared browser and stops managed servers, exactly once', async () => {
    let closes = 0;
    let stops = 0;
    const teardown = createRunTeardown({
      browser: {
        async close(): Promise<void> {
          closes += 1;
        },
      },
      managedServers: {
        async stop(): Promise<void> {
          stops += 1;
        },
      },
    });

    await teardown();
    assert.equal(closes, 1);
    assert.equal(stops, 1);

    // Idempotent: the normal finally path calling teardown after a signal
    // already did must NOT double-close.
    await teardown();
    assert.equal(closes, 1);
    assert.equal(stops, 1);
  });

  it('tears down the browser even when no managed servers were started', async () => {
    let closes = 0;
    const teardown = createRunTeardown({
      browser: {
        async close(): Promise<void> {
          closes += 1;
        },
      },
    });

    // Must not throw on the absent managedServers.
    await teardown();
    assert.equal(closes, 1);
  });
});

describe('createSignalTeardownHandler', () => {
  it('a simulated signal closes the browser, stops servers, and exits non-zero', async () => {
    let closes = 0;
    let stops = 0;
    const exitCodes: number[] = [];
    const teardown = createRunTeardown({
      browser: {
        async close(): Promise<void> {
          closes += 1;
        },
      },
      managedServers: {
        async stop(): Promise<void> {
          stops += 1;
        },
      },
    });
    const handler = createSignalTeardownHandler(teardown, (code) =>
      exitCodes.push(code),
    );

    // Drive the handler directly; no real signal raised in the test runner.
    handler();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(closes, 1);
    assert.equal(stops, 1);
    assert.deepEqual(exitCodes, [1], 'interrupted run must exit non-zero');
  });

  it('a second signal does not double-close (idempotent teardown)', async () => {
    let closes = 0;
    const exitCodes: number[] = [];
    const teardown = createRunTeardown({
      browser: {
        async close(): Promise<void> {
          closes += 1;
        },
      },
    });
    const handler = createSignalTeardownHandler(teardown, (code) =>
      exitCodes.push(code),
    );

    handler();
    handler();
    await new Promise((resolve) => setImmediate(resolve));

    // Two signals, one close; the shared latch swallows the redundant teardown.
    assert.equal(closes, 1);
    assert.deepEqual(exitCodes, [1, 1]);
  });
});
