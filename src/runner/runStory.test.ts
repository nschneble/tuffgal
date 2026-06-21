import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
import type { Story } from '../schema/story.ts';
import { mergeStoryStatus, resolveRunSet } from './runStory.ts';

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
