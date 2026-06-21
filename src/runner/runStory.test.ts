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
 * Minimal ResolvedConfig carrying only the breakpoints field `resolveRunSet`
 * reads. Cast through `unknown` so the test does not have to spell out the
 * dozen unrelated resolved fields just to exercise breakpoint selection.
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
  it('iterates every configured breakpoint in order when the story has no viewport override', () => {
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(story(), config);
    assert.deepEqual(
      runSet.map((bp) => bp.name),
      ['mobile', 'desktop'],
    );
    // The dimensions come straight from the resolved config — no remapping.
    assert.deepEqual(runSet[0], { name: 'mobile', width: 375, height: 667 });
  });

  it('honours a per-story viewport override as a single synthetic "viewport" run', () => {
    // A story that pinned its own viewport pre-breakpoints must NOT be
    // multiplied across the project matrix — it runs exactly once, at its own
    // dimensions, under the synthetic name `viewport` (mirrors config.ts).
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({ viewport: { width: 800, height: 600 } }),
      config,
    );
    assert.equal(runSet.length, 1);
    assert.deepEqual(runSet[0], { name: 'viewport', width: 800, height: 600 });
  });

  it('runs the intersection of story.breakpoints with config, in config order', () => {
    // Story lists desktop-then-mobile, but the kept entries follow CONFIG
    // order (mobile, desktop) so every story's modes appear consistently.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({ breakpoints: ['desktop', 'mobile'] }),
      config,
    );
    assert.deepEqual(
      runSet.map((bp) => bp.name),
      ['mobile', 'desktop'],
    );
    // Kept entries carry their resolved registry dimensions, not the story's.
    assert.deepEqual(runSet[0], { name: 'mobile', width: 375, height: 667 });
  });

  it('drops a story breakpoint the project did not configure', () => {
    // The story asks for `tablet`, but the project only runs mobile+desktop:
    // a story cannot force a mode the project opted out of.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({ breakpoints: ['mobile', 'tablet'] }),
      config,
    );
    assert.deepEqual(
      runSet.map((bp) => bp.name),
      ['mobile'],
    );
  });

  it('falls back to the full configured set when the intersection is empty', () => {
    // The story named only modes the project does not run. Rather than
    // silently producing zero screenshots (a vacuous pass that hides the
    // regression the story exists to catch), surface the mismatch by running
    // the full matrix.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(story({ breakpoints: ['tablet'] }), config);
    assert.deepEqual(
      runSet.map((bp) => bp.name),
      ['mobile', 'desktop'],
    );
  });

  it('falls back to the single synthetic mode when a story names breakpoints against a legacy viewport-only config', () => {
    // The story schema accepts any registry name regardless of what the
    // project configured, so a story can declare `breakpoints` before the
    // project migrates off a legacy `viewport`. The resolved config is then a
    // single synthetic `viewport` mode; intersecting it with a real name is
    // empty, so the story falls back to that one mode rather than vanishing.
    const config = configWithBreakpoints([
      { name: 'viewport', width: 800, height: 600 },
    ]);
    const runSet = resolveRunSet(story({ breakpoints: ['mobile'] }), config);
    assert.deepEqual(runSet, [{ name: 'viewport', width: 800, height: 600 }]);
  });

  it('collapses duplicate story breakpoint names to a single run', () => {
    // Filtering the (already-deduped) config list rather than mapping the
    // story's list means a repeated story name cannot double a run — guard
    // that invariant so a refactor to map over story.breakpoints can't
    // silently reintroduce doubled screenshots.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({ breakpoints: ['mobile', 'mobile'] }),
      config,
    );
    assert.deepEqual(
      runSet.map((bp) => bp.name),
      ['mobile'],
    );
  });

  it('lets a per-story viewport override win over story.breakpoints', () => {
    // `viewport` is the more specific, dimension-level instruction: when both
    // are set it pins one size and opts out of the matrix; `breakpoints` is
    // ignored.
    const config = configWithBreakpoints([
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
    const runSet = resolveRunSet(
      story({
        viewport: { width: 800, height: 600 },
        breakpoints: ['mobile'],
      }),
      config,
    );
    assert.equal(runSet.length, 1);
    assert.deepEqual(runSet[0], { name: 'viewport', width: 800, height: 600 });
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
