import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ActionResult, RunResult, StoryResult } from '../schema/result.ts';
import {
  drivingBreakpoints,
  formatResultLine,
  formatSummaryBullet,
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
