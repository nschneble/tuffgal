import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
import type { ActionResult, RunResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import { approveAll } from './approve.ts';

let report: string;

beforeEach(async () => {
  report = await mkdtemp(join(tmpdir(), 'tuffgal-approve-'));
});

afterEach(async () => {
  await rm(report, { recursive: true, force: true });
});

function config(): ResolvedConfig {
  return { paths: { report } } as unknown as ResolvedConfig;
}

async function actual(name: string): Promise<string> {
  const path = join(report, `${name}.actual.png`);
  await writeFile(path, `pixels-${name}`, 'utf8');
  return path;
}

function action(overrides: Partial<ActionResult>): ActionResult {
  return {
    action: 'a',
    status: 'pass',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.000Z',
    durationMs: 0,
    ...overrides,
  };
}

async function writeResults(stories: RunResult['stories']): Promise<void> {
  const result = {
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:01.000Z',
    durationMs: 1000,
    totals: { stories: stories.length, passed: 0, changed: 0, failed: 0, new: 0 },
    customCoverage: {
      screens: { total: 0, covered: 0, ratio: 1, missing: [] },
      flows: { total: 0, covered: 0, ratio: 1, missing: [] },
    },
    stories,
  } satisfies RunResult;
  await writeFile(join(report, 'results.json'), JSON.stringify(result), 'utf8');
}

function story(
  file: string,
  actions: ActionResult[],
): RunResult['stories'][number] {
  return {
    story: file,
    file,
    status: 'changed',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.000Z',
    durationMs: 0,
    actions,
  };
}

describe('approveAll — errors', () => {
  it('throws a helpful error when no prior run exists', async () => {
    await assert.rejects(approveAll(config(), {}), /No prior run found/);
  });

  it('throws on a malformed results.json', async () => {
    await writeFile(join(report, 'results.json'), '{ broken', 'utf8');
    await assert.rejects(approveAll(config(), {}), /Malformed results file/);
  });
});

describe('approveAll — promotion', () => {
  it('promotes changed and new, skips pass/failed/skipped', async () => {
    const changedActual = await actual('changed');
    const newActual = await actual('new');
    const changedBaseline = join(report, 'baselines', 'changed', '0.png');
    const newBaseline = join(report, 'baselines', 'new', '0.png');
    await writeResults([
      story('s.json', [
        action({
          action: 'changed',
          status: 'changed',
          actualPath: changedActual,
          baselinePath: changedBaseline,
        }),
        action({
          action: 'new',
          status: 'new',
          actualPath: newActual,
          baselinePath: newBaseline,
        }),
        action({ action: 'pass', status: 'pass' }),
      ]),
    ]);

    const summary = await approveAll(config(), {});
    assert.equal(summary.approved, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(await readFile(changedBaseline, 'utf8'), 'pixels-changed');
    assert.equal(await readFile(newBaseline, 'utf8'), 'pixels-new');
  });

  it('newOnly promotes new baselines and skips changed', async () => {
    const changedActual = await actual('changed');
    const newActual = await actual('new');
    const changedBaseline = join(report, 'baselines', 'changed', '0.png');
    const newBaseline = join(report, 'baselines', 'new', '0.png');
    await writeResults([
      story('s.json', [
        action({
          action: 'changed',
          status: 'changed',
          actualPath: changedActual,
          baselinePath: changedBaseline,
        }),
        action({
          action: 'new',
          status: 'new',
          actualPath: newActual,
          baselinePath: newBaseline,
        }),
      ]),
    ]);

    const summary = await approveAll(config(), { newOnly: true });
    assert.equal(summary.approved, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(await pathExists(changedBaseline), false);
    assert.equal(await pathExists(newBaseline), true);
  });

  it('promotes breakpoint-keyed actuals to their matching baselines + a11y pair', async () => {
    // approve copies the paths recorded in results.json verbatim, so once the
    // runner (Wave 3) emits breakpoint-keyed paths, promotion is per-breakpoint
    // correct for free: each `<action>.<breakpoint>.actual.png` lands on its
    // own `<action>/<breakpoint>.png` and the a11y pair travels with it. This
    // guards that contract — two breakpoints of one action must not clobber.
    const desktopActual = await actual('submit.desktop');
    const mobileActual = await actual('submit.mobile');
    const desktopA11y = join(report, 'submit.desktop.a11y.yaml');
    const mobileA11y = join(report, 'submit.mobile.a11y.yaml');
    await writeFile(desktopA11y, 'tree-desktop', 'utf8');
    await writeFile(mobileA11y, 'tree-mobile', 'utf8');
    const desktopBaseline = join(report, 'baselines', 'submit', 'desktop.png');
    const mobileBaseline = join(report, 'baselines', 'submit', 'mobile.png');
    const desktopA11yBaseline = join(
      report,
      'baselines',
      'submit',
      'desktop.a11y.yaml',
    );
    const mobileA11yBaseline = join(
      report,
      'baselines',
      'submit',
      'mobile.a11y.yaml',
    );
    await writeResults([
      story('s.json', [
        action({
          action: 'submit',
          status: 'changed',
          actualPath: desktopActual,
          baselinePath: desktopBaseline,
          a11yActualPath: desktopA11y,
          a11yBaselinePath: desktopA11yBaseline,
        }),
        action({
          action: 'submit',
          status: 'changed',
          actualPath: mobileActual,
          baselinePath: mobileBaseline,
          a11yActualPath: mobileA11y,
          a11yBaselinePath: mobileA11yBaseline,
        }),
      ]),
    ]);

    const summary = await approveAll(config(), {});
    assert.equal(summary.approved, 2);
    assert.equal(
      await readFile(desktopBaseline, 'utf8'),
      'pixels-submit.desktop',
    );
    assert.equal(
      await readFile(mobileBaseline, 'utf8'),
      'pixels-submit.mobile',
    );
    assert.equal(await readFile(desktopA11yBaseline, 'utf8'), 'tree-desktop');
    assert.equal(await readFile(mobileA11yBaseline, 'utf8'), 'tree-mobile');
  });

  it('storyFilter limits promotion to the matched story', async () => {
    const keepActual = await actual('keep');
    const dropActual = await actual('drop');
    const keepBaseline = join(report, 'baselines', 'keep', '0.png');
    const dropBaseline = join(report, 'baselines', 'drop', '0.png');
    await writeResults([
      story('keep.json', [
        action({
          action: 'keep',
          status: 'changed',
          actualPath: keepActual,
          baselinePath: keepBaseline,
        }),
      ]),
      story('drop.json', [
        action({
          action: 'drop',
          status: 'changed',
          actualPath: dropActual,
          baselinePath: dropBaseline,
        }),
      ]),
    ]);

    const summary = await approveAll(config(), { storyFilter: 'keep.json' });
    assert.equal(summary.approved, 1);
    assert.equal(await pathExists(keepBaseline), true);
    assert.equal(await pathExists(dropBaseline), false);
  });
});
