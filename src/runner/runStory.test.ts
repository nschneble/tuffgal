import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import type { Browser, BrowserContext, Page } from 'playwright';

import type { ResolvedConfig } from '../config.ts';
import type { Action } from '../schema/action.ts';
import type { Story } from '../schema/story.ts';
import {
  mergeStoryStatus,
  resolveRunSet,
  runStoryWithBrowser,
  type RunStoryOptions,
} from './runStory.ts';

/**
 * Minimal ResolvedConfig carrying only the field `resolveRunSet` reads — the
 * resolved breakpoint list. Cast through `unknown` so the test does not have to
 * spell out the dozen unrelated resolved fields just to exercise breakpoint
 * selection.
 */
function configWithBreakpoints(
  breakpoints: ResolvedConfig['breakpoints'],
): ResolvedConfig {
  return { breakpoints } as unknown as ResolvedConfig;
}

function story(overrides: Partial<Story> = {}): Story {
  return {
    story: 's',
    actions: [{ action: 'noop' }],
    ...overrides,
  };
}

describe('resolveRunSet', () => {
  it('runs the project breakpoints, in order, when the story names none', () => {
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(story(), config);
    assert.deepEqual(runSet, [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
  });

  it('replaces the project breakpoints with the story list, in story order', () => {
    // No intersection: the story's list stands alone and follows the STORY's
    // order, not the config's.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({ breakpoints: ['desktop', 'mobile'] }),
      config,
    );
    assert.deepEqual(runSet, [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'mobile', width: 375, height: 667 },
    ]);
  });

  it('lets a story run a mode the project does not configure', () => {
    // A mobile-only story in a desktop-only project: the story replaces the
    // project set outright, so `mobile` runs even though the project never
    // lists it. Resolved against the registry.
    const config = configWithBreakpoints([
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(story({ breakpoints: ['mobile'] }), config);
    assert.deepEqual(runSet, [{ name: 'mobile', width: 375, height: 667 }]);
  });

  it('collapses duplicate story breakpoint names, first entry wins', () => {
    const config = configWithBreakpoints([
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({
        breakpoints: [{ name: 'mobile', width: 400 }, 'mobile'],
      }),
      config,
    );
    // The later bare `mobile` is dropped; the first entry's override survives.
    assert.deepEqual(runSet, [{ name: 'mobile', width: 400, height: 667 }]);
  });

  it('overrides a mode dimension via a story selector object', () => {
    const config = configWithBreakpoints([
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({
        breakpoints: [{ name: 'desktop', width: 1920, height: 1080 }],
      }),
      config,
    );
    assert.deepEqual(runSet, [{ name: 'desktop', width: 1920, height: 1080 }]);
  });

  it('inherits the REGISTRY dimension for an axis the story override omits', () => {
    // The story list never references the project's per-mode overrides — an
    // omitted axis falls back to the registry default, not the config size.
    const config = configWithBreakpoints([
      { name: 'desktop', width: 1440, height: 900 },
    ]);
    const runSet = resolveRunSet(
      story({ breakpoints: [{ name: 'desktop', width: 1920 }] }),
      config,
    );
    // height is the registry 800, NOT the config's overridden 900.
    assert.deepEqual(runSet, [{ name: 'desktop', width: 1920, height: 800 }]);
  });
});

describe('mergeStoryStatus', () => {
  it('keeps the worst outcome across breakpoints: any failed wins', () => {
    assert.equal(mergeStoryStatus('pass', 'failed'), 'failed');
    assert.equal(mergeStoryStatus('changed', 'failed'), 'failed');
    assert.equal(mergeStoryStatus('failed', 'pass'), 'failed');
  });

  it('promotes pass to changed but never demotes failed', () => {
    assert.equal(mergeStoryStatus('pass', 'changed'), 'changed');
    assert.equal(mergeStoryStatus('changed', 'pass'), 'changed');
    assert.equal(mergeStoryStatus('failed', 'changed'), 'failed');
  });

  it('stays pass only when every breakpoint passed', () => {
    assert.equal(mergeStoryStatus('pass', 'pass'), 'pass');
  });

  it('ranks new above pass but below changed and failed', () => {
    assert.equal(mergeStoryStatus('pass', 'new'), 'new');
    assert.equal(mergeStoryStatus('new', 'pass'), 'new');
    // changed/failed outrank new in either order.
    assert.equal(mergeStoryStatus('new', 'changed'), 'changed');
    assert.equal(mergeStoryStatus('changed', 'new'), 'changed');
    assert.equal(mergeStoryStatus('new', 'failed'), 'failed');
    assert.equal(mergeStoryStatus('failed', 'new'), 'failed');
  });
});

/**
 * A 2x2 solid-colour PNG. `runAction` diffs real PNG bytes (via pngjs), so the
 * fake page's screenshot and any seeded baseline must be genuine images of
 * matching dimensions — a `Buffer.from('png')` stub would throw inside pngjs.
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

interface FakePageOptions {
  screenshot: Buffer;
  /** Make the single `wait` step throw → a `failed` ActionResult (not a leak). */
  failAction?: boolean;
  /**
   * Make `page.clock.install` throw → an exception that escapes
   * `runActionsForBreakpoint` entirely, exercising the infra-fault throw path
   * that must still close the context.
   */
  throwInLoop?: boolean;
}

/**
 * Stand-in for the slice of `Page` the per-breakpoint loop + a single-`wait`
 * action touch: a clock install, a deterministic screenshot, an aria snapshot,
 * and the no-op timer/evaluate the screenshot path calls. The two throw knobs
 * model the two distinct failure shapes the loop must handle differently — a
 * returned `failed` result vs. a thrown infra fault.
 */
function fakePage(options: FakePageOptions): Page {
  return {
    clock: {
      async install(): Promise<void> {
        if (options.throwInLoop) {
          throw new Error('clock install blew up');
        }
      },
    },
    async waitForTimeout(): Promise<void> {
      if (options.failAction) {
        throw new Error('wait step blew up');
      }
    },
    async evaluate(): Promise<void> {},
    async screenshot(): Promise<Buffer> {
      return options.screenshot;
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

interface ContextRecord {
  /** How many times `close()` was called on this context (leak guard). */
  closeCount: number;
  /** Paths passed to `storageState({ path })` — i.e. `produces` persistence. */
  storageStatePaths: string[];
  /** Paths passed to `tracing.stop({ path })` — i.e. failing-breakpoint zips. */
  tracePaths: string[];
}

/**
 * Fake `BrowserContext` over a single fake page. Records the lifecycle calls
 * the assertions inspect: context close (no-leak), `storageState` writes
 * (`produces`), and tracing-stop paths (trace-zip uniqueness).
 */
function fakeContext(page: Page): {
  context: BrowserContext;
  record: ContextRecord;
} {
  const record: ContextRecord = {
    closeCount: 0,
    storageStatePaths: [],
    tracePaths: [],
  };
  const context = {
    setDefaultTimeout(): void {},
    tracing: {
      async start(): Promise<void> {},
      async stop(opts?: { path?: string }): Promise<void> {
        if (opts?.path) record.tracePaths.push(opts.path);
      },
    },
    async newPage(): Promise<Page> {
      return page;
    },
    async storageState(opts: { path: string }): Promise<unknown> {
      record.storageStatePaths.push(opts.path);
      return {};
    },
    async close(): Promise<void> {
      record.closeCount += 1;
    },
  } as unknown as BrowserContext;
  return { context, record };
}

/**
 * Fake `Browser` that hands out a pre-built context per `newContext` call, in
 * order — one per breakpoint. Lets each test wire a distinct page/outcome to
 * each breakpoint without launching Chromium.
 */
function fakeBrowser(contexts: BrowserContext[]): Browser {
  let index = 0;
  return {
    async newContext(): Promise<BrowserContext> {
      const context = contexts[index];
      index += 1;
      if (!context) {
        throw new Error(`fake browser ran out of contexts at index ${index}`);
      }
      return context;
    },
  } as unknown as Browser;
}

function waitAction(name: string): Action {
  return {
    action: name,
    steps: [{ kind: 'wait', ms: 0 }],
    screenshot: true,
  } as unknown as Action;
}

async function makeConfig(): Promise<ResolvedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'tuffgal-runstory-'));
  return {
    baseUrl: 'http://localhost:3000',
    defaultTimeoutMs: 1000,
    frozenTime: '2026-01-15T12:00:00.000Z',
    breakpoints: [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ],
    paths: {
      baselines: join(root, 'baselines'),
      report: join(root, 'report'),
      authState: join(root, 'auth'),
    },
  } as unknown as ResolvedConfig;
}

function makeOptions(
  config: ResolvedConfig,
  overrides: Partial<RunStoryOptions> = {},
): RunStoryOptions {
  return {
    story: { story: 's', actions: [{ action: 'open' }] },
    file: 'home.json',
    needs: [],
    produces: [],
    actions: new Map([['open', waitAction('open')]]),
    config,
    headed: false,
    ...overrides,
  };
}

describe('runStoryWithBrowser — per-breakpoint loop', () => {
  it('re-applies the story fixtures before every breakpoint so each mode starts from a fresh seed', async () => {
    const config = await makeConfig();
    let seedCount = 0;
    (config as unknown as { database: unknown }).database = {
      fixtures: {
        seed: async (): Promise<void> => {
          seedCount += 1;
        },
      },
    };
    const first = fakeContext(fakePage({ screenshot: solidPng(1, 2, 3) }));
    const second = fakeContext(fakePage({ screenshot: solidPng(1, 2, 3) }));
    const browser = fakeBrowser([first.context, second.context]);

    await runStoryWithBrowser(
      browser,
      makeOptions(config, {
        story: {
          story: 's',
          fixtures: ['seed'],
          actions: [{ action: 'open' }],
        },
      }),
      new Date(),
    );

    // makeConfig runs two breakpoints (mobile, desktop). The fixture must be
    // applied once per breakpoint — not once for the whole story — so a
    // mutating story re-enters each mode from the same baseline rows.
    assert.equal(seedCount, 2);
  });

  it('runs the remaining breakpoint after the first one fails, and persists produces from the second', async () => {
    const config = await makeConfig();
    // First breakpoint's only action fails (wait step throws → `failed`
    // result, NOT a thrown exception). The second breakpoint runs clean.
    const first = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), failAction: true }),
    );
    const second = fakeContext(fakePage({ screenshot: solidPng(1, 2, 3) }));
    const browser = fakeBrowser([first.context, second.context]);

    const result = await runStoryWithBrowser(
      browser,
      makeOptions(config, { produces: ['logged-in'] }),
      new Date(),
    );

    // Both breakpoints produced results — the failure did not abort the loop.
    const breakpoints = result.actions.map((a) => a.breakpoint);
    assert.deepEqual(breakpoints, ['mobile', 'desktop']);
    assert.equal(result.status, 'failed');
    // Auth state came from the SECOND (clean) breakpoint's context, never the
    // first (failed) one — `produces` persists once, from the first clean run.
    assert.equal(first.record.storageStatePaths.length, 0);
    assert.equal(second.record.storageStatePaths.length, 1);
    assert.ok(second.record.storageStatePaths[0]?.endsWith('logged-in.json'));
    // Both contexts closed — no leak on either path.
    assert.equal(first.record.closeCount, 1);
    assert.equal(second.record.closeCount, 1);
  });

  it('writes a distinct trace zip per failing breakpoint and keeps the first in the StoryResult', async () => {
    const config = await makeConfig();
    // BOTH breakpoints fail their action → both stop tracing to a zip.
    const first = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), failAction: true }),
    );
    const second = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), failAction: true }),
    );
    const browser = fakeBrowser([first.context, second.context]);

    const result = await runStoryWithBrowser(
      browser,
      makeOptions(config),
      new Date(),
    );

    // Each failing breakpoint wrote its own uniquely-named zip
    // (`<slug>.<breakpoint>.zip`) — neither overwrote the other.
    assert.ok(first.record.tracePaths[0]?.endsWith(join('home.mobile.zip')));
    assert.ok(second.record.tracePaths[0]?.endsWith(join('home.desktop.zip')));
    assert.notEqual(first.record.tracePaths[0], second.record.tracePaths[0]);
    // The StoryResult carries only the FIRST failing breakpoint's zip.
    assert.equal(result.tracePath, first.record.tracePaths[0]);
  });

  it('persists no auth state when produces is declared but every breakpoint fails', async () => {
    const config = await makeConfig();
    const first = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), failAction: true }),
    );
    const second = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), failAction: true }),
    );
    const browser = fakeBrowser([first.context, second.context]);

    await runStoryWithBrowser(
      browser,
      makeOptions(config, { produces: ['logged-in'] }),
      new Date(),
    );

    // No clean breakpoint ⇒ persistProducedAuthState never called anywhere.
    assert.equal(first.record.storageStatePaths.length, 0);
    assert.equal(second.record.storageStatePaths.length, 0);
  });

  it('closes the context (no leak) when a breakpoint run throws an infra fault, then propagates', async () => {
    const config = await makeConfig();
    // `clock.install` throws — an exception that escapes the action runner
    // entirely. Per the Fix 1 throw policy it aborts the story, but must close
    // the in-flight context first.
    const first = fakeContext(
      fakePage({ screenshot: solidPng(1, 2, 3), throwInLoop: true }),
    );
    const second = fakeContext(fakePage({ screenshot: solidPng(1, 2, 3) }));
    const browser = fakeBrowser([first.context, second.context]);

    await assert.rejects(
      () => runStoryWithBrowser(browser, makeOptions(config), new Date()),
      /clock install blew up/,
    );

    // The throwing breakpoint's context was still closed — no leak.
    assert.equal(first.record.closeCount, 1);
    // The story aborted: the second breakpoint never opened a context.
    assert.equal(second.record.closeCount, 0);
  });
});
