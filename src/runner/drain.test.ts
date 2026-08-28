import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoryResult } from '../schema/result.ts';
import {
  collectProducedLabels,
  drainSchedule,
  type StoryRunner,
} from './drain.ts';
import type { ScheduledStory } from './schedule.ts';

// drainSchedule takes needs/produces already normalised by buildSchedule and
// never reads disk, so these fixtures are built directly. A pre-seeded label is
// modelled the way drainSchedule actually sees one: a need no story in the list
// produces. The ScheduledStory annotation is what keeps the shape honest.
function makeScheduled(
  file: string,
  overrides: { needs?: string[]; produces?: string[] } = {},
): ScheduledStory {
  return {
    file,
    story: { story: file, actions: [{ action: 'noop' }] },
    needs: overrides.needs ?? [],
    produces: overrides.produces ?? [],
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

describe('collectProducedLabels', () => {
  it('unions every story produces, collapsing a repeated label', () => {
    const labels = collectProducedLabels([
      { produces: ['auth', 'cart'] },
      { produces: ['cart'] },
      { produces: [] },
    ] as unknown as ScheduledStory[]);

    assert.deepEqual([...labels].sort(), ['auth', 'cart']);
  });
});

describe('drainSchedule: execution', () => {
  it('resolves immediately for an empty schedule', async () => {
    const results = await drainSchedule([], 2, passRunner, noop, noop);
    assert.deepEqual(results, []);
  });

  it('runs all independent stories', async () => {
    const scheduled = [makeScheduled('a.json'), makeScheduled('b.json')];
    const results = await drainSchedule(scheduled, 2, passRunner, noop, noop);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === 'pass'));
  });

  it('runs a producer before its consumer', async () => {
    const scheduled = [
      makeScheduled('consumer.json', { needs: ['ready'] }),
      makeScheduled('producer.json', { produces: ['ready'] }),
    ];
    const order: string[] = [];
    const runner: StoryRunner = async (item) => {
      order.push(item.file);
      return passResult(item);
    };
    await drainSchedule(scheduled, 2, runner, noop, noop);
    assert.deepEqual(order, ['producer.json', 'consumer.json']);
  });

  // Nothing calls satisfyProduced for a label no story produces, so a drain
  // that waited on one would never resolve. The timeout is the assertion:
  // without it a regression hangs the suite instead of failing it.
  it(
    'runs a story whose only need is a pre-seeded label',
    { timeout: 5_000 },
    async () => {
      const scheduled = [makeScheduled('dark.json', { needs: ['theme-dark'] })];
      const ran: string[] = [];
      const runner: StoryRunner = async (item) => {
        ran.push(item.file);
        return passResult(item);
      };
      const results = await drainSchedule(scheduled, 2, runner, noop, noop);
      assert.deepEqual(ran, ['dark.json']);
      assert.equal(results[0]?.status, 'pass');
    },
  );

  it(
    'still waits for a producer when a story also needs a pre-seeded label',
    { timeout: 5_000 },
    async () => {
      const scheduled = [
        makeScheduled('consumer.json', { needs: ['theme-dark', 'ready'] }),
        makeScheduled('producer.json', { produces: ['ready'] }),
      ];
      const order: string[] = [];
      const runner: StoryRunner = async (item) => {
        order.push(item.file);
        return passResult(item);
      };
      await drainSchedule(scheduled, 2, runner, noop, noop);
      assert.deepEqual(order, ['producer.json', 'consumer.json']);
    },
  );

  it('synthesises a blocked failure for dependents of a failed producer', async () => {
    const scheduled = [
      makeScheduled('producer.json', { produces: ['ready'] }),
      makeScheduled('consumer.json', { needs: ['ready'] }),
    ];
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

  // One worker keeps seed.json queued, not in flight, when the producer fails.
  // With two it starts first and its own completion overwrites the synthetic
  // skip, so the assertion below reads `pass` either way and a predicate that
  // skipped on "has any need" would survive. Verified: at 2 workers this test
  // passes against that mutant.
  it(
    'leaves a pre-seeded need unblocked when an unrelated producer fails',
    { timeout: 5_000 },
    async () => {
      const scheduled = [
        makeScheduled('producer.json', { produces: ['ready'] }),
        makeScheduled('seed.json', { needs: ['theme-dark'] }),
        makeScheduled('dependent.json', { needs: ['ready'] }),
      ];
      const runner: StoryRunner = async (item) => {
        if (item.file === 'producer.json') {
          return { ...passResult(item), status: 'failed' };
        }
        return passResult(item);
      };
      const results = await drainSchedule(scheduled, 1, runner, noop, noop);
      const byFile = new Map(results.map((result) => [result.file, result]));
      assert.equal(byFile.get('seed.json')?.status, 'pass');
      assert.equal(byFile.get('dependent.json')?.status, 'failed');
      assert.equal(
        byFile.get('dependent.json')?.actions[0]?.action,
        '(blocked)',
      );
    },
  );

  it('cascades a failure transitively through the chain', async () => {
    // a (fails) -> b needs la -> c needs lb. Both b and c must be blocked.
    const scheduled = [
      makeScheduled('a.json', { produces: ['la'] }),
      makeScheduled('b.json', { needs: ['la'], produces: ['lb'] }),
      makeScheduled('c.json', { needs: ['lb'] }),
    ];
    const runner: StoryRunner = async (item) => {
      if (item.file === 'a.json') {
        return { ...passResult(item), status: 'failed' };
      }
      return passResult(item);
    };
    const results = await drainSchedule(scheduled, 4, runner, noop, noop);
    const byFile = new Map(results.map((result) => [result.file, result]));
    assert.equal(byFile.get('b.json')?.status, 'failed');
    assert.equal(byFile.get('c.json')?.status, 'failed');
    assert.match(
      byFile.get('b.json')?.actions[0]?.failureMessage ?? '',
      /blocked by failed prerequisite a\.json/,
    );
    // c is blocked by b (its direct prerequisite), not by the root a.
    assert.match(
      byFile.get('c.json')?.actions[0]?.failureMessage ?? '',
      /blocked by failed prerequisite b\.json/,
    );
    assert.equal(results.length, 3);
  });

  it('never exceeds the worker count in flight', async () => {
    const scheduled = [
      makeScheduled('a.json'),
      makeScheduled('b.json'),
      makeScheduled('c.json'),
      makeScheduled('d.json'),
    ];
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
