import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
import type { CapturedBrowser } from './manifest.ts';
import type { ActionResult, RunResult, StoryResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import {
  copyResultsIntoCandidates,
  coverageComparisonRoot,
  drivingBreakpoints,
  formatResultLine,
  formatSummaryBullet,
  resolveEnvironmentReport,
  summarise,
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

describe('summarise', () => {
  it('counts new-status stories distinctly from changed', () => {
    const results = [
      story('new', [action('desktop', 'new')]),
      story('new', [action('desktop', 'new')]),
      story('changed', [action('desktop', 'changed')]),
      story('pass', [action('desktop', 'pass')]),
    ];
    const totals = summarise(results);
    assert.equal(totals.new, 2);
    assert.equal(totals.changed, 1);
    assert.equal(totals.passed, 1);
    assert.equal(totals.stories, 4);
  });

  it('seeds deleted at 0 — orphans are a run-level count, not a story outcome', () => {
    assert.equal(
      summarise([story('pass', [action('desktop', 'pass')])]).deleted,
      0,
    );
  });
});

describe('copyResultsIntoCandidates', () => {
  it('copies results.json into a freshly-created candidates dir', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'tuffgal-run-'));
    await writeFile(
      join(reportDir, 'results.json'),
      JSON.stringify({ mode: 'ci', stories: [] }),
      'utf8',
    );

    // candidates/ does not exist yet — an all-pass run writes no candidate
    // renders — so the copy must create it rather than fail.
    assert.equal(await pathExists(join(reportDir, 'candidates')), false);
    await copyResultsIntoCandidates(reportDir);

    const copied = await readFile(
      join(reportDir, 'candidates', 'results.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(copied), { mode: 'ci', stories: [] });
  });

  it('overwrites an existing candidates/results.json (candidate renders already present)', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'tuffgal-run-'));
    await writeFile(
      join(reportDir, 'results.json'),
      JSON.stringify({ mode: 'ci', totals: { changed: 1 } }),
      'utf8',
    );
    await mkdir(join(reportDir, 'candidates'), { recursive: true });
    await writeFile(
      join(reportDir, 'candidates', 'results.json'),
      'stale',
      'utf8',
    );

    await copyResultsIntoCandidates(reportDir);

    const copied = await readFile(
      join(reportDir, 'candidates', 'results.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(copied), {
      mode: 'ci',
      totals: { changed: 1 },
    });
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
    deleted: 0,
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

/** A ResolvedConfig stub carrying just the fields the mode-gated seams read. */
function envConfig(): ResolvedConfig {
  return {
    paths: {
      baselines: '/repo/tuffgal/baselines',
      localCache: '/repo/tuffgal/.cache',
    },
    captureMode: 'viewport',
    frozenTime: '2026-01-15T12:00:00.000Z',
    breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
  } as unknown as ResolvedConfig;
}

describe('coverageComparisonRoot', () => {
  it('measures against committed baselines in CI mode', () => {
    assert.equal(
      coverageComparisonRoot(envConfig(), 'ci'),
      '/repo/tuffgal/baselines',
    );
  });

  it('measures against the per-machine cache in local mode (never paths.baselines)', () => {
    // PRD invariant: a local run never reads paths.baselines. The metric must
    // point at the cache it actually diffed against.
    assert.equal(
      coverageComparisonRoot(envConfig(), 'local'),
      '/repo/tuffgal/.cache',
    );
  });
});

describe('resolveEnvironmentReport — browser probe gating', () => {
  it('does NOT launch the browser probe in local mode', async () => {
    let probed = 0;
    const probe = async (): Promise<CapturedBrowser> => {
      probed += 1;
      return { name: 'chromium', version: '131.0.0.0' };
    };
    const report = await resolveEnvironmentReport(envConfig(), 'local', probe);

    // The whole point: local mode never gates on browserVersion, so it must not
    // pay for a throwaway chromium launch.
    assert.equal(probed, 0, 'probe must not run in local mode');
    assert.equal(report.expected, null);
    assert.equal(report.mismatch, false);
    // The env block is still recorded (provenance), with an empty sentinel
    // version standing in for the skipped probe.
    assert.equal(report.actual.browserVersion, '');
    assert.equal(report.actual.browser, 'chromium');
  });

  it('DOES launch the browser probe in CI mode', async () => {
    let probed = 0;
    const probe = async (): Promise<CapturedBrowser> => {
      probed += 1;
      return { name: 'chromium', version: '131.0.0.0' };
    };
    // Bootstrap case: no manifest on disk under this fake baselines dir, so the
    // comparison is missing → no mismatch, but the probe still ran.
    const report = await resolveEnvironmentReport(envConfig(), 'ci', probe);

    assert.equal(probed, 1, 'probe must run once in CI mode');
    assert.equal(report.actual.browserVersion, '131.0.0.0');
  });
});
