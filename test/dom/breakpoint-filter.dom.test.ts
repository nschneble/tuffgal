/**
 * Real-DOM coverage for the report's client-side filters, which `report.js`
 * owns and the node:test template suite cannot reach (it renders HTML strings,
 * never a live DOM). This launches Chromium, renders the multi-breakpoint
 * fixture, drives the status + breakpoint filters, and asserts the
 * intersection, empty-state, and live-region wording.
 *
 * NOT part of `npm test` (that suite is pure-unit and mocks Playwright so CI
 * needs no browser). Run it with `npm run test:dom`, which needs a Chromium
 * install first: `npm run install:browsers`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { renderReport } from '../../src/reporter/template.ts';
import type { RunResult } from '../../src/schema/result.ts';

const BP = {
  mobile: { breakpoint: 'mobile', breakpointWidth: 375, breakpointHeight: 667 },
  desktop: {
    breakpoint: 'desktop',
    breakpointWidth: 1280,
    breakpointHeight: 800,
  },
} as const;

function iso(s: string): string {
  return `2026-06-19T13:58:${s}.000Z`;
}

// home: pass @ mobile+desktop; settings: changed only @ desktop (mobile pass);
// checkout: failed @ mobile+desktop. This lets us prove the intersection:
// status=changed + bp=mobile -> 0 stories (settings' only changed action is
// desktop), while status=changed + bp=desktop -> 1 (settings).
const result = {
  startedAt: iso('17'),
  finishedAt: iso('52'),
  durationMs: 35000,
  totals: { stories: 3, passed: 1, changed: 1, failed: 1, new: 0, deleted: 0 },
  deleted: [],
  customCoverage: {
    screens: { total: 1, covered: 1, ratio: 1, missing: [] },
    flows: { total: 1, covered: 1, ratio: 1, missing: [] },
  },
  stories: [
    {
      story: 'home',
      file: 'home.json',
      status: 'pass',
      startedAt: iso('17'),
      finishedAt: iso('25'),
      durationMs: 8000,
      actions: [
        {
          ...BP.mobile,
          action: 'shot',
          status: 'pass',
          startedAt: iso('18'),
          finishedAt: iso('19'),
          durationMs: 700,
        },
        {
          ...BP.desktop,
          action: 'shot',
          status: 'pass',
          startedAt: iso('20'),
          finishedAt: iso('21'),
          durationMs: 700,
        },
      ],
    },
    {
      story: 'settings',
      file: 'settings.json',
      status: 'changed',
      startedAt: iso('25'),
      finishedAt: iso('40'),
      durationMs: 14000,
      actions: [
        {
          ...BP.mobile,
          action: 'shot',
          status: 'pass',
          startedAt: iso('26'),
          finishedAt: iso('27'),
          durationMs: 900,
        },
        {
          ...BP.desktop,
          action: 'shot',
          status: 'changed',
          startedAt: iso('28'),
          finishedAt: iso('29'),
          durationMs: 900,
        },
      ],
    },
    {
      story: 'checkout',
      file: 'checkout.json',
      status: 'failed',
      startedAt: iso('40'),
      finishedAt: iso('52'),
      durationMs: 12000,
      actions: [
        {
          ...BP.mobile,
          action: 'click',
          status: 'failed',
          startedAt: iso('41'),
          finishedAt: iso('46'),
          durationMs: 5000,
          failureMessage: 'boom',
        },
        {
          ...BP.desktop,
          action: 'click',
          status: 'failed',
          startedAt: iso('47'),
          finishedAt: iso('52'),
          durationMs: 5000,
          failureMessage: 'boom',
        },
      ],
    },
  ],
} as unknown as RunResult;

function visibleStoryFiles(page: Page): Promise<string[]> {
  return page.$$eval('.story:not([hidden]) .story-file', (els) =>
    els.map((e) => (e.textContent || '').trim()),
  );
}

async function statusText(page: Page): Promise<string> {
  return (
    await page.$eval('.story-filter-status', (e) => e.textContent || '')
  ).trim();
}

test('report.js status + breakpoint filters intersect, empty-state, and announce', async () => {
  const html = renderReport(result, '/fake', false);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // Inline report.js so setContent's relative <script src> executes.
    const js = await readFile(
      new URL('../../src/reporter/assets/report.js', import.meta.url),
      'utf8',
    );
    await page.addScriptTag({ content: js });

    // baseline: both filters at "all"
    assert.deepEqual(
      (await visibleStoryFiles(page)).sort(),
      ['checkout.json', 'home.json', 'settings.json'],
      'both all -> all 3 stories visible',
    );
    assert.equal(
      await statusText(page),
      'Showing all 3 stories',
      'both-all wording',
    );

    // (a) breakpoint alone hides non-matching containers, keeps stories that have a matching action
    await page.click('[data-breakpoint-filter="mobile"]');
    await page.waitForTimeout(200);
    assert.deepEqual(
      (await visibleStoryFiles(page)).sort(),
      ['checkout.json', 'home.json', 'settings.json'],
      '(a) bp=mobile alone keeps all 3 (each has a mobile action)',
    );
    assert.equal(
      await statusText(page),
      'Showing mobile 375: 3 stories',
      '(a) breakpoint-only wording',
    );
    const settingsDesktopHidden = await page.$$eval('.story', (stories) => {
      const settings = stories.find((s) =>
        (s.querySelector('.story-file')?.textContent || '').includes(
          'settings',
        ),
      );
      if (!settings) return null;
      const desktop = settings.querySelector('[data-breakpoint="desktop"]');
      return desktop ? (desktop as { hidden: boolean }).hidden : 'absent';
    });
    assert.equal(
      settingsDesktopHidden,
      true,
      '(a) settings desktop group hidden under bp=mobile',
    );

    // (b) intersection: status=changed + bp=mobile -> 0 stories, empty-state fires
    await page.click('[data-filter="changed"]');
    await page.waitForTimeout(200);
    assert.deepEqual(
      await visibleStoryFiles(page),
      [],
      '(b) changed+mobile -> 0 (settings changed action is desktop-only)',
    );
    assert.equal(
      await page.$eval(
        '.stories-empty',
        (e) => (e as { hidden: boolean }).hidden,
      ),
      false,
      '(b) empty-state revealed when intersection matches nothing',
    );
    assert.equal(
      await page.$eval('.stories', (e) => (e as { hidden: boolean }).hidden),
      true,
      '(b) list hidden when nothing matches',
    );
    assert.equal(
      await statusText(page),
      'Showing changed at mobile 375: 0 stories',
      '(b) both-active wording, plural 0',
    );

    // (c) restore breakpoint to all -> settings returns, empty-state re-hides
    await page.click('[data-breakpoint-filter="all"]');
    await page.waitForTimeout(200);
    assert.deepEqual(
      await visibleStoryFiles(page),
      ['settings.json'],
      '(c) changed + all-bp -> settings back',
    );
    assert.equal(
      await page.$eval(
        '.stories-empty',
        (e) => (e as { hidden: boolean }).hidden,
      ),
      true,
      '(c) empty-state re-hidden on restore',
    );
    assert.equal(
      await statusText(page),
      'Showing changed: 1 story',
      '(c) status-only wording, singular story',
    );

    // (d) positive intersection: status=changed + bp=desktop -> settings only
    await page.click('[data-breakpoint-filter="desktop"]');
    await page.waitForTimeout(200);
    assert.deepEqual(
      await visibleStoryFiles(page),
      ['settings.json'],
      '(d) changed+desktop -> settings (its changed action is desktop)',
    );
    assert.equal(
      await statusText(page),
      'Showing changed at desktop 1280: 1 story',
      '(d) both-active desktop wording, singular',
    );

    // (e) clearing both axes restores all
    await page.click('[data-filter="changed"]');
    await page.click('[data-breakpoint-filter="desktop"]');
    await page.waitForTimeout(200);
    assert.deepEqual(
      (await visibleStoryFiles(page)).sort(),
      ['checkout.json', 'home.json', 'settings.json'],
      '(e) clearing both axes restores all stories',
    );
    assert.equal(
      await statusText(page),
      'Showing all 3 stories',
      '(e) both-all wording after clear',
    );
  } finally {
    await browser.close();
  }
});
