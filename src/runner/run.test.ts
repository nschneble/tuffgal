import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ActionResult, StoryResult } from '../schema/result.ts';
import { drivingBreakpoints } from './run.ts';

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
