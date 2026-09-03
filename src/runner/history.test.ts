import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ActionResult, StoryResult } from '../schema/result.ts';
import {
  MAX_HISTORY_ENTRIES,
  appendEntry,
  applyRunHistory,
  historyKey,
  isHistoryStoreShape,
  readHistory,
  writeHistory,
  type HistoryEntry,
  type HistoryStore,
} from './history.ts';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    finishedAt: '2026-06-11T12:00:00.000Z',
    diffPixels: 4,
    diffRatio: 0.001,
    ...over,
  };
}

function action(over: Partial<ActionResult> = {}): ActionResult {
  return {
    action: 'visit-home',
    breakpoint: 'desktop',
    status: 'pass',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.100Z',
    durationMs: 100,
    ...over,
  };
}

function story(
  actions: ActionResult[],
  over: Partial<StoryResult> = {},
): StoryResult {
  return {
    story: 'home renders',
    file: 'stories/home.story.json',
    status: 'pass',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.100Z',
    durationMs: 100,
    actions,
    ...over,
  };
}

describe('historyKey', () => {
  it('joins action and breakpoint with an unambiguous separator', () => {
    assert.equal(historyKey('visit-home', 'desktop'), 'visit-home::desktop');
  });

  it('falls back to an empty breakpoint segment when undefined', () => {
    assert.equal(historyKey('visit-home', undefined), 'visit-home::');
  });
});

describe('isHistoryStoreShape', () => {
  it('accepts an empty object', () => {
    assert.equal(isHistoryStoreShape({}), true);
  });

  it('accepts a well-formed store', () => {
    assert.equal(
      isHistoryStoreShape({ 'visit-home::desktop': [entry()] }),
      true,
    );
  });

  it('rejects an array at the top level', () => {
    assert.equal(isHistoryStoreShape([]), false);
  });

  it('rejects null', () => {
    assert.equal(isHistoryStoreShape(null), false);
  });

  it('rejects a non-array series', () => {
    assert.equal(isHistoryStoreShape({ a: 'not an array' }), false);
  });

  it('rejects an entry missing a required numeric field', () => {
    assert.equal(
      isHistoryStoreShape({ a: [{ finishedAt: 'x', diffPixels: 1 }] }),
      false,
    );
  });

  it('rejects an entry with a wrong-typed field', () => {
    assert.equal(
      isHistoryStoreShape({
        a: [{ finishedAt: 'x', diffPixels: '1', diffRatio: 0.1 }],
      }),
      false,
    );
  });
});

describe('appendEntry', () => {
  it('appends under a fresh key', () => {
    const store: HistoryStore = {};
    const next = appendEntry(store, 'a::desktop', entry());
    assert.deepEqual(next, { 'a::desktop': [entry()] });
  });

  it('appends onto an existing series in order', () => {
    const store: HistoryStore = { 'a::desktop': [entry({ diffPixels: 1 })] };
    const next = appendEntry(store, 'a::desktop', entry({ diffPixels: 2 }));
    assert.deepEqual(
      next['a::desktop']!.map((e) => e.diffPixels),
      [1, 2],
    );
  });

  it('caps the series at MAX_HISTORY_ENTRIES, dropping the oldest first', () => {
    let store: HistoryStore = {};
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i += 1) {
      store = appendEntry(store, 'a::desktop', entry({ diffPixels: i }));
    }
    const series = store['a::desktop']!;
    assert.equal(series.length, MAX_HISTORY_ENTRIES);
    assert.equal(series[0]!.diffPixels, 5);
    assert.equal(
      series[series.length - 1]!.diffPixels,
      MAX_HISTORY_ENTRIES + 4,
    );
  });

  it('does not mutate the input store or its series', () => {
    const original: HistoryStore = { 'a::desktop': [entry({ diffPixels: 1 })] };
    const originalSeries = original['a::desktop'];
    const next = appendEntry(original, 'a::desktop', entry({ diffPixels: 2 }));
    assert.notEqual(next, original);
    assert.equal(original['a::desktop'], originalSeries);
    assert.equal(original['a::desktop']!.length, 1);
  });
});

