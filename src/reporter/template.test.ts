import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ActionResult, RunResult, StoryResult } from '../schema/result.ts';
import { renderReport } from './template.ts';

const REPORT_DIR = '/fake/report/dir';

function makeAction(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    action: 'visit-home',
    status: 'pass',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.100Z',
    durationMs: 100,
    ...overrides,
  };
}

function makeStory(overrides: Partial<StoryResult> = {}): StoryResult {
  return {
    story: 'home page renders',
    file: 'stories/home.story.json',
    status: 'pass',
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:00.100Z',
    durationMs: 100,
    actions: [makeAction()],
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startedAt: '2026-06-11T12:00:00.000Z',
    finishedAt: '2026-06-11T12:00:01.000Z',
    durationMs: 1000,
    totals: { stories: 0, passed: 0, changed: 0, failed: 0 },
    customCoverage: {
      screens: { total: 10, covered: 5, ratio: 0.5, missing: [] },
      flows: { total: 4, covered: 2, ratio: 0.5, missing: [] },
    },
    stories: [],
    ...overrides,
  };
}

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

describe('renderReport — mixed pass/changed/failed fixture', () => {
  const result = makeRunResult({
    totals: { stories: 3, passed: 1, changed: 1, failed: 1 },
    stories: [
      makeStory({
        story: 'home page renders',
        file: 'stories/home.story.json',
        status: 'pass',
        actions: [makeAction({ action: 'visit-home', status: 'pass' })],
      }),
      makeStory({
        story: 'settings page drifted',
        file: 'stories/settings.story.json',
        status: 'changed',
        actions: [makeAction({ action: 'visit-settings', status: 'changed' })],
      }),
      makeStory({
        story: 'checkout flow blew up',
        file: 'stories/checkout.story.json',
        status: 'failed',
        actions: [
          makeAction({
            action: 'click-buy',
            status: 'failed',
            failureMessage: 'oops <script>boom</script>',
          }),
        ],
      }),
    ],
  });
  const html = renderReport(result, REPORT_DIR);

  it('renders the stories toolbar with filter radios and bulk-toggle buttons', () => {
    assert.ok(
      html.includes('<fieldset class="story-filter">'),
      'story-filter fieldset present',
    );
    assert.ok(html.includes('value="all"'), 'all radio present');
    assert.ok(html.includes('value="pass"'), 'pass radio present');
    assert.ok(html.includes('value="changed"'), 'changed radio present');
    assert.ok(html.includes('value="failed"'), 'failed radio present');
    assert.match(
      html,
      /<input[^>]*value="all"[^>]*checked/s,
      'all radio is the default-checked radio',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="expand"',
      ),
      'expand-all bulk-toggle button present',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="collapse"',
      ),
      'collapse-all bulk-toggle button present',
    );
    assert.ok(
      html.includes(
        'data-bulk-toggle="expand">Expand all screenshots</button>',
      ),
      'expand button has filter-agnostic "Expand all screenshots" initial text',
    );
    assert.ok(
      html.includes(
        'data-bulk-toggle="collapse">Collapse all screenshots</button>',
      ),
      'collapse button has filter-agnostic "Collapse all screenshots" initial text',
    );
  });

  it('orders the toolbar DOM filters → status → bulk-toggle buttons', () => {
    const fieldsetIndex = html.indexOf('<fieldset class="story-filter">');
    const statusIndex = html.indexOf('<p class="story-filter-status"');
    const bulkToggleIndex = html.indexOf('<div class="story-bulk-toggle">');
    assert.ok(fieldsetIndex !== -1, 'filter fieldset present');
    assert.ok(statusIndex !== -1, 'status region present');
    assert.ok(bulkToggleIndex !== -1, 'bulk-toggle group present');
    assert.ok(
      fieldsetIndex < statusIndex && statusIndex < bulkToggleIndex,
      'reading order is filters, then status, then buttons (status sits between)',
    );
  });

  it('renders the live region with initial story count and empty-state placeholder', () => {
    assert.ok(
      html.includes(
        '<p class="story-filter-status" role="status" aria-live="polite">Showing all 3 stories.</p>',
      ),
      'live region carries default "Showing all 3 stories." text',
    );
    assert.ok(
      html.includes('<p class="stories-empty" hidden>no stories match</p>'),
      'empty-state paragraph present and hidden by default',
    );
  });

  it('renders one <li class="story"> per fixture story with matching data-status', () => {
    assert.equal(
      countOccurrences(html, '<li class="story"'),
      3,
      'three story list items',
    );
    assert.ok(
      html.includes('<li class="story" data-status="pass">'),
      'pass story has data-status="pass"',
    );
    assert.ok(
      html.includes('<li class="story" data-status="changed">'),
      'changed story has data-status="changed"',
    );
    assert.ok(
      html.includes('<li class="story" data-status="failed">'),
      'failed story has data-status="failed"',
    );
  });

  it('renders the summary section with per-tier totals matching the fixture', () => {
    assert.ok(
      html.includes('<section class="summary"'),
      'summary section present',
    );
    assert.ok(
      html.includes('<li class="summary-item"><span class="count">3</span>'),
      'stories total is 3',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="pass"><span class="count">1</span>',
      ),
      'pass tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="changed"><span class="count">1</span>',
      ),
      'changed tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="failed"><span class="count">1</span>',
      ),
      'failed tier total is 1',
    );
    assert.equal(
      countOccurrences(html, '<li class="summary-item coverage">'),
      2,
      'customCoverage renders one summary-item coverage <li> per metric (screens + flows)',
    );
  });

  it('renders the failure message with HTML escaped', () => {
    assert.ok(
      html.includes('oops &lt;script&gt;boom&lt;/script&gt;'),
      'failure message appears with <script> tags escaped',
    );
    assert.ok(
      !html.includes('<script>boom</script>'),
      'raw unescaped <script> tag must not leak through',
    );
  });
});

describe('renderReport — no-failures fixture', () => {
  const result = makeRunResult({
    totals: { stories: 2, passed: 1, changed: 1, failed: 0 },
    stories: [
      makeStory({
        file: 'stories/home.story.json',
        status: 'pass',
        actions: [makeAction({ status: 'pass' })],
      }),
      makeStory({
        file: 'stories/settings.story.json',
        status: 'changed',
        actions: [makeAction({ status: 'changed' })],
      }),
    ],
  });
  const html = renderReport(result, REPORT_DIR);

  it('renders the failures section empty-state when no actions failed', () => {
    assert.ok(
      html.includes('<p class="prose-block empty">(none)</p>'),
      'failures section shows (none) placeholder',
    );
  });
});
