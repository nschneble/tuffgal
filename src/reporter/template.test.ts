// Pin the timezone before any Date is constructed so formatDate's local-time
// rendering (hour/meridiem) is deterministic on any CI runner. renderReport
// derives the friendly meta timestamp from finishedAt via formatDate.
process.env.TZ = 'UTC';

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
      html.includes('data-bulk-toggle="expand">Expand all</button>'),
      'expand button has filter-agnostic "Expand all" initial text',
    );
    assert.ok(
      html.includes('data-bulk-toggle="collapse">Collapse all</button>'),
      'collapse button has filter-agnostic "Collapse all" initial text',
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
        '<p class="story-filter-status" role="status" aria-live="polite">Showing all 3 stories</p>',
      ),
      'live region carries default "Showing all 3 stories" text',
    );
    assert.ok(
      html.includes(
        '<p class="bulk-toggle-status sr-only" role="status" aria-live="polite"></p>',
      ),
      'separate bulk-toggle live region present',
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

  it('renders the inline action-error message with HTML escaped', () => {
    assert.ok(
      html.includes(
        '<pre class="action-error">oops &lt;script&gt;boom&lt;/script&gt;</pre>',
      ),
      'failed action error appears inline with <script> tags escaped',
    );
    assert.ok(
      !html.includes('<script>boom</script>'),
      'raw unescaped <script> tag must not leak through',
    );
  });
});

