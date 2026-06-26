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

const DESKTOP: ResolvedBreakpoint = { name: 'desktop', width: 1280, height: 800 };
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
    const passes = resolveBreakpointPasses([scheduled('a.json')], config([DESKTOP]));
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
      [scheduled('a.json', { breakpoints: [{ name: 'desktop', width: 1440 }] })],
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
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), DESKTOP), true);
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), MOBILE), true);
  });

  it('restricts an overriding story to its own breakpoints', () => {
    const item = scheduled('a.json', { breakpoints: ['mobile'] });
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), MOBILE), true);
    assert.equal(storyRendersAt(item, config([DESKTOP, MOBILE]), DESKTOP), false);
  });
});

describe('adaptNeedsForPass', () => {
  it('keeps needs whose producer also runs this pass', () => {
    const producer = scheduled('auth.json', { produces: ['session'] });
    const consumer = scheduled('home.json', { needs: ['session'] });
    const adapted = adaptNeedsForPass([producer, consumer]);
    assert.deepEqual(adapted[1]!.needs, ['session']);
  });

  it('drops a need whose producer is absent from this pass (satisfied off-disk)', () => {
    // Only the consumer participates — its producer renders at another
    // breakpoint and persisted auth state in that pass. Keeping the need would
    // deadlock the drain.
    const consumer = scheduled('home.json', { needs: ['session'] });
    const adapted = adaptNeedsForPass([consumer]);
    assert.deepEqual(adapted[0]!.needs, []);
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
      actions: [{ action: 'a', status: 'pass', breakpoint: 'desktop' }] as never,
    });
    const mobile = storyResult({
      status: 'changed',
      startedAt: '2026-01-01T00:00:02.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      durationMs: 3000,
      tracePath: '/t/mobile.zip',
      actions: [{ action: 'a', status: 'changed', breakpoint: 'mobile' }] as never,
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