describe('applyRunHistory', () => {
  it('attaches history (including this run) to a qualifying pass action', () => {
    const results = [story([action({ diffPixels: 3, diffRatio: 0.0005 })])];
    const { store, results: next } = applyRunHistory(
      {},
      results,
      '2026-06-12T12:00:00.000Z',
    );
    assert.deepEqual(store, {
      'visit-home::desktop': [
        {
          finishedAt: '2026-06-12T12:00:00.000Z',
          diffPixels: 3,
          diffRatio: 0.0005,
        },
      ],
    });
    assert.deepEqual(
      next[0]!.actions[0]!.history,
      store['visit-home::desktop'],
    );
  });

  it('attaches a multi-entry series built on a pre-existing store', () => {
    const base: HistoryStore = {
      'visit-home::desktop': [entry({ diffPixels: 1 })],
    };
    const results = [story([action({ diffPixels: 2, diffRatio: 0.0009 })])];
    const { results: next } = applyRunHistory(
      base,
      results,
      '2026-06-12T12:00:00.000Z',
    );
    assert.equal(next[0]!.actions[0]!.history!.length, 2);
  });

  it('leaves a new action with no history field', () => {
    const results = [story([action({ status: 'new' })])];
    const { results: next } = applyRunHistory({}, results, 'x');
    assert.equal(next[0]!.actions[0]!.history, undefined);
  });

  it('leaves a failed action with no history field', () => {
    const results = [story([action({ status: 'failed' })])];
    const { results: next } = applyRunHistory({}, results, 'x');
    assert.equal(next[0]!.actions[0]!.history, undefined);
  });

  it('leaves a size-mismatch changed action (no diffRatio) with no history field', () => {
    const results = [
      story([
        action({
          status: 'changed',
          failureMessage: 'size mismatch',
          diffPixels: undefined,
          diffRatio: undefined,
        }),
      ]),
    ];
    const { results: next } = applyRunHistory({}, results, 'x');
    assert.equal(next[0]!.actions[0]!.history, undefined);
  });

  it('appends one entry per occurrence when the same action+breakpoint runs in two stories', () => {
    const results = [
      story([action({ diffPixels: 1, diffRatio: 0.0001 })], {
        file: 'stories/a.story.json',
      }),
      story([action({ diffPixels: 2, diffRatio: 0.0002 })], {
        file: 'stories/b.story.json',
      }),
    ];
    const { store } = applyRunHistory({}, results, 'x');
    assert.equal(store['visit-home::desktop']!.length, 2);
    assert.deepEqual(
      store['visit-home::desktop']!.map((e) => e.diffPixels),
      [1, 2],
    );
  });

  it('does not mutate input StoryResult/ActionResult objects', () => {
    const frozenAction = Object.freeze(
      action({ diffPixels: 1, diffRatio: 0.0001 }),
    );
    const results = [Object.freeze(story([frozenAction]))];
    assert.doesNotThrow(() => applyRunHistory({}, results, 'x'));
  });

  it('returns the same story object reference when nothing qualified', () => {
    const s = story([action({ status: 'new' })]);
    const { results: next } = applyRunHistory({}, [s], 'x');
    assert.equal(next[0], s);
  });
});

describe('readHistory / writeHistory: round-trip through disk', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tuffgal-history-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty store when no file exists', async () => {
    const store = await readHistory(join(dir, 'no-such-dir', 'history.json'));
    assert.deepEqual(store, {});
  });

  it('returns an empty store for unparseable JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ not json', 'utf8');
    assert.deepEqual(await readHistory(path), {});
  });

  it('returns an empty store for well-formed JSON with the wrong shape', async () => {
    const path = join(dir, 'wrong-shape.json');
    await writeFile(path, JSON.stringify({ a: 'nope' }), 'utf8');
    assert.deepEqual(await readHistory(path), {});
  });

  it('round-trips a well-formed store, creating parent directories', async () => {
    const path = join(dir, 'nested', 'history.json');
    const store: HistoryStore = { 'a::desktop': [entry()] };
    await writeHistory(path, store);
    assert.deepEqual(await readHistory(path), store);
    const raw = await readFile(path, 'utf8');
    assert.ok(raw.endsWith('\n'), 'file ends with a trailing newline');
  });
});
