import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ActionResult, StoryResult } from '../schema/result.ts';
import {
  executedActionNames,
  LEGACY_BREAKPOINT,
  scanOrphanedBaselines,
  shouldScanForOrphans,
} from './orphanScan.ts';

async function tempBaselinesDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tuffgal-orphan-'));
}

/** Writes an empty file, creating parent dirs. */
async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '', 'utf8');
}

function story(actionNames: string[]): StoryResult {
  const actions: ActionResult[] = actionNames.map((name) => ({
    action: name,
    breakpoint: 'desktop',
    status: 'pass',
    startedAt: 'x',
    finishedAt: 'x',
    durationMs: 1,
  }));
  return {
    story: 's',
    file: 'f.json',
    status: 'pass',
    startedAt: 'x',
    finishedAt: 'x',
    durationMs: 1,
    actions,
  };
}

describe('executedActionNames', () => {
  it('collects distinct action names across stories and breakpoints', () => {
    const stories: StoryResult[] = [
      story(['visit-home', 'visit-home']),
      story(['visit-settings']),
    ];
    assert.deepEqual([...executedActionNames(stories)].sort(), [
      'visit-home',
      'visit-settings',
    ]);
  });

  it('counts a skipped action as executed (baseline was reachable this run)', () => {
    const s: StoryResult = {
      story: 's',
      file: 'f.json',
      status: 'failed',
      startedAt: 'x',
      finishedAt: 'x',
      durationMs: 1,
      actions: [
        {
          action: 'visit-broken',
          breakpoint: 'desktop',
          status: 'skipped',
          startedAt: 'x',
          finishedAt: 'x',
          durationMs: 0,
        },
      ],
    };
    assert.ok(executedActionNames([s]).has('visit-broken'));
  });
});

describe('shouldScanForOrphans', () => {
  it('scans an unfiltered CI run', () => {
    assert.equal(shouldScanForOrphans('ci', undefined), true);
  });

  it('does NOT scan a filtered CI run (unselected baselines are not orphans)', () => {
    assert.equal(shouldScanForOrphans('ci', 'user-logs-in'), false);
  });

  it('does NOT scan an unfiltered local run (local never reads baselines)', () => {
    assert.equal(shouldScanForOrphans('local', undefined), false);
  });

  it('does NOT scan a filtered local run', () => {
    assert.equal(shouldScanForOrphans('local', 'user-logs-in'), false);
  });
});

describe('scanOrphanedBaselines', () => {
  it('returns [] when the baselines dir does not exist', async () => {
    const orphans = await scanOrphanedBaselines(
      join(tmpdir(), 'tuffgal-does-not-exist-xyz'),
      new Set(['visit-home']),
    );
    assert.deepEqual(orphans, []);
  });

  it('finds a breakpoint-keyed orphan with its a11y companion', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-gone', 'desktop.png'));
    await touch(join(dir, 'visit-gone', 'desktop.a11y.yaml'));

    const orphans = await scanOrphanedBaselines(dir, new Set(['visit-home']));
    assert.deepEqual(orphans, [
      {
        action: 'visit-gone',
        breakpoint: 'desktop',
        baselinePaths: [
          join(dir, 'visit-gone', 'desktop.png'),
          join(dir, 'visit-gone', 'desktop.a11y.yaml'),
        ],
      },
    ]);
  });

  it('finds a legacy 0.png orphan with its a11y.yaml companion', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-old', '0.png'));
    await touch(join(dir, 'visit-old', 'a11y.yaml'));

    const orphans = await scanOrphanedBaselines(dir, new Set());
    assert.deepEqual(orphans, [
      {
        action: 'visit-old',
        breakpoint: LEGACY_BREAKPOINT,
        baselinePaths: [
          join(dir, 'visit-old', '0.png'),
          join(dir, 'visit-old', 'a11y.yaml'),
        ],
      },
    ]);
  });

  it('emits one entry per orphaned breakpoint of the same action', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-gone', 'mobile.png'));
    await touch(join(dir, 'visit-gone', 'desktop.png'));

    const orphans = await scanOrphanedBaselines(dir, new Set());
    assert.deepEqual(
      orphans.map((o) => o.breakpoint),
      ['desktop', 'mobile'],
    );
    assert.equal(orphans.length, 2);
  });

  it('omits the a11y companion from paths when it is absent on disk', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-gone', 'desktop.png'));

    const orphans = await scanOrphanedBaselines(dir, new Set());
    assert.deepEqual(orphans, [
      {
        action: 'visit-gone',
        breakpoint: 'desktop',
        baselinePaths: [join(dir, 'visit-gone', 'desktop.png')],
      },
    ]);
  });

  it('does NOT mark an executed action as an orphan (no false positive)', async () => {
    const dir = await tempBaselinesDir();
    // A live action with the full mix of layouts on disk.
    await touch(join(dir, 'visit-home', 'desktop.png'));
    await touch(join(dir, 'visit-home', 'desktop.a11y.yaml'));
    await touch(join(dir, 'visit-home', 'mobile.png'));
    await touch(join(dir, 'visit-home', '0.png'));
    await touch(join(dir, 'visit-home', 'a11y.yaml'));

    const orphans = await scanOrphanedBaselines(dir, new Set(['visit-home']));
    assert.deepEqual(orphans, []);
  });

  it('excludes a manifest.json file at the baselines root from orphan candidacy', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'manifest.json'));
    await touch(join(dir, 'visit-home', 'desktop.png'));

    const orphans = await scanOrphanedBaselines(dir, new Set(['visit-home']));
    assert.deepEqual(orphans, []);
  });

  it('detects without deleting: the orphaned files stay on disk', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-gone', 'desktop.png'));
    await touch(join(dir, 'visit-gone', 'desktop.a11y.yaml'));

    const orphans = await scanOrphanedBaselines(dir, new Set());
    assert.equal(orphans.length, 1);
    // Pruning is a later wave; the scan must never touch the filesystem.
    assert.deepEqual((await readdir(join(dir, 'visit-gone'))).sort(), [
      'desktop.a11y.yaml',
      'desktop.png',
    ]);
  });

  it('ignores stray non-png/non-companion files in an orphaned dir', async () => {
    const dir = await tempBaselinesDir();
    await touch(join(dir, 'visit-gone', 'desktop.png'));
    await touch(join(dir, 'visit-gone', 'notes.txt'));

    const orphans = await scanOrphanedBaselines(dir, new Set());
    assert.deepEqual(orphans, [
      {
        action: 'visit-gone',
        breakpoint: 'desktop',
        baselinePaths: [join(dir, 'visit-gone', 'desktop.png')],
      },
    ]);
  });
});
