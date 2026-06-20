import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoryFile } from '../schema/load.ts';
import type { Story } from '../schema/story.ts';
import type { StoryResult } from '../schema/result.ts';
import {
  buildSchedule,
  drainSchedule,
  SchedulerError,
  type ScheduledStory,
  type StoryRunner,
} from './scheduler.ts';

function makeStoryFile(
  file: string,
  overrides: Partial<Story> = {},
): StoryFile {
  return {
    file,
    story: {
      story: file,
      actions: [{ action: 'noop' }],
      ...overrides,
    },
  };
}

function passResult(item: ScheduledStory): StoryResult {
  return {
    story: item.story.story,
    file: item.file,
    status: 'pass',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    actions: [],
  };
}

// drainSchedule's correctness relies on the runner always being async (the
// completion callback re-enters fillSlots only via .then). Mirror that here.
const passRunner: StoryRunner = (item) => Promise.resolve(passResult(item));

const noop = (): void => {};

describe('buildSchedule — validation', () => {
  it('throws when two stories produce the same label', () => {
    const stories = [
      makeStoryFile('a.json', { produces: ['shared'] }),
      makeStoryFile('b.json', { produces: ['shared'] }),
    ];
    assert.throws(() => buildSchedule(stories), SchedulerError);
  });

  it('throws when a needed label has no producer', () => {
    const stories = [makeStoryFile('a.json', { needs: ['missing'] })];
    assert.throws(() => buildSchedule(stories), SchedulerError);
  });

  it('throws on a dependency cycle', () => {
    const stories = [
      makeStoryFile('a.json', { needs: ['lb'], produces: ['la'] }),
      makeStoryFile('b.json', { needs: ['la'], produces: ['lb'] }),
    ];
    assert.throws(
      () => buildSchedule(stories),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.match(error.message, /Cycle detected/);
        return true;
      },
    );
  });

  it('folds storageState "logged-in" into needs', () => {
    const stories = [
      makeStoryFile('auth.json', { produces: ['logged-in'] }),
      makeStoryFile('dash.json', { storageState: 'logged-in' }),
    ];
    const scheduled = buildSchedule(stories);
    const dash = scheduled.find((item) => item.file === 'dash.json');
    assert.ok(dash);
    assert.deepEqual(dash.needs, ['logged-in']);
  });
});

describe('drainSchedule — execution', () => {
  it('resolves immediately for an empty schedule', async () => {
    const results = await drainSchedule([], 2, passRunner, noop, noop);
    assert.deepEqual(results, []);
  });

  it('runs all independent stories', async () => {
    const scheduled = buildSchedule([
      makeStoryFile('a.json'),
      makeStoryFile('b.json'),
    ]);
    const results = await drainSchedule(scheduled, 2, passRunner, noop, noop);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === 'pass'));
  });

  it('runs a producer before its consumer', async () => {
    const scheduled = buildSchedule([
      makeStoryFile('consumer.json', { needs: ['ready'] }),
      makeStoryFile('producer.json', { produces: ['ready'] }),
    ]);
    const order: string[] = [];
    const runner: StoryRunner = async (item) => {
      order.push(item.file);
      return passResult(item);
    };
    await drainSchedule(scheduled, 2, runner, noop, noop);
    assert.deepEqual(order, ['producer.json', 'consumer.json']);
  });

  it('synthesises a blocked failure for dependents of a failed producer', async () => {
    const scheduled = buildSchedule([
      makeStoryFile('producer.json', { produces: ['ready'] }),
      makeStoryFile('consumer.json', { needs: ['ready'] }),
    ]);
    const runner: StoryRunner = async (item) => {
      if (item.file === 'producer.json') {
        return { ...passResult(item), status: 'failed' };
      }
      return passResult(item);
    };
    const results = await drainSchedule(scheduled, 2, runner, noop, noop);
    const consumer = results.find((result) => result.file === 'consumer.json');
    assert.ok(consumer);
    assert.equal(consumer.status, 'failed');
    assert.equal(consumer.actions[0]?.action, '(blocked)');
    assert.match(
      consumer.actions[0]?.failureMessage ?? '',
      /blocked by failed prerequisite producer\.json/,
    );
  });

  it('never exceeds the worker count in flight', async () => {
    const scheduled = buildSchedule([
      makeStoryFile('a.json'),
      makeStoryFile('b.json'),
      makeStoryFile('c.json'),
      makeStoryFile('d.json'),
    ]);
    let active = 0;
    let peak = 0;
    const runner: StoryRunner = async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return passResult(item);
    };
    await drainSchedule(scheduled, 2, runner, noop, noop);
    assert.ok(peak <= 2, `peak in-flight was ${peak}, expected <= 2`);
  });
});
