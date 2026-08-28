import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
import type { StoryFile } from '../schema/load.ts';
import type { Story } from '../schema/story.ts';
import { collectProducedLabels } from './drain.ts';
import { buildSchedule, SchedulerError } from './schedule.ts';

// buildSchedule probes <authState>/<label>.json for labels no story produces,
// so every call needs a real directory. A root holds only the subdirectories
// `seededAuthState` mints under it, never a <label>.json of its own, so passing
// a root straight to `schedulerConfig` is the "nothing seeded" case.

/**
 * buildSchedule reads `paths.authState` and `seededLabels`, so the fixture
 * carries both. Admission needs the two together: a file on disk whose label
 * this list omits is rejected.
 */
function schedulerConfig(
  authState: string,
  seededLabels: string[] = [],
): ResolvedConfig {
  return { paths: { authState }, seededLabels } as unknown as ResolvedConfig;
}

function seededAuthState(
  root: string,
  prefix: string,
  ...labels: string[]
): string {
  const dir = mkdtempSync(join(root, `${prefix}-`));
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

describe('buildSchedule: validation', () => {
  let authStateRoot: string;
  before(() => {
    authStateRoot = mkdtempSync(join(tmpdir(), 'tuffgal-schedule-'));
  });
  after(() => {
    rmSync(authStateRoot, { recursive: true, force: true });
  });

  it('throws when two stories produce the same label', () => {
    const stories = [
      makeStoryFile('a.json', { produces: ['shared'] }),
      makeStoryFile('b.json', { produces: ['shared'] }),
    ];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig(authStateRoot)),
      SchedulerError,
    );
  });

  it('throws when a needed label has no producer', () => {
    const stories = [makeStoryFile('a.json', { needs: ['missing'] })];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig(authStateRoot)),
      SchedulerError,
    );
  });

  it('throws on a dependency cycle', () => {
    const stories = [
      makeStoryFile('a.json', { needs: ['lb'], produces: ['la'] }),
      makeStoryFile('b.json', { needs: ['la'], produces: ['lb'] }),
    ];
    assert.throws(
      () => buildSchedule(stories, schedulerConfig(authStateRoot)),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.match(error.message, /Cycle detected/);
        return true;
      },
    );
  });

  it('accepts a declared producerless label seeded on disk, and only that label', () => {
    const authState = seededAuthState(authStateRoot, 'build', 'theme-dark');
    const scheduled = buildSchedule(
      [makeStoryFile('dark.json', { needs: ['theme-dark'] })],
      schedulerConfig(authState, ['theme-dark']),
    );
    assert.deepEqual(scheduled[0]?.needs, ['theme-dark']);
    // A sibling label declared alongside it has no file of its own, so it
    // still throws: the probe is per label, not "the auth directory exists".
    assert.throws(
      () =>
        buildSchedule(
          [makeStoryFile('light.json', { needs: ['theme-light'] })],
          schedulerConfig(authState, ['theme-dark', 'theme-light']),
        ),
      SchedulerError,
    );
  });

  // The renamed/removed-producer case. <authState>/theme-dark.json outlives the
  // story that used to produce it (nothing ever prunes that directory), and no
  // config declares the label, so the residue must not stand in for the
  // producer it lost. A file on disk is not consent.
  it('throws for an undeclared producerless label even with its file on disk', () => {
    const authState = seededAuthState(authStateRoot, 'residue', 'theme-dark');
    assert.throws(
      () =>
        buildSchedule(
          [makeStoryFile('dark.json', { needs: ['theme-dark'] })],
          schedulerConfig(authState),
        ),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.match(error.message, /not listed in `seededLabels`/);
        // Distinct from the declared-but-unseeded message below. Collapsing
        // the two sends a user who declared the label hunting through their
        // config instead of at the seed script that never ran.
        assert.doesNotMatch(error.message, /no storage state exists/);
        return true;
      },
    );
  });

  it('throws for a declared label with no file, pointing at the seed', () => {
    const authState = seededAuthState(authStateRoot, 'unseeded');
    assert.throws(
      () =>
        buildSchedule(
          [makeStoryFile('dark.json', { needs: ['theme-dark'] })],
          schedulerConfig(authState, ['theme-dark']),
        ),
      (error: unknown) => {
        assert.ok(error instanceof SchedulerError);
        assert.match(error.message, /no storage state exists at/);
        assert.match(error.message, /declared in `seededLabels`/);
        assert.doesNotMatch(error.message, /not listed in `seededLabels`/);
        return true;
      },
    );
  });

  // A label can be both produced and declared. The producer wins and the
  // declaration is ignored, which is only observable through the file: nothing
  // seeds `ready.json` here, so a declaration that outranked the producer
  // would reach the seed probe and throw.
  it('lets a producer outrank a seededLabels declaration of the same label', () => {
    const authState = seededAuthState(authStateRoot, 'dual');
    const scheduled = buildSchedule(
      [
        makeStoryFile('producer.json', { produces: ['ready'] }),
        makeStoryFile('consumer.json', { needs: ['ready'] }),
      ],
      schedulerConfig(authState, ['ready']),
    );
    const consumer = scheduled.find((item) => item.file === 'consumer.json');
    assert.deepEqual(consumer?.needs, ['ready']);
    // Still a produced label, so it keeps gating readiness in drainSchedule
    // rather than being excluded as pre-seeded.
    assert.ok(collectProducedLabels(scheduled).has('ready'));
  });

  it('folds storageState "logged-in" into needs', () => {
    const stories = [
      makeStoryFile('auth.json', { produces: ['logged-in'] }),
      makeStoryFile('dash.json', { storageState: 'logged-in' }),
    ];
    const scheduled = buildSchedule(stories, schedulerConfig(authStateRoot));
    const dash = scheduled.find((item) => item.file === 'dash.json');
    assert.ok(dash);
    assert.deepEqual(dash.needs, ['logged-in']);
  });
});
