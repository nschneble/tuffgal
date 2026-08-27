import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
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

// buildSchedule probes <authState>/<label>.json for labels no story produces,
// so every call needs a real directory. This one stays empty; tests that want
// a pre-seeded label write into a fresh subdirectory of it.
const authStateRoot = mkdtempSync(join(tmpdir(), 'tuffgal-scheduler-'));

after(() => {
  rmSync(authStateRoot, { recursive: true, force: true });
});

/** buildSchedule only reads `paths.authState`, so the fixture carries that. */
function schedulerConfig(authState: string = authStateRoot): ResolvedConfig {
  return { paths: { authState } } as unknown as ResolvedConfig;
}

/** A directory holding one seeded storage state per label. */
function seededAuthState(prefix: string, ...labels: string[]): string {
  const dir = mkdtempSync(join(authStateRoot, `${prefix}-`));
  for (const label of labels) {
    writeFileSync(
      join(dir, `${label}.json`),
      JSON.stringify({ cookies: [], origins: [] }),
    );
  }
  return dir;
}

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

describe('buildSchedule: validation', () => {
  it('throws when two stories produce the same label', () => {
    const stories = [
      makeStoryFile('a.json', { produces: ['shared'] }),
      makeStoryFile('b.json', { produces: ['shared'] }),
    ];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig()),
      SchedulerError,
    );
  });

  it('throws when a needed label has no producer', () => {
    const stories = [makeStoryFile('a.json', { needs: ['missing'] })];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig()),
      SchedulerError,
    );
  });

  it('throws on a dependency cycle', () => {
    const stories = [
      makeStoryFile('a.json', { needs: ['lb'], produces: ['la'] }),
      makeStoryFile('b.json', { needs: ['la'], produces: ['lb'] }),
    ];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig()),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.match(error.message, /Cycle detected/);
        return true;
      },
    );
  });

  it('accepts a producerless label seeded on disk, and only that label', () => {
    const authState = seededAuthState('build', 'theme-dark');
    const scheduled = buildSchedule(
      [makeStoryFile('dark.json', { needs: ['theme-dark'] })],
      schedulerConfig(authState),
    );
    assert.deepEqual(scheduled[0]?.needs, ['theme-dark']);
    // A sibling label in the same directory has no file, so it still throws:
    // the probe is per label, not "the auth directory exists".
    assert.throws(
      () =>
        buildSchedule(
          [makeStoryFile('light.json', { needs: ['theme-light'] })],
          schedulerConfig(authState),
        ),
      SchedulerError,
    );
  });

  it('folds storageState "logged-in" into needs', () => {
    const stories = [
      makeStoryFile('auth.json', { produces: ['logged-in'] }),
      makeStoryFile('dash.json', { storageState: 'logged-in' }),
    ];
    const scheduled = buildSchedule(stories, schedulerConfig());
    const dash = scheduled.find((item) => item.file === 'dash.json');
    assert.ok(dash);
    assert.deepEqual(dash.needs, ['logged-in']);
  });
});

describe('drainSchedule: execution', () => {
  it('resolves immediately for an empty schedule', async () => {
    const results = await drainSchedule([], 2, passRunner, noop, noop);
    assert.deepEqual(results, []);
  });

  it('runs all independent stories', async () => {
    const scheduled = buildSchedule(
      [makeStoryFile('a.json'), makeStoryFile('b.json')],
      schedulerConfig(),
    );
    const results = await drainSchedule(scheduled, 2, passRunner, noop, noop);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === 'pass'));
  });

  it('runs a producer before its consumer', async () => {
    const scheduled = buildSchedule(
      [
        makeStoryFile('consumer.json', { needs: ['ready'] }),
        makeStoryFile('producer.json', { produces: ['ready'] }),
      ],
      schedulerConfig(),
    );
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
      const scheduled = buildSchedule(
        [makeStoryFile('dark.json', { needs: ['theme-dark'] })],
        schedulerConfig(seededAuthState('drain', 'theme-dark')),
      );
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
      const scheduled = buildSchedule(
        [
          makeStoryFile('consumer.json', { needs: ['theme-dark', 'ready'] }),
          makeStoryFile('producer.json', { produces: ['ready'] }),
        ],
        schedulerConfig(seededAuthState('mixed', 'theme-dark')),
      );
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
    const scheduled = buildSchedule(
      [
        makeStoryFile('producer.json', { produces: ['ready'] }),
        makeStoryFile('consumer.json', { needs: ['ready'] }),
      ],
      schedulerConfig(),
    );
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

  it('cascades a failure transitively through the chain', async () => {
    // a (fails) -> b needs la -> c needs lb. Both b and c must be blocked.
    const scheduled = buildSchedule(
      [
        makeStoryFile('a.json', { produces: ['la'] }),
        makeStoryFile('b.json', { needs: ['la'], produces: ['lb'] }),
        makeStoryFile('c.json', { needs: ['lb'] }),
      ],
      schedulerConfig(),
    );
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
    const scheduled = buildSchedule(
      [
        makeStoryFile('a.json'),
        makeStoryFile('b.json'),
        makeStoryFile('c.json'),
        makeStoryFile('d.json'),
      ],
      schedulerConfig(),
    );
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
