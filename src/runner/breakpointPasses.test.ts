import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ResolvedBreakpoint, ResolvedConfig } from '../config.ts';
import type { StoryResult } from '../schema/result.ts';
import type { ScheduledStory } from './scheduler.ts';
import {
  adaptNeedsForPass,
  mergeStoryResults,
  resolveBreakpointPasses,
  storyRendersAt,
} from './breakpointPasses.ts';

const DESKTOP: ResolvedBreakpoint = {
  name: 'desktop',
  width: 1280,
  height: 800,
};
const MOBILE: ResolvedBreakpoint = { name: 'mobile', width: 375, height: 667 };

function config(breakpoints: ResolvedBreakpoint[]): ResolvedConfig {
  return { breakpoints } as unknown as ResolvedConfig;
}

// `story.breakpoints` is the only field the helpers read off the story.
function scheduled(
  file: string,
  extras: {
    breakpoints?: unknown;
    needs?: string[];
    produces?: string[];
  } = {},
): ScheduledStory {
  return {
    file,
    story: { story: file, breakpoints: extras.breakpoints },
    needs: extras.needs ?? [],
    produces: extras.produces ?? [],
  } as unknown as ScheduledStory;
}

function storyResult(overrides: Partial<StoryResult>): StoryResult {
  return {
    story: 's',
    file: 'a.json',
    status: 'pass',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    actions: [],
    ...overrides,
  };
}

describe('resolveBreakpointPasses', () => {
  it('returns the single config breakpoint when nothing overrides', () => {
    const passes = resolveBreakpointPasses(
      [scheduled('a.json')],
      config([DESKTOP]),
    );
    assert.deepEqual(passes, [DESKTOP]);
  });

  it('keeps config order for multiple breakpoints', () => {
    const passes = resolveBreakpointPasses(
      [scheduled('a.json')],
      config([DESKTOP, MOBILE]),
    );
    assert.deepEqual(
      passes.map((p) => p.name),
      ['desktop', 'mobile'],
    );
  });

  it('dedupes a per-story override that matches a config breakpoint', () => {
    const passes = resolveBreakpointPasses(
      [scheduled('a.json', { breakpoints: ['desktop'] })],
      config([DESKTOP]),
    );
    assert.equal(passes.length, 1);
  });

  it('appends a per-story breakpoint the config does not list', () => {
    const passes = resolveBreakpointPasses(
      [scheduled('a.json', { breakpoints: ['mobile'] })],
      config([DESKTOP]),
    );
    assert.deepEqual(
      passes.map((p) => p.name),
      ['desktop', 'mobile'],
    );
  });

  it('treats a dimension override of the same name as its own pass', () => {
    const passes = resolveBreakpointPasses(
      [
        scheduled('a.json', {
          breakpoints: [{ name: 'desktop', width: 1440 }],
        }),
      ],
      config([DESKTOP]),
    );
    // desktop@1280x800 (config) + desktop@1440x800 (override) are distinct
    // render targets, each wanting its own clean database.
    assert.equal(passes.length, 2);
    assert.deepEqual(
      passes.map((p) => p.width),
      [1280, 1440],
    );
  });
});

describe('storyRendersAt', () => {
  it('matches a story with no override against any config breakpoint', () => {
    const item = scheduled('a.json');
    assert.equal(
      storyRendersAt(item, config([DESKTOP, MOBILE]), DESKTOP),
      true,
    );
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), MOBILE), true);
  });

  it('restricts an overriding story to its own breakpoints', () => {
    const item = scheduled('a.json', { breakpoints: ['mobile'] });
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), MOBILE), true);
    assert.equal(
      storyRendersAt(item, config([DESKTOP, MOBILE]), DESKTOP),
      false,
    );
  });
});

