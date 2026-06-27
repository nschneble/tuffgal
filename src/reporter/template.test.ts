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
    totals: { stories: 0, passed: 0, changed: 0, failed: 0, new: 0 },
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
    totals: { stories: 3, passed: 1, changed: 1, failed: 1, new: 0 },
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
    assert.ok(html.includes('value="new"'), 'new radio present');
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
      html.includes('<p class="stories-empty" hidden>No matching stories</p>'),
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
      html.includes(
        '<li class="summary-item">\n  <span class="count">3</span>',
      ),
      'stories total is 3',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="pass">\n  <span class="count">1</span>',
      ),
      'pass tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="changed">\n  <span class="count">1</span>',
      ),
      'changed tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="failed">\n  <span class="count">1</span>',
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
      totals: { stories: 1, passed: 0, changed: 1, failed: 0, new: 0 },
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
      html.includes('<span class="sr-only">toggle screenshots</span>'),
      'summary carries the sr-only "toggle screenshots" hint',
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
      totals: { stories: 1, passed: 0, changed: 0, failed: 1, new: 0 },
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

  it('renders new as a first-class tier: summary total, filter radio, story row', () => {
    const result = makeRunResult({
      totals: { stories: 1, passed: 0, changed: 0, failed: 0, new: 1 },
      stories: [
        makeStory({
          status: 'new',
          actions: [makeAction({ action: 'visit-home', status: 'new' })],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="new">\n  <span class="count">1</span>',
      ),
      'new tier total renders in the summary',
    );
    assert.match(
      html,
      /<input[^>]*value="new"[^>]*data-filter-name="new"/s,
      'a new filter radio renders',
    );
    assert.ok(
      html.includes('<li class="story" data-status="new">'),
      'the new story carries data-status="new" so the filter matches it',
    );
  });

  it('shows the mismatch reason in the diff-stats slot when a changed action has no diff', () => {
    // A dimension mismatch yields status:changed with a failureMessage but no
    // diffRatio/diffPath. Without a note the row reads as a "changed" with an
    // empty stats slot and no diff tab — an unexplained no-op. The recorded
    // reason must fill the slot the "% differs" stat normally occupies.
    const result = makeRunResult({
      totals: { stories: 1, passed: 0, changed: 1, failed: 0, new: 0 },
      stories: [
        makeStory({
          status: 'changed',
          actions: [
            makeAction({
              action: 'visit-settings',
              status: 'changed',
              failureMessage:
                'Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
              actualPath: '/fake/report/dir/shots/settings.actual.png',
              baselinePath: '/fake/report/dir/shots/settings.baseline.png',
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes('diff-stats--unavailable'),
      'the unavailable note variant renders',
    );
    assert.ok(
      html.includes(
        'No pixel diff. Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
      ),
      'the recorded mismatch reason fills the diff-stats slot',
    );
    assert.ok(
      !html.includes('differs</span>'),
      'no "% differs" stat renders when there is no diffRatio',
    );
  });

  it('emits no box-drawing branch glyphs (the CSS trunk line replaces them)', () => {
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0, new: 0 },
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
      totals: { stories: 1, passed: 1, changed: 0, failed: 0, new: 0 },
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

describe('renderStoryActions — per-breakpoint grouping', () => {
  it('groups tagged actions under labelled regions with mode name + dimensions', () => {
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0, new: 0 },
      stories: [
        makeStory({
          status: 'pass',
          actions: [
            makeAction({
              action: 'visit-home',
              breakpoint: 'mobile',
              breakpointWidth: 375,
              breakpointHeight: 667,
            }),
            makeAction({
              action: 'visit-home',
              breakpoint: 'desktop',
              breakpointWidth: 1280,
              breakpointHeight: 800,
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    // Two breakpoint groups, one per mode, in first-seen (run-set) order.
    assert.equal(
      countOccurrences(html, '<div class="breakpoint-group">'),
      2,
      'one breakpoint-group div per distinct mode',
    );
    assert.ok(
      html.includes('<span class="breakpoint-name">mobile</span>'),
      'mobile mode name rendered',
    );
    assert.ok(
      html.includes('<span class="breakpoint-name">desktop</span>'),
      'desktop mode name rendered',
    );

    // Dimensions: decorative aria-hidden glyph span + sr-only longhand.
    assert.ok(
      html.includes(
        '<span class="breakpoint-dimensions" aria-hidden="true">375×667</span><span class="sr-only">375 by 667 pixels</span>',
      ),
      'mobile dimensions render as aria-hidden 375×667 + sr-only longhand',
    );
    assert.ok(
      html.includes(
        '<span class="breakpoint-dimensions" aria-hidden="true">1280×800</span><span class="sr-only">1280 by 800 pixels</span>',
      ),
      'desktop dimensions render as aria-hidden 1280×800 + sr-only longhand',
    );

    // The sr-only " actions" token rides inside the caption so the computed
    // name reads "<mode> <dims> actions" without "actions" being visible.
    assert.ok(
      html.includes('<span class="sr-only"> actions</span>'),
      'caption carries an sr-only " actions" token for the accessible name',
    );

    // First group's label id wires its action list via aria-labelledby.
    assert.ok(
      html.includes('<p class="breakpoint-label" id="s0-bp0-label">'),
      'first group caption carries the deterministic s0-bp0-label id',
    );
    assert.ok(
      html.includes('<ol class="actions" aria-labelledby="s0-bp0-label">'),
      'first group action list points aria-labelledby at its caption id',
    );
    assert.ok(
      html.includes('<p class="breakpoint-label" id="s0-bp1-label">'),
      'second group caption carries the s0-bp1-label id',
    );
    assert.ok(
      html.includes('<ol class="actions" aria-labelledby="s0-bp1-label">'),
      'second group action list points aria-labelledby at its caption id',
    );

    // The mobile action must be nested under the mobile (first) group, not the
    // desktop one: the mobile caption + its <ol> precede the desktop caption.
    const mobileLabelIndex = html.indexOf('id="s0-bp0-label"');
    const desktopLabelIndex = html.indexOf('id="s0-bp1-label"');
    assert.ok(
      mobileLabelIndex !== -1 && desktopLabelIndex !== -1,
      'both group captions present',
    );
    assert.ok(
      mobileLabelIndex < desktopLabelIndex,
      'mobile group precedes desktop group (first-seen / config order)',
    );

    // No legacy flat list and no aria-label="Actions" fallback when grouped.
    assert.ok(
      !html.includes('<ol class="actions" aria-label="Actions">'),
      'grouped render does not emit the legacy flat aria-label="Actions" list',
    );
  });

  it('renders a single-mode story as a flat list with no breakpoint chrome', () => {
    // The common default `desktop` project ran at one mode: no caption, no
    // group wrapper — just the historical flat list.
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0, new: 0 },
      stories: [
        makeStory({
          status: 'pass',
          actions: [
            makeAction({
              action: 'visit-home',
              breakpoint: 'desktop',
              breakpointWidth: 1280,
              breakpointHeight: 800,
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes('<ol class="actions" aria-label="Actions">'),
      'single-mode story renders the flat aria-label="Actions" list',
    );
    assert.ok(
      !html.includes('<div class="breakpoint-group">'),
      'no breakpoint-group wrapper for a single mode',
    );
    assert.ok(
      !html.includes('class="breakpoint-label"'),
      'no breakpoint caption for a single mode',
    );
  });

  it('labels a group with the recorded override dimensions', () => {
    // Two modes force grouping; the desktop group shows the recorded override
    // (1440×900), never a registry default for the name.
    const result = makeRunResult({
      totals: { stories: 1, passed: 1, changed: 0, failed: 0, new: 0 },
      stories: [
        makeStory({
          status: 'pass',
          actions: [
            makeAction({
              action: 'visit-home',
              breakpoint: 'mobile',
              breakpointWidth: 375,
              breakpointHeight: 667,
            }),
            makeAction({
              action: 'visit-home',
              breakpoint: 'desktop',
              breakpointWidth: 1440,
              breakpointHeight: 900,
            }),
          ],
        }),
      ],
    });
    const html = renderReport(result, REPORT_DIR);

    assert.ok(
      html.includes(
        '<span class="breakpoint-dimensions" aria-hidden="true">1440×900</span><span class="sr-only">1440 by 900 pixels</span>',
      ),
      'overridden desktop renders the recorded 1440×900',
    );
    assert.ok(
      !html.includes('1280×800'),
      'the registry default for the overridden mode does not leak into the label',
    );
  });
});

describe('renderScreenshots — interactive viewer (interactiveMode:true)', () => {
  function interactiveResult(actionOverrides: Partial<ActionResult> = {}) {
    return makeRunResult({
      totals: { stories: 1, passed: 0, changed: 1, failed: 0, new: 0 },
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
              ...actionOverrides,
            }),
          ],
        }),
      ],
    });
  }

  it('renders a single shared <img>, not the per-variant shot-panels', () => {
    const html = renderReport(interactiveResult(), REPORT_DIR, true);
    assert.equal(
      countOccurrences(html, 'class="shot-image"'),
      1,
      'exactly one shared interactive image renders',
    );
    assert.ok(
      !html.includes('class="shot-panel"'),
      'no per-variant shot-panel divs in interactive mode',
    );
    assert.ok(
      html.includes('<div class="shot-stage">'),
      'the shared image sits in a .shot-stage wrapper',
    );
  });

  it('renders one native radio group per action with available variants', () => {
    const html = renderReport(interactiveResult(), REPORT_DIR, true);
    assert.ok(
      html.includes('<fieldset class="shot-interactive"'),
      'interactive fieldset renders',
    );
    assert.ok(
      html.includes('name="s0-a0-shot"'),
      'radio group reuses the actionId-shot name',
    );
    assert.ok(html.includes('value="baseline"'), 'baseline radio present');
    assert.ok(html.includes('value="actual"'), 'actual radio present');
    assert.ok(
      html.includes('value="diff"'),
      'diff radio present when a diff image exists',
    );
    assert.match(
      html,
      /<input[^>]*value="actual"[^>]*checked/s,
      'actual is the default committed (checked) variant',
    );
  });

  it('omits the diff radio entirely when there is no diff image', () => {
    const html = renderReport(
      interactiveResult({
        diffPath: undefined,
        diffRatio: undefined,
        diffPixels: undefined,
      }),
      REPORT_DIR,
      true,
    );
    assert.ok(
      !html.includes('value="diff"'),
      'no diff radio when diffPath is absent (omitted, not disabled)',
    );
    assert.ok(
      !html.includes('data-src-diff'),
      'no diff data-src on the shared image when diffPath is absent',
    );
    assert.ok(
      !html.includes('aria-describedby="s0-a0-diff-stats"'),
      'no dangling aria-describedby to an unrendered diff-stats id',
    );
  });

  it('renders a stable, variant-neutral alt that never names a variant', () => {
    const html = renderReport(interactiveResult(), REPORT_DIR, true);
    assert.ok(
      html.includes('alt="Screenshot of visit-settings"'),
      'alt is the neutral "Screenshot of <action>" string',
    );
    assert.ok(
      !html.includes('actual screenshot from this run'),
      'no per-variant alt text leaks into interactive mode',
    );
  });

  it('renders the sr-only legend and the visible "Showing" caption', () => {
    const html = renderReport(interactiveResult(), REPORT_DIR, true);
    assert.ok(
      html.includes(
        '<legend class="sr-only">visit-settings screenshot</legend>',
      ),
      'sr-only legend names the action',
    );
    assert.ok(
      html.includes('class="shot-caption"'),
      'a visible caption renders',
    );
    assert.ok(
      html.includes(
        'Showing: <span class="shot-caption-variant">Actual</span>',
      ),
      'caption shows the committed variant (Actual by default)',
    );
  });

  it('moves the diff-stats association onto the diff radio control', () => {
    const html = renderReport(interactiveResult(), REPORT_DIR, true);
    assert.match(
      html,
      /value="diff"[^>]*aria-describedby="s0-a0-diff-stats"/s,
      'the diff radio (not the img) is described by the diff-stats',
    );
    assert.ok(
      html.includes('id="s0-a0-diff-stats"'),
      'the diff-stats element carries the referenced id',
    );
  });

  it('commits to baseline when this run captured no actual', () => {
    const html = renderReport(
      interactiveResult({
        actualPath: undefined,
        diffPath: undefined,
        diffRatio: undefined,
        diffPixels: undefined,
      }),
      REPORT_DIR,
      true,
    );
    assert.match(
      html,
      /<input[^>]*value="baseline"[^>]*checked/s,
      'baseline is the checked default when no actual was captured',
    );
    assert.ok(
      html.includes(
        'Showing: <span class="shot-caption-variant">Baseline</span>',
      ),
      'caption shows Baseline when committed to baseline',
    );
    const src = html.match(/class="shot-image"\s+src="([^"]+)"/s);
    assert.ok(src, 'the shared image carries a src');
    assert.ok(
      src[1].includes('settings.baseline.png'),
      'the shared image src is the (non-empty) baseline path',
    );
  });

  it('keeps interactiveMode:false byte-identical to the default render', () => {
    const result = interactiveResult();
    assert.equal(
      renderReport(result, REPORT_DIR, false),
      renderReport(result, REPORT_DIR),
      'explicit false equals the defaulted (absent) flag',
    );
    assert.notEqual(
      renderReport(result, REPORT_DIR, true),
      renderReport(result, REPORT_DIR, false),
      'interactive output differs from the radio-tab output',
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
    totals: { stories: 3, passed: 1, changed: 1, failed: 1, new: 0 },
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
        '<span class="story-marker" aria-hidden="true">✓</span>\n    <span class="sr-only">passed</span>',
      ),
      'pass story carries aria-hidden ✓ glyph followed by sr-only "passed"',
    );
  });

  it('emits the ~ marker + "changed" sr-only word for a changed story', () => {
    assert.ok(
      html.includes(
        '<span class="story-marker" aria-hidden="true">~</span>\n    <span class="sr-only">changed</span>',
      ),
      'changed story carries aria-hidden ~ glyph followed by sr-only "changed"',
    );
  });

  it('emits the ✕ marker + "failed" sr-only word for a failed story', () => {
    assert.ok(
      html.includes(
        '<span class="story-marker" aria-hidden="true">✕</span>\n    <span class="sr-only">failed</span>',
      ),
      'failed story carries aria-hidden ✕ glyph followed by sr-only "failed"',
    );
  });
});
