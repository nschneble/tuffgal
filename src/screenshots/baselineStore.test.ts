import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { pathsFor, withBaselineLock } from './baselineStore.ts';

const base = '/baselines';
const report = '/report';

describe('pathsFor — breakpoint keying', () => {
  it('keys baseline + a11y baseline by breakpoint under the action dir', () => {
    const paths = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 'login.json',
      actionName: 'submit',
      breakpoint: 'mobile',
    });
    assert.equal(paths.baseline, join(base, 'submit', 'mobile.png'));
    assert.equal(paths.a11yBaseline, join(base, 'submit', 'mobile.a11y.yaml'));
  });

  it('splices the breakpoint into report-side filenames', () => {
    const paths = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 'login.json',
      actionName: 'submit',
      breakpoint: 'mobile',
    });
    const dir = join(report, 'screenshots', 'login');
    assert.equal(paths.actual, join(dir, 'submit.mobile.actual.png'));
    assert.equal(paths.diff, join(dir, 'submit.mobile.diff.png'));
    assert.equal(paths.a11yActual, join(dir, 'submit.mobile.a11y.yaml'));
  });

  it('produces disjoint paths for two breakpoints of the same action', () => {
    // The whole point of this wave: a desktop capture and a mobile capture of
    // one action must never land on the same file. If any field collided the
    // second run would overwrite the first.
    const common = {
      baselinesDir: base,
      reportDir: report,
      storyFile: 'login.json',
      actionName: 'submit',
    };
    const desktop = pathsFor({ ...common, breakpoint: 'desktop' });
    const mobile = pathsFor({ ...common, breakpoint: 'mobile' });
    for (const key of [
      'baseline',
      'actual',
      'diff',
      'a11yBaseline',
      'a11yActual',
    ] as const) {
      assert.notEqual(
        desktop[key],
        mobile[key],
        `${key} collided across breakpoints`,
      );
    }
  });

  it('strips the .json suffix from the story slug', () => {
    const paths = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 'nested/Login.JSON',
      actionName: 'submit',
      breakpoint: 'desktop',
    });
    // Suffix match is case-insensitive; the directory part is preserved.
    assert.equal(
      paths.actual,
      join(report, 'screenshots', 'nested/Login', 'submit.desktop.actual.png'),
    );
  });
});

describe('pathsFor — breakpoint sanitization', () => {
  it('lowercases and collapses unsafe characters to dashes', () => {
    const paths = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 's.json',
      actionName: 'a',
      // Path separators and dots would let a breakpoint escape its action
      // directory or fake an extension; both must be neutralised.
      breakpoint: 'Wide/Screen.2x',
    });
    assert.equal(paths.baseline, join(base, 'a', 'wide-screen-2x.png'));
  });

  it('leaves already-safe identifiers untouched', () => {
    const paths = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 's.json',
      actionName: 'a',
      breakpoint: 'viewport',
    });
    assert.equal(paths.baseline, join(base, 'a', 'viewport.png'));
  });
});

describe('pathsFor — legacy fallback', () => {
  it('returns pre-breakpoint baseline locations independent of breakpoint', () => {
    // Legacy paths describe where a pre-feature project committed its single
    // baseline, so they must NOT carry the breakpoint — the same `0.png` is
    // the fallback for every breakpoint of the action.
    const desktop = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 's.json',
      actionName: 'submit',
      breakpoint: 'desktop',
    });
    const mobile = pathsFor({
      baselinesDir: base,
      reportDir: report,
      storyFile: 's.json',
      actionName: 'submit',
      breakpoint: 'mobile',
    });
    assert.equal(desktop.legacyBaseline, join(base, 'submit', '0.png'));
    assert.equal(desktop.legacyA11yBaseline, join(base, 'submit', 'a11y.yaml'));
    assert.equal(desktop.legacyBaseline, mobile.legacyBaseline);
    assert.equal(desktop.legacyA11yBaseline, mobile.legacyA11yBaseline);
  });
});

describe('withBaselineLock — per-breakpoint isolation', () => {
  it('serializes callers sharing a key but lets distinct keys run in parallel', async () => {
    // Same key (one breakpoint's baseline): the second critical section must
    // not start until the first settles, mirroring the read-then-write race
    // the lock exists to prevent.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withBaselineLock('/baselines/a/desktop.png', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = withBaselineLock('/baselines/a/desktop.png', async () => {
      order.push('second-start');
    });
    // A different breakpoint key is independent and runs without waiting on
    // the still-pending first holder.
    const other = withBaselineLock('/baselines/a/mobile.png', async () => {
      order.push('other');
    });
    await other;
    assert.deepEqual(order, ['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, [
      'first-start',
      'other',
      'first-end',
      'second-start',
    ]);
  });
});