describe('adaptNeedsForPass', () => {
  it('keeps scheduler needs whose producer also runs this pass', () => {
    const producer = scheduled('auth.json', { produces: ['session'] });
    const consumer = scheduled('home.json', { needs: ['session'] });
    const adapted = adaptNeedsForPass([producer, consumer]);
    // Same-breakpoint scheduling still holds the need so the drain waits on the
    // producer (no deadlock introduced by the split)...
    assert.deepEqual(adapted[1]!.needs, ['session']);
    // ...and the auth-loading set carries the same label so on-disk auth loads.
    assert.deepEqual(adapted[1]!.authNeeds, ['session']);
  });

  it('drops a scheduler need whose producer is absent but RETAINS it for auth', () => {
    // Only the consumer participates; its producer renders at another
    // breakpoint and persisted auth state in that pass. Keeping the scheduler
    // need would deadlock the drain, so `needs` is stripped; but `authNeeds`
    // must retain the label so `resolveStorageStateForNeeds` still loads the
    // producer's off-disk auth. Stripping both is the bug that renders the
    // consumer logged-out.
    const consumer = scheduled('home.json', { needs: ['session'] });
    const adapted = adaptNeedsForPass([consumer]);
    assert.deepEqual(adapted[0]!.needs, []);
    assert.deepEqual(adapted[0]!.authNeeds, ['session']);
  });

  it('cross-breakpoint consumer keeps auth need while scheduler need is stripped', () => {
    // The load-bearing invariant. Project default renders `login` (produces
    // `auth`) at `desktop`; a mobile-only story overrides breakpoints:['mobile']
    // and needs:['auth']. In the `mobile` pass only the consumer participates.
    const consumer = scheduled('profile.json', {
      breakpoints: ['mobile'],
      needs: ['auth'],
    });
    const mobilePass = adaptNeedsForPass([consumer]);
    // Scheduler-facing: stripped, so the mobile pass does not deadlock waiting
    // on a producer that renders only in the desktop pass.
    assert.deepEqual(mobilePass[0]!.needs, []);
    // Auth-facing: retained, so `resolveStorageStateForNeeds` reads
    // <authState>/auth.json that the desktop-pass producer already persisted.
    assert.deepEqual(mobilePass[0]!.authNeeds, ['auth']);
  });

  it('leaves produces untouched', () => {
    const producer = scheduled('auth.json', { produces: ['session'] });
    const adapted = adaptNeedsForPass([producer]);
    assert.deepEqual(adapted[0]!.produces, ['session']);
  });
});

describe('mergeStoryResults', () => {
  it('returns the single part unchanged for a one-breakpoint run', () => {
    const only = storyResult({ status: 'changed' });
    assert.equal(mergeStoryResults([only]), only);
  });

  it('folds parts into the worst status, concatenated actions, summed duration', () => {
    const desktop = storyResult({
      status: 'pass',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 2000,
      actions: [
        { action: 'a', status: 'pass', breakpoint: 'desktop' },
      ] as never,
    });
    const mobile = storyResult({
      status: 'changed',
      startedAt: '2026-01-01T00:00:02.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      durationMs: 3000,
      tracePath: '/t/mobile.zip',
      actions: [
        { action: 'a', status: 'changed', breakpoint: 'mobile' },
      ] as never,
    });
    const merged = mergeStoryResults([desktop, mobile]);
    assert.equal(merged.status, 'changed');
    assert.equal(merged.startedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(merged.finishedAt, '2026-01-01T00:00:05.000Z');
    assert.equal(merged.durationMs, 5000);
    assert.equal(merged.actions.length, 2);
    assert.deepEqual(
      merged.actions.map((a) => a.breakpoint),
      ['desktop', 'mobile'],
    );
  });

  it('takes the first trace zip across passes', () => {
    const a = storyResult({ tracePath: '/t/first.zip' });
    const b = storyResult({ tracePath: '/t/second.zip' });
    assert.equal(mergeStoryResults([a, b]).tracePath, '/t/first.zip');
  });
});