describe('renderAction — whole row as screenshot disclosure', () => {
  it('wraps a shot-bearing action in <details class="shots"> with the full row as <summary class="action-row">', () => {
    const result = makeRunResult({
      totals: { stories: 1, passed: 0, changed: 1, failed: 0 },
      stories: [
        makeStory({
          status: 'changed',
          actions: [
            makeAction({
              action: 'visit-settings',
              status: 'changed',
              actualPath: '/fake/report/dir/shots/settings.actual.png',
              baselinePath: '/fake/report/dir/shots/settings.baseline.png',
              diffPath: '/fake/report/dir/shots/settings.diff.png',
              diffPixels: 1234,
              diffRatio: 0.012,
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes('<details class="shots">'),
      'shot-bearing action renders a <details class="shots"> disclosure (class preserved for report.js bulk toggle)',
    );
    assert.ok(
      html.includes('<summary class="action-row">'),
      'the full action row is the <summary class="action-row"> trigger, not a plain <div>',
    );
    assert.ok(
      html.includes('<span class="sr-only"> — toggle screenshots</span>'),
      'summary carries the sr-only " — toggle screenshots" hint',
    );
    // The old tiny "[view]" disclosure is gone entirely.
    assert.ok(
      !html.includes('>view<'),
      'the old "[view]" summary text is removed',
    );

    // The radiogroup + panels must remain inside the details so report.js
    // setupShots (container.parentElement.querySelectorAll('.shot-panel'))
    // and the bulk toggle (details.shots / panel.open) keep resolving.
    const detailsStart = html.indexOf('<details class="shots">');
    const detailsEnd = html.indexOf('</details>', detailsStart);
    assert.ok(
      detailsStart !== -1 && detailsEnd !== -1,
      'details open/close tags present',
    );
    const detailsInner = html.slice(detailsStart, detailsEnd);
    assert.ok(
      detailsInner.includes('class="shot-radio"'),
      '.shot-radio fieldset renders inside the <details class="shots">',
    );
    assert.ok(
      detailsInner.includes('class="shot-panel"'),
      '.shot-panel divs render inside the <details class="shots">',
    );
  });

  it('places the action-error block as a sibling AFTER the closing </details> for a failed shot-bearing action', () => {
    // A failed action that ALSO has screenshots renders both a
    // <details class="shots"> disclosure and a <pre class="action-error">.
    // renderAction emits parameters/errorBlock OUTSIDE the disclosure, so the
    // error must be a sibling after </details>, never nested inside it (a
    // nested error would hide behind the collapsed disclosure).
    const result = makeRunResult({
      totals: { stories: 1, passed: 0, changed: 0, failed: 1 },
      stories: [
        makeStory({
          status: 'failed',
          actions: [
            makeAction({
              action: 'click-buy',
              status: 'failed',
              failureMessage: 'snapshot mismatch',
              actualPath: '/fake/report/dir/shots/buy.actual.png',
              baselinePath: '/fake/report/dir/shots/buy.baseline.png',
              diffPath: '/fake/report/dir/shots/buy.diff.png',
              diffPixels: 42,
              diffRatio: 0.004,
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    const detailsClose = html.indexOf('</details>');
    const errorOpen = html.indexOf('class="action-error"');
    assert.ok(detailsClose !== -1, 'a <details> disclosure renders');
    assert.ok(errorOpen !== -1, 'the action-error block renders');
    assert.ok(
      detailsClose < errorOpen,
      'action-error is a sibling AFTER </details>, not nested inside the disclosure',
    );
  });

  it('emits no box-drawing branch glyphs (the CSS trunk line replaces them)', () => {
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0 },
      stories: [
        makeStory({
          status: 'pass',
          actions: [makeAction(), makeAction({ action: 'second' })],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(!html.includes('class="branch"'), 'no .branch span is emitted');
    assert.ok(!html.includes('├─'), 'no mid branch glyph');
    assert.ok(!html.includes('└─'), 'no last branch glyph');
  });

  it('renders a screenshot-less action as a plain <div class="action-row"> with no <details>', () => {
    // The default makeAction fixture has no actualPath/baselinePath.
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0 },
      stories: [makeStory({ status: 'pass', actions: [makeAction()] })],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes('<div class="action-row">'),
      'shot-less action renders a plain <div class="action-row">',
    );
    assert.ok(
      !html.includes('<details class="shots">'),
      'shot-less action does not emit a <details> disclosure',
    );
    assert.ok(
      !html.includes('<summary class="action-row">'),
      'shot-less action does not emit a <summary>',
    );
  });
});

describe('formatDate — friendly report-meta timestamp', () => {
  // formatDate is module-private; assert through renderReport's rendered output
  // (the friendly text appears in the <title> and the report-meta <time>). TZ is
  // pinned to UTC at the top of the file so these are stable across runners.
  function friendlyFor(finishedAt: string): string {
    return renderReport(makeRunResult({ finishedAt }), REPORT_DIR);
  }

  it('renders a known ISO as month name, non-leading-zero hour, padded minute, lowercase pm', () => {
    const html = friendlyFor('2026-06-19T13:58:00.000Z');
    assert.ok(
      html.includes('June 19, 1:58pm'),
      'afternoon timestamp renders as "June 19, 1:58pm"',
    );
  });

  it('renders midnight (T00:0x) as 12:0Xam', () => {
    const html = friendlyFor('2026-06-19T00:05:00.000Z');
    assert.ok(
      html.includes('June 19, 12:05am'),
      'midnight renders the 12-hour clock as "12:05am"',
    );
  });

  it('renders noon (T12:00) as 12:00pm', () => {
    const html = friendlyFor('2026-06-19T12:00:00.000Z');
    assert.ok(
      html.includes('June 19, 12:00pm'),
      'noon renders the 12-hour clock as "12:00pm"',
    );
  });

  it('zero-pads a single-digit minute', () => {
    const html = friendlyFor('2026-06-19T09:03:00.000Z');
    assert.ok(
      html.includes('June 19, 9:03am'),
      'single-digit minute is zero-padded to "9:03am"',
    );
  });
});

describe('renderStory — status marker + sr-only word per tier', () => {
  const result = makeRunResult({
    totals: { stories: 3, passed: 1, changed: 1, failed: 1 },
    stories: [
      makeStory({ status: 'pass' }),
      makeStory({ status: 'changed' }),
      makeStory({ status: 'failed' }),
    ],
  });
  const html = renderReport(result, REPORT_DIR);

  it('emits the ✓ marker + "passed" sr-only word for a pass story', () => {
    assert.ok(
      html.includes(
        '<span class="story-marker" aria-hidden="true">✓</span><span class="sr-only">passed</span>',
      ),
      'pass story carries aria-hidden ✓ glyph followed by sr-only "passed"',
    );
  });

  it('emits the ~ marker + "changed" sr-only word for a changed story', () => {
    assert.ok(
      html.includes(
        '<span class="story-marker" aria-hidden="true">~</span><span class="sr-only">changed</span>',
      ),
      'changed story carries aria-hidden ~ glyph followed by sr-only "changed"',
    );
  });

  it('emits the ✕ marker + "failed" sr-only word for a failed story', () => {
    assert.ok(
      html.includes(
        '<span class="story-marker" aria-hidden="true">✕</span><span class="sr-only">failed</span>',
      ),
      'failed story carries aria-hidden ✕ glyph followed by sr-only "failed"',
    );
  });
});
