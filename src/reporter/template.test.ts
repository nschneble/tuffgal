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
    totals: {
      stories: 0,
      passed: 0,
      changed: 0,
      failed: 0,
      new: 0,
      deleted: 0,
    },
    customCoverage: {
      screens: { total: 10, covered: 5, ratio: 0.5, missing: [] },
      flows: { total: 4, covered: 2, ratio: 0.5, missing: [] },
    },
    deleted: [],
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

describe('renderReport: mixed pass/changed/failed fixture', () => {
  const result = makeRunResult({
    totals: {
      stories: 3,
      passed: 1,
      changed: 1,
      failed: 1,
      new: 0,
      deleted: 0,
    },
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

  it('renders each status total as a single-select aria-pressed filter button', () => {
    assert.ok(
      !html.includes('<fieldset class="story-filter">'),
      'the old radio filter fieldset is gone',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="summary-filter" data-filter="all" aria-pressed="true" aria-controls="stories-list" aria-describedby="summary-count-all">',
      ),
      'the stories total is the default-pressed "show all" filter button',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="summary-filter" data-filter="pass" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-pass">',
      ),
      'passed total is an unpressed filter button keyed to the pass token',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="summary-filter" data-filter="new" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-new">',
      ),
      'new filter button present',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="summary-filter" data-filter="changed" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-changed">',
      ),
      'changed filter button present',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="summary-filter" data-filter="failed" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-failed">',
      ),
      'failed filter button present',
    );
    // Exactly one button is pressed by default: the "all" total.
    assert.equal(
      countOccurrences(html, 'aria-pressed="true"'),
      1,
      'exactly one filter button is pressed at load',
    );
  });

  it('puts the count outside the button as an aria-describedby sibling and composes the name from the word + sr-only suffix', () => {
    assert.ok(
      html.includes(
        '<span class="count" id="summary-count-all">3</span><button type="button" class="summary-filter" data-filter="all" aria-pressed="true" aria-controls="stories-list" aria-describedby="summary-count-all"><span class="indicator label">stories</span><span class="sr-only">, show all stories</span></button>',
      ),
      'count "3" precedes the button as a described-by sibling; button name is "stories, show all stories"',
    );
    assert.ok(
      html.includes(
        '<span class="count" id="summary-count-pass">1</span><button type="button" class="summary-filter" data-filter="pass" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-pass"><span class="indicator label">passed</span><span class="sr-only">, show only passed stories</span></button>',
      ),
      'count "1" precedes the passed button; button name is "passed, show only passed stories"',
    );
    // Never an aria-label on the filter buttons (would drop the visible word).
    assert.ok(
      !/class="summary-filter"[^>]*aria-label/.test(html),
      'filter buttons never carry an aria-label',
    );
  });

  it('keeps the bulk-toggle buttons as the last items in the summary row', () => {
    // Link-styled verbs: static "Expand"/"Collapse" with an sr-only scope so the
    // accessible name reads "Expand all screenshots" while the visible scope
    // (static "screenshots") is shared once and hidden from AT.
    assert.ok(
      html.includes(
        '<button type="button" class="story-bulk-toggle-button" data-bulk-toggle="expand"><span class="bulk-verb">Expand</span><span class="bulk-scope-sr sr-only"> all screenshots</span></button>',
      ),
      'expand verb present with sr-only scope for a composed accessible name',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="story-bulk-toggle-button" data-bulk-toggle="collapse"><span class="bulk-verb">Collapse</span><span class="bulk-scope-sr sr-only"> all screenshots</span></button>',
      ),
      'collapse verb present with sr-only scope for a composed accessible name',
    );
    assert.ok(
      html.includes(
        '<span class="bulk-scope" aria-hidden="true">screenshots</span>',
      ),
      'shared static visible scope word present and hidden from AT',
    );
    assert.ok(
      html.includes('<span class="bulk-sep" aria-hidden="true">/</span>'),
      'decorative separator present and hidden from AT',
    );
    // Bulk-toggle group comes AFTER every filter button in the summary list.
    const lastFilterIndex = html.lastIndexOf('class="summary-filter"');
    const bulkIndex = html.indexOf('<li class="story-bulk-toggle">');
    assert.ok(lastFilterIndex !== -1, 'filter buttons present');
    assert.ok(bulkIndex !== -1, 'bulk-toggle list item present');
    assert.ok(
      lastFilterIndex < bulkIndex,
      'the bulk-toggle pair sits after the filters (last in DOM order)',
    );
  });

  it('relocates both live regions into the stories section between the heading and the list', () => {
    assert.ok(
      html.includes(
        '<p class="story-filter-status" role="status" aria-live="polite" aria-atomic="true">Showing all 3 stories</p>',
      ),
      'filter status region carries default text + aria-atomic',
    );
    assert.ok(
      html.includes(
        '<p class="bulk-toggle-status sr-only" role="status" aria-live="polite" aria-atomic="true"></p>',
      ),
      'separate sr-only bulk-toggle region present with aria-atomic',
    );
    // Both regions are server-rendered between the stories <h2> and the <ol>.
    const headingIndex = html.indexOf('<h2 id="stories-heading">stories</h2>');
    const filterStatusIndex = html.indexOf('<p class="story-filter-status"');
    const bulkStatusIndex = html.indexOf('<p class="bulk-toggle-status');
    const listIndex = html.indexOf('<ol class="stories" id="stories-list"');
    assert.ok(
      headingIndex !== -1 && listIndex !== -1,
      'stories heading and list present',
    );
    assert.ok(
      headingIndex < filterStatusIndex &&
        filterStatusIndex < bulkStatusIndex &&
        bulkStatusIndex < listIndex,
      'order is heading → filter status → bulk status → list',
    );
    assert.ok(
      html.includes('<p class="stories-empty" hidden>No matching stories</p>'),
      'empty-state paragraph present and hidden by default',
    );
    // The old toolbar wrapper is gone entirely.
    assert.ok(
      !html.includes('class="stories-toolbar"'),
      'the .stories-toolbar wrapper is removed',
    );
  });

  it('renders one <li class="story"> per fixture story with matching data-status', () => {
    assert.equal(
      countOccurrences(html, '<li class="story"'),
      3,
      'three story list items',
    );
    assert.ok(
      html.includes('<li class="story" data-status="pass"'),
      'pass story has data-status="pass"',
    );
    assert.ok(
      html.includes('<li class="story" data-status="changed"'),
      'changed story has data-status="changed"',
    );
    assert.ok(
      html.includes('<li class="story" data-status="failed"'),
      'failed story has data-status="failed"',
    );
  });

  it('gives each story a deep-link anchor keyed to its results.stories index, plus a script focus target', () => {
    // The CI comment builds `#story-<i>` links off the same results.json story
    // ordinal, so each story <li> must carry `id="story-<index>"` in order.
    for (let index = 0; index < 3; index += 1) {
      assert.ok(
        html.includes(`id="story-${index}" tabindex="-1"`),
        `story ${index} has id="story-${index}" and a -1 focus target`,
      );
    }
  });

  it('renders the summary section with per-tier totals matching the fixture', () => {
    assert.ok(
      html.includes('<section class="summary"'),
      'summary section present',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="all">\n  <span class="count" id="summary-count-all">3</span>',
      ),
      'stories total is 3',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="pass">\n  <span class="count" id="summary-count-pass">1</span>',
      ),
      'pass tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="changed">\n  <span class="count" id="summary-count-changed">1</span>',
      ),
      'changed tier total is 1',
    );
    assert.ok(
      html.includes(
        '<li class="summary-item" data-status="failed">\n  <span class="count" id="summary-count-failed">1</span>',
      ),
      'failed tier total is 1',
    );
    // The screens/flows coverage stats were dropped entirely. (`.coverage-detail`
    // is intentionally NOT asserted here; it is also reused by the diff-stats
    // pixel-count markup, so its presence/absence is unrelated to this change.)
    assert.ok(
      !html.includes('summary-item coverage'),
      'no coverage stat items render in the summary row',
    );
    assert.ok(
      !/ (?:screens|flows) covered</.test(html),
      'no coverage sr-only "<n> of <m> screens/flows covered" text leaks',
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

describe('renderAction: whole row as screenshot disclosure', () => {
  it('wraps a shot-bearing action in <details class="shots"> with the full row as <summary class="action-row">', () => {
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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
      totals: {
        stories: 1,
        passed: 0,
        changed: 0,
        failed: 1,
        new: 0,
        deleted: 0,
      },
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

  it('renders new as a first-class tier: summary total, filter button, story row', () => {
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 0,
        failed: 0,
        new: 1,
        deleted: 0,
      },
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
        '<li class="summary-item" data-status="new">\n  <span class="count" id="summary-count-new">1</span><button type="button" class="summary-filter" data-filter="new" aria-pressed="false" aria-controls="stories-list" aria-describedby="summary-count-new">',
      ),
      'new tier total renders as a filter button in the summary',
    );
    assert.ok(
      html.includes('<span class="indicator label">new</span>'),
      'the new filter button carries its visible "new" label',
    );
    assert.ok(
      html.includes('<li class="story" data-status="new"'),
      'the new story carries data-status="new" so the filter matches it',
    );
  });

  it('renders the mismatch reason as one accessible clause from the structured pair', () => {
    // A dimension mismatch yields status:changed with a failureMessage but no
    // diffRatio/diffPath. Without a note the row reads as a "changed" with an
    // empty stats slot and no diff tab; an unexplained no-op. The recorded
    // reason must fill the slot the "% differs" stat normally occupies; folded
    // into ONE sentence, each dimension pair rendered in the split idiom (× glyph
    // for sight, spoken "W by H pixels" for AT), read from the structured
    // sizeMismatch pair rather than parsed from the message.
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
      stories: [
        makeStory({
          status: 'changed',
          actions: [
            makeAction({
              action: 'visit-settings',
              status: 'changed',
              failureMessage:
                'Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
              sizeMismatch: {
                baseline: { width: 1280, height: 800 },
                actual: { width: 1280, height: 2500 },
              },
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
        'No pixel diff. Screenshot resized from <span class="breakpoint-dimensions" aria-hidden="true">1280×800</span><span class="sr-only">1280 by 800 pixels</span> to <span class="breakpoint-dimensions" aria-hidden="true">1280×2500</span><span class="sr-only">1280 by 2500 pixels</span>.',
      ),
      'the note is one clause with both dimension pairs in the split idiom',
    );
    assert.ok(
      html.includes('1280 by 800 pixels') &&
        html.includes('1280 by 2500 pixels'),
      'AT hears the spoken longhand for both baseline and actual, never a bare x',
    );
    assert.ok(
      !html.includes('1280x800') && !html.includes('1280x2500'),
      'no raw "x"-delimited dimensions leak into the rendered note',
    );
    assert.ok(
      !html.includes('differs</span>'),
      'no "% differs" stat renders when there is no diffRatio',
    );
  });

  it('falls back to the escaped failureMessage when the structured pair is absent', () => {
    // Older or malformed results may carry failureMessage without a structured
    // sizeMismatch pair. A wrong parse is worse than the old prose, so the note
    // degrades to the escaped message rather than guess dimensions.
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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
      'the unavailable note variant still renders on the fallback path',
    );
    assert.ok(
      html.includes(
        'No pixel diff. Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
      ),
      'the recorded prose message fills the slot when no structured pair exists',
    );
    assert.ok(
      !html.includes('breakpoint-dimensions'),
      'no split-idiom markup is fabricated without a structured pair',
    );
  });

  it('emits no box-drawing branch glyphs (the CSS trunk line replaces them)', () => {
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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

describe('renderStoryActions: per-breakpoint grouping', () => {
  it('groups tagged actions under labelled regions with mode name + dimensions', () => {
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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

    // Two breakpoint groups, one per mode, in first-seen (run-set) order. Each
    // group div now also carries an additive data-breakpoint filter hook, so
    // count the class attribute rather than the bare closing tag.
    assert.equal(
      countOccurrences(html, '<div class="breakpoint-group" data-breakpoint='),
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
    // group wrapper; just the historical flat list.
    const result = makeRunResult({
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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
      html.includes(
        '<ol class="actions" aria-label="Actions" data-breakpoint="desktop">',
      ),
      'single-mode story renders the flat aria-label="Actions" list (with its additive data-breakpoint hook)',
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
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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

describe('renderScreenshots: interactive viewer (interactiveMode:true)', () => {
  function interactiveResult(actionOverrides: Partial<ActionResult> = {}) {
    return makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
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

  it('collapses to an image-only baseline when this run captured no actual', () => {
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
    // A single real variant offers no choice; the switcher fieldset and its lone
    // radio collapse away, leaving just the committed image (the baseline here).
    assert.ok(
      !html.includes('class="shot-interactive"'),
      'no radio switcher renders when only one variant is real',
    );
    assert.ok(
      !html.includes('class="shot-caption"'),
      'no "Showing" caption renders without a switcher',
    );
    const src = html.match(/class="shot-image"\s+src="([^"]+)"/s)?.[1];
    assert.ok(src, 'the shared image carries a src');
    assert.ok(
      src.includes('settings.baseline.png'),
      'the shared image src is the (non-empty) baseline path',
    );
  });

  it('suppresses the redundant baseline for a new row, collapsing to actual-only', () => {
    // A `new` baseline is written from this run's actual, so its baselinePath
    // points at a byte-identical copy. Surfacing it as a switchable variant
    // implies a comparison that does not exist; suppress it. With no diff
    // either, only `actual` remains, so the switcher collapses to image-only.
    const newRow = interactiveResult({
      status: 'new',
      diffPath: undefined,
      diffRatio: undefined,
      diffPixels: undefined,
    });
    const html = renderReport(newRow, REPORT_DIR, true);
    assert.ok(
      !html.includes('class="shot-interactive"'),
      'no switcher renders once the redundant baseline is suppressed',
    );
    assert.ok(
      !html.includes('data-src-baseline'),
      'the suppressed baseline is not wired as a preview source',
    );
    const src = html.match(/class="shot-image"\s+src="([^"]+)"/s)?.[1];
    assert.ok(src, 'the shared image carries a src');
    assert.ok(
      src.includes('settings.actual.png'),
      'the committed image is the actual capture, not the redundant baseline',
    );
  });

  it('drops the baseline radio + panel for a new row in the radio-tab render', () => {
    const newRow = interactiveResult({
      status: 'new',
      diffPath: undefined,
      diffRatio: undefined,
      diffPixels: undefined,
    });
    const html = renderReport(newRow, REPORT_DIR, false);
    assert.ok(
      !/value="baseline"/.test(html),
      'no baseline radio renders for a new row',
    );
    assert.ok(
      !html.includes('baseline screenshot'),
      'no baseline panel renders for a new row',
    );
    assert.ok(
      html.includes('settings.actual.png'),
      'the actual capture still renders',
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

describe('renderScreenshots: interactiveMode dimension-mismatch fallback', () => {
  // A baseline/actual dimension mismatch yields status:changed + failureMessage
  // but no diffRatio/diffPath: the diff is uncomputable, and press-flipping two
  // differently-sized captures would misalign everything. interactiveMode must
  // fall back to the radio-tab render (baseline + actual panels, disabled diff
  // carrying the reason).
  function mismatchResult(actionOverrides: Partial<ActionResult> = {}) {
    return makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
      stories: [
        makeStory({
          status: 'changed',
          actions: [
            makeAction({
              action: 'visit-settings',
              status: 'changed',
              actualPath: '/fake/report/dir/shots/settings.actual.png',
              baselinePath: '/fake/report/dir/shots/settings.baseline.png',
              failureMessage:
                'Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
              sizeMismatch: {
                baseline: { width: 1280, height: 800 },
                actual: { width: 1280, height: 2500 },
              },
              ...actionOverrides,
            }),
          ],
        }),
      ],
    });
  }

  it('falls back to the radio-tab fieldset, not the interactive viewer', () => {
    const html = renderReport(mismatchResult(), REPORT_DIR, true);
    assert.ok(
      html.includes('<fieldset class="shot-radio"'),
      'the radio-tab fieldset renders for an uncomputable diff in interactiveMode',
    );
    assert.ok(
      !html.includes('class="shot-interactive"'),
      'the interactive press-and-hold viewer does not render for a dimension mismatch',
    );
    // Both real variants render as radios → the full fieldset, not the collapsed
    // lone-image path (soleVariant.length === 2).
    assert.ok(html.includes('value="baseline"'), 'baseline radio renders');
    assert.ok(html.includes('value="actual"'), 'actual radio renders');
  });

  it('wires the disabled diff radio aria-describedby to the unavailable note', () => {
    const html = renderReport(mismatchResult(), REPORT_DIR, true);
    assert.ok(
      html.includes('diff-stats--unavailable'),
      'the unavailable note renders inside the fieldset',
    );
    assert.ok(
      html.includes('id="s0-a0-diff-stats"'),
      'the unavailable note carries the referenced id',
    );
    assert.match(
      html,
      /value="diff"[^>]*aria-describedby="s0-a0-diff-stats"/s,
      'the disabled diff radio is described by the unavailable note so AT hears the reason',
    );
    assert.match(
      html,
      /value="diff"[^>]*\bdisabled\b/s,
      'the diff radio is disabled when the mismatch leaves no diff image',
    );
  });

  it('still uses the interactive viewer when the diff is computable', () => {
    const html = renderReport(
      mismatchResult({
        failureMessage: undefined,
        diffPath: '/fake/report/dir/shots/settings.diff.png',
        diffPixels: 1234,
        diffRatio: 0.012,
      }),
      REPORT_DIR,
      true,
    );
    assert.ok(
      html.includes('class="shot-interactive"'),
      'a normal changed action still uses the interactive viewer',
    );
    assert.ok(
      !html.includes('<fieldset class="shot-radio"'),
      'no radio-tab fallback when the diff is computable',
    );
  });
});

describe('formatDate: friendly report-meta timestamp', () => {
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

describe('renderEnvMismatch: capture-environment banner', () => {
  it('renders no banner when environment is absent', () => {
    const html = renderReport(makeRunResult(), REPORT_DIR);
    assert.ok(
      !html.includes('class="env-mismatch"'),
      'no banner without an environment block',
    );
  });

  it('renders no banner when environment.mismatch is false', () => {
    const html = renderReport(
      makeRunResult({
        environment: {
          expected: null,
          actual: {} as never,
          mismatch: false,
          mismatchKeys: [],
        },
      }),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('class="env-mismatch"'),
      'no banner when mismatch is false, even with an environment block',
    );
  });

  it('renders the banner as the first child of <main>, above the summary, with role=alert and an h2', () => {
    const html = renderReport(
      makeRunResult({
        environment: {
          expected: null,
          actual: {} as never,
          mismatch: true,
          mismatchKeys: ['browserVersion', 'os'],
        },
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<section class="env-mismatch" role="alert" aria-labelledby="env-mismatch-heading">',
      ),
      'banner is a role=alert section labelled by its heading',
    );
    assert.ok(
      html.includes(
        '<h2 id="env-mismatch-heading">capture environment changed</h2>',
      ),
      'banner carries its h2 landmark',
    );
    // First inside <main>: before the summary section.
    const mainIndex = html.indexOf('<main id="main"');
    const bannerIndex = html.indexOf('class="env-mismatch"');
    const summaryIndex = html.indexOf('<section class="summary"');
    assert.ok(
      mainIndex < bannerIndex && bannerIndex < summaryIndex,
      'banner sits inside <main> and before the summary',
    );
  });

  it('lists the diverging keys as escaped <code> list items', () => {
    const html = renderReport(
      makeRunResult({
        environment: {
          expected: null,
          actual: {} as never,
          mismatch: true,
          mismatchKeys: ['browserVersion', 'deviceScaleFactor'],
        },
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('<ul aria-label="Changed environment keys">'),
      'diverging keys render as a labelled list',
    );
    assert.ok(
      html.includes('<li><code>browserVersion</code></li>'),
      'first diverging key rendered',
    );
    assert.ok(
      html.includes('<li><code>deviceScaleFactor</code></li>'),
      'second diverging key rendered',
    );
    assert.ok(
      html.includes(
        'Expect a full re-approve. Baselines were captured under a different environment.',
      ),
      'banner body conveys the re-approve consequence',
    );
  });

  it('uses the manifest-sentinel copy with no key list when mismatchKeys is exactly [manifest]', () => {
    const html = renderReport(
      makeRunResult({
        environment: {
          expected: null,
          actual: {} as never,
          mismatch: true,
          mismatchKeys: ['manifest'],
        },
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        "The committed baseline manifest could not be read, so the capture environment can't be verified. Expect a full re-approve.",
      ),
      'manifest sentinel uses the unreadable-manifest copy',
    );
    assert.ok(
      !html.includes('<ul aria-label="Changed environment keys">'),
      'no key list renders for the manifest sentinel',
    );
    assert.ok(
      !html.includes('<li><code>manifest</code></li>'),
      'the literal "manifest" sentinel is never surfaced as a key',
    );
  });

  it('escapes a malicious environment key', () => {
    const html = renderReport(
      makeRunResult({
        environment: {
          expected: null,
          actual: {} as never,
          mismatch: true,
          mismatchKeys: ['<script>boom</script>'],
        },
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('<li><code>&lt;script&gt;boom&lt;/script&gt;</code></li>'),
      'a diverging key is HTML-escaped',
    );
    assert.ok(
      !html.includes('<script>boom</script>'),
      'no raw script tag leaks from a key',
    );
  });
});

describe('renderDeleted: orphaned-baseline section', () => {
  it('renders no section when deleted is empty', () => {
    const html = renderReport(makeRunResult({ deleted: [] }), REPORT_DIR);
    assert.ok(
      !html.includes('class="deleted"'),
      'no deleted section when nothing is orphaned',
    );
  });

  it('renders a peer h2 section after the stories with a prune intro and a labelled list', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 0,
          passed: 0,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 1,
        },
        deleted: [
          {
            action: 'visit-retired',
            breakpoint: 'mobile',
            baselinePaths: ['/base/visit-retired/mobile.png'],
          },
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<section class="deleted" aria-labelledby="deleted-heading">',
      ),
      'deleted section labelled by its heading',
    );
    assert.ok(
      html.includes('<h2 id="deleted-heading">deleted</h2>'),
      'lowercase single-word heading matching the summary/stories convention',
    );
    assert.ok(
      html.includes(
        'These committed baselines have no matching story this run. <code>tuffgal approve --prune</code> removes them.',
      ),
      'intro names the prune command as a code token',
    );
    assert.ok(
      html.includes(
        '<ul aria-label="Orphaned baselines to be pruned on approve">',
      ),
      'orphan list carries its accessible label',
    );
    assert.ok(
      html.includes('<li><code>visit-retired</code> mobile</li>'),
      'orphan entry names the action as code plus its plain breakpoint',
    );
    // Deleted section comes after the stories section.
    const storiesIndex = html.indexOf('<h2 id="stories-heading">stories</h2>');
    const deletedIndex = html.indexOf('<h2 id="deleted-heading">deleted</h2>');
    assert.ok(
      storiesIndex !== -1 && deletedIndex !== -1 && storiesIndex < deletedIndex,
      'deleted heading follows the stories heading in reading order',
    );
  });

  it('adds an sr-only clarifier for a legacy breakpoint and escapes the action', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 0,
          passed: 0,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 1,
        },
        deleted: [
          {
            action: '<b>old</b>',
            breakpoint: 'legacy',
            baselinePaths: ['/base/old/0.png'],
          },
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<li><code>&lt;b&gt;old&lt;/b&gt;</code> legacy<span class="sr-only"> (pre-breakpoint layout)</span></li>',
      ),
      'legacy breakpoint reads "legacy" visibly with an sr-only clarifier; action is escaped',
    );
  });
});

describe('renderActionNotes: candidate + a11y-drift notes', () => {
  function actionResult(actionOverrides: Partial<ActionResult>) {
    return makeRunResult({
      totals: {
        stories: 1,
        passed: 0,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
      stories: [
        makeStory({
          status: 'changed',
          actions: [makeAction(actionOverrides)],
        }),
      ],
    });
  }

  it('renders the candidate note on a changed action', () => {
    const html = renderReport(
      actionResult({ action: 'visit-settings', status: 'changed' }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        `<p class="candidate-note" role="note">This run's actual screenshot is the proposed new baseline.</p>`,
      ),
      'changed action carries the candidate note',
    );
  });

  it('renders the candidate note on a new action', () => {
    const html = renderReport(
      actionResult({ action: 'visit-home', status: 'new' }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('class="candidate-note"'),
      'new action carries the candidate note',
    );
  });

  it('renders NO candidate note on pass, failed, or skipped actions', () => {
    for (const status of ['pass', 'failed', 'skipped'] as const) {
      const html = renderReport(
        actionResult({ action: 'visit-home', status }),
        REPORT_DIR,
      );
      assert.ok(
        !html.includes('class="candidate-note"'),
        `no candidate note for a ${status} action`,
      );
    }
  });

  it('renders the a11y-drift note (with relativized path) when a11yChanged is true', () => {
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        a11yChanged: true,
        a11yBaselinePath:
          '/fake/report/dir/base/visit-settings/mobile.a11y.yaml',
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<p class="a11y-drift-note" role="note">Accessibility snapshot changed. Proposed a11y baseline written to <code>base/visit-settings/mobile.a11y.yaml</code>.</p>',
      ),
      'a11y-drift note renders the report-relative baseline path as plain code text',
    );
    assert.ok(
      !/a11y-drift-note[^>]*>[^<]*<a /.test(html),
      'the a11y baseline path is plain text, never a link',
    );
  });

  it('renders the a11y-drift note without a path clause when a11yBaselinePath is undefined', () => {
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        a11yChanged: true,
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<p class="a11y-drift-note" role="note">Accessibility snapshot changed.</p>',
      ),
      'a11y-drift note degrades gracefully with no path clause',
    );
  });

  it('does NOT render the a11y-drift note for a changed row that lacks a11yChanged (size-mismatch discriminator)', () => {
    // A size-mismatch changed row has no diffPath AND no a11yChanged. Keying the
    // note on !diffPath would misfire here; it must key strictly on a11yChanged.
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        failureMessage:
          'Screenshot dimensions changed: baseline 1280x800, actual 1280x2500',
        actualPath: '/fake/report/dir/shots/settings.actual.png',
        baselinePath: '/fake/report/dir/shots/settings.baseline.png',
      }),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('class="a11y-drift-note"'),
      'no a11y-drift note on a size-mismatch changed row (no a11yChanged)',
    );
    assert.ok(
      html.includes('class="candidate-note"'),
      'the size-mismatch changed row still carries the candidate note',
    );
  });

  it('does NOT render the a11y-drift note for a pixel-drift changed row with a diff but no a11yChanged', () => {
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        actualPath: '/fake/report/dir/shots/settings.actual.png',
        baselinePath: '/fake/report/dir/shots/settings.baseline.png',
        diffPath: '/fake/report/dir/shots/settings.diff.png',
        diffPixels: 1234,
        diffRatio: 0.012,
      }),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('class="a11y-drift-note"'),
      'an SSIM-fail changed row with a diff but no a11yChanged shows no a11y-drift note',
    );
  });

  it('renders NO candidate note on an a11y-only changed row', () => {
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        a11yChanged: true,
        a11yBaselinePath: '/fake/report/dir/base/visit-settings/0.a11y.yaml',
      }),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('class="candidate-note"'),
      'the pixels matched, so no screenshot is proposed as a new baseline',
    );
    assert.ok(
      html.includes('class="a11y-drift-note"'),
      'the a11y-drift note carries what actually moved',
    );
  });

  it('stacks candidate note before a11y-drift note when pixels drifted too', () => {
    const html = renderReport(
      actionResult({
        action: 'visit-settings',
        status: 'changed',
        diffPath: '/fake/report/dir/diff/visit-settings.png',
        a11yChanged: true,
        a11yBaselinePath: '/fake/report/dir/base/visit-settings/0.a11y.yaml',
      }),
      REPORT_DIR,
    );
    const candidateIndex = html.indexOf('class="candidate-note"');
    const a11yIndex = html.indexOf('class="a11y-drift-note"');
    assert.ok(
      candidateIndex !== -1 && a11yIndex !== -1,
      'both notes render when a row drifted in pixels AND in the tree',
    );
    assert.ok(
      candidateIndex < a11yIndex,
      'candidate note precedes the a11y-drift note',
    );
  });
});

describe('renderA11yDiff: the a11y-only changed row', () => {
  function a11yOnlyReport(actionOverrides: Partial<ActionResult> = {}): string {
    return renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 0,
          changed: 1,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            status: 'changed',
            actions: [
              makeAction({
                action: 'visit-settings',
                status: 'changed',
                baselinePath: '/fake/report/dir/base/visit-settings/0.png',
                actualPath: '/fake/report/dir/actual/visit-settings/0.png',
                diffPixels: 0,
                diffRatio: 0,
                ssimScore: 1,
                a11yChanged: true,
                a11yBaselinePath:
                  '/fake/report/dir/base/visit-settings/0.a11y.yaml',
                a11yDiff: {
                  lines: [
                    ' - navigation:',
                    '-  - link "Home"',
                    '+  - link "Home page"',
                  ],
                  added: 1,
                  removed: 1,
                  truncated: false,
                },
                ...actionOverrides,
              }),
            ],
          }),
        ],
      }),
      REPORT_DIR,
    );
  }

  it('renders the diff in place of the screenshot viewer', () => {
    const html = a11yOnlyReport();
    assert.ok(html.includes('class="a11y-diff"'), 'the diff block renders');
    assert.ok(
      !html.includes('class="shot-radio"') && !html.includes('class="shot-'),
      'no screenshot variants, radios, or panels on an a11y-only row',
    );
    assert.ok(
      !html.includes('differs'),
      'no 0% pixel-diff stat on a row whose pixels matched',
    );
    assert.ok(
      html.includes('toggle accessibility diff'),
      'the collapsible names what it holds',
    );
  });

  it('marks each changed line for sight and for assistive tech', () => {
    const html = a11yOnlyReport();
    assert.ok(
      html.includes(
        '<span class="a11y-diff-line a11y-diff-line--remove"><span class="sr-only">Removed: </span><span aria-hidden="true">-</span>  - link &quot;Home&quot;</span>',
      ),
      'a removed line carries the marker glyph, a spoken word, and the escaped text',
    );
    assert.ok(
      html.includes(
        '<span class="a11y-diff-line a11y-diff-line--add"><span class="sr-only">Added: </span><span aria-hidden="true">+</span>  - link &quot;Home page&quot;</span>',
      ),
      'an added line does the same',
    );
    assert.ok(
      html.includes('<span class="a11y-diff-line"> - navigation:</span>'),
      'an unchanged context line is announced as neither',
    );
  });

  it('names and focuses the scrollable diff block', () => {
    const html = a11yOnlyReport();
    assert.ok(
      html.includes(
        '<pre class="a11y-diff" tabindex="0" role="group" aria-label="Accessibility snapshot diff for visit-settings">',
      ),
      'the horizontally scrollable block is a named tab stop',
    );
  });

  it('flags a clipped diff with the full counts', () => {
    const html = a11yOnlyReport({
      a11yDiff: {
        lines: [' - navigation:', '-  - link "Home"'],
        added: 12,
        removed: 9,
        truncated: true,
      },
    });
    assert.ok(
      html.includes('Diff clipped. 12 added, 9 removed in full.'),
      'the clipped render still states the real size',
    );
  });

  it('degrades to prose when the result carries no diff', () => {
    const html = a11yOnlyReport({ a11yDiff: undefined });
    assert.ok(
      html.includes('No line diff recorded for this run.'),
      'an older results.json still explains the row',
    );
    assert.ok(!html.includes('<pre class="a11y-diff"'), 'no empty diff block');
  });

  it('reports counts when the snapshots were too large to diff', () => {
    const html = a11yOnlyReport({
      a11yDiff: { lines: [], added: 2100, removed: 2100, truncated: true },
    });
    assert.ok(
      html.includes('No line diff available: 2100 added, 2100 removed.'),
      'the coarse fallback still names the size of the change',
    );
  });

  it('keeps the screenshot viewer when pixels drifted too', () => {
    const html = a11yOnlyReport({
      diffPath: '/fake/report/dir/diff/visit-settings.png',
      diffRatio: 0.04,
      diffPixels: 1200,
    });
    assert.ok(
      !html.includes('class="a11y-diff"'),
      'a pixel-drifted row keeps the overlay, which is the thing worth seeing',
    );
    assert.ok(html.includes('differs'), 'and keeps its diff stat');
  });

  it('keeps the screenshot viewer on a size-mismatch row (no a11yChanged)', () => {
    const html = a11yOnlyReport({
      a11yChanged: undefined,
      a11yDiff: undefined,
      diffRatio: undefined,
      failureMessage: 'Screenshot size changed from 1280x800 to 1280x1200',
      sizeMismatch: {
        baseline: { width: 1280, height: 800 },
        actual: { width: 1280, height: 1200 },
      },
    });
    assert.ok(
      !html.includes('class="a11y-diff"'),
      'the a11y-only branch keys on a11yChanged, never on a missing diffPath',
    );
  });
});

describe('renderBreakpointFilters: the breakpoint filter dimension', () => {
  // A run spanning two distinct breakpoints across its stories: mobile 375×667
  // and desktop 1280×800. The filter group renders once, from the distinct
  // breakpoints in first-seen order.
  function multiBreakpointResult() {
    return makeRunResult({
      totals: {
        stories: 2,
        passed: 1,
        changed: 1,
        failed: 0,
        new: 0,
        deleted: 0,
      },
      stories: [
        makeStory({
          story: 'home page renders',
          file: 'stories/home.story.json',
          status: 'pass',
          actions: [
            makeAction({
              action: 'visit-home',
              status: 'pass',
              breakpoint: 'mobile',
              breakpointWidth: 375,
              breakpointHeight: 667,
            }),
            makeAction({
              action: 'visit-home',
              status: 'pass',
              breakpoint: 'desktop',
              breakpointWidth: 1280,
              breakpointHeight: 800,
            }),
          ],
        }),
        makeStory({
          story: 'settings drifted',
          file: 'stories/settings.story.json',
          status: 'changed',
          actions: [
            makeAction({
              action: 'visit-settings',
              status: 'changed',
              breakpoint: 'desktop',
              breakpointWidth: 1280,
              breakpointHeight: 800,
            }),
          ],
        }),
      ],
    });
  }

  it('renders the role=group filter with a default-pressed "all breakpoints" reset', () => {
    const html = renderReport(multiBreakpointResult(), REPORT_DIR);
    assert.ok(
      html.includes(
        '<div class="breakpoint-filters" role="group" aria-label="Filter by breakpoint">',
      ),
      'breakpoint filter group is a role=group with an accessible label',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="breakpoint-filter" data-breakpoint-filter="all" aria-pressed="true" aria-controls="stories-list">',
      ),
      'the "all breakpoints" reset is pressed by default and controls the list',
    );
    assert.ok(
      html.includes(
        '<span class="indicator label">all breakpoints</span><span class="sr-only">, show results at every breakpoint</span>',
      ),
      'reset carries its visible label + sr-only action suffix',
    );
    // The breakpoint group lives inside the summary section, below the totals.
    const summaryOpen = html.indexOf('<section class="summary"');
    const groupIndex = html.indexOf('class="breakpoint-filters"');
    const summaryClose = html.indexOf('</section>', summaryOpen);
    assert.ok(
      summaryOpen < groupIndex && groupIndex < summaryClose,
      'the breakpoint filter group renders inside the summary section',
    );
    // It is a sibling of the totals <ul>, NOT nested inside it.
    const ulClose = html.indexOf('</ul>', summaryOpen);
    assert.ok(
      ulClose < groupIndex,
      'the breakpoint group is a sibling AFTER the totals <ul>, not nested in it',
    );
  });

  it('renders one unpressed pill per distinct breakpoint in first-seen order, token distinct from label', () => {
    const html = renderReport(multiBreakpointResult(), REPORT_DIR);
    // Exactly two breakpoint pills (mobile, desktop) plus the "all" reset.
    assert.equal(
      countOccurrences(html, 'class="breakpoint-filter"'),
      3,
      'three breakpoint filter buttons: all + mobile + desktop',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="breakpoint-filter" data-breakpoint-filter="mobile" aria-pressed="false" aria-controls="stories-list">',
      ),
      'mobile pill carries the mobile matcher token, unpressed',
    );
    assert.ok(
      html.includes(
        '<button type="button" class="breakpoint-filter" data-breakpoint-filter="desktop" aria-pressed="false" aria-controls="stories-list">',
      ),
      'desktop pill carries the desktop matcher token, unpressed',
    );
    // The visible LABEL carries the breakpoint name; the TOKEN drives matching.
    assert.ok(
      html.includes('<span class="breakpoint-name">mobile</span>'),
      'mobile pill shows the human name in .breakpoint-name',
    );
    // First-seen order: mobile (first action) precedes desktop.
    const mobileIndex = html.indexOf('data-breakpoint-filter="mobile"');
    const desktopIndex = html.indexOf('data-breakpoint-filter="desktop"');
    assert.ok(
      mobileIndex !== -1 && desktopIndex !== -1 && mobileIndex < desktopIndex,
      'pills render in first-seen order (mobile before desktop)',
    );
    // Exactly one pressed pill in the group at load (the reset).
    const groupStart = html.indexOf('class="breakpoint-filters"');
    const groupEnd = html.indexOf('</div>', groupStart);
    const group = html.slice(groupStart, groupEnd);
    assert.equal(
      countOccurrences(group, 'aria-pressed="true"'),
      1,
      'exactly one breakpoint pill is pressed at load (the reset)',
    );
    // Never an aria-label on the pills (would drop the visible name).
    assert.ok(
      !/class="breakpoint-filter"[^>]*aria-label/.test(html),
      'breakpoint pills never carry an aria-label',
    );
  });

  it('reuses the dimensions idiom: decorative aria-hidden glyph + sr-only longhand', () => {
    const html = renderReport(multiBreakpointResult(), REPORT_DIR);
    assert.ok(
      html.includes(
        '<span class="breakpoint-dimensions" aria-hidden="true">375×667</span><span class="sr-only"> 375 by 667 pixels</span>',
      ),
      'mobile pill dimensions render as aria-hidden 375×667 + sr-only longhand',
    );
    assert.ok(
      html.includes(
        '<span class="breakpoint-dimensions" aria-hidden="true">1280×800</span><span class="sr-only"> 1280 by 800 pixels</span>',
      ),
      'desktop pill dimensions render as aria-hidden 1280×800 + sr-only longhand',
    );
  });

  it('renders NO breakpoint filter group for a single-breakpoint run (<= 1 distinct)', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 1,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            status: 'pass',
            actions: [
              makeAction({
                breakpoint: 'desktop',
                breakpointWidth: 1280,
                breakpointHeight: 800,
              }),
            ],
          }),
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('class="breakpoint-filters"'),
      'no breakpoint filter group when the run spans a single breakpoint',
    );
    assert.ok(
      !html.includes('data-breakpoint-filter'),
      'no breakpoint filter buttons render for a single-breakpoint run',
    );
  });

  it('renders NO breakpoint filter group when there are no stories', () => {
    const html = renderReport(makeRunResult(), REPORT_DIR);
    assert.ok(
      !html.includes('class="breakpoint-filters"'),
      'no breakpoint filter group for an empty run',
    );
  });

  it('renders the legacy pill (name + sr-only clarifier) for a blank-breakpoint bucket', () => {
    // One story tagged desktop, one carrying no breakpoint (the defensive
    // parse-guard bucket) → two distinct buckets → the filter renders, and the
    // blank bucket reads as the reserved "legacy" token/label.
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 2,
          passed: 2,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            file: 'stories/tagged.story.json',
            status: 'pass',
            actions: [
              makeAction({
                breakpoint: 'desktop',
                breakpointWidth: 1280,
                breakpointHeight: 800,
              }),
            ],
          }),
          makeStory({
            file: 'stories/untagged.story.json',
            status: 'pass',
            actions: [makeAction()],
          }),
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('data-breakpoint-filter="legacy"'),
      'the blank bucket maps to the reserved "legacy" matcher token',
    );
    assert.ok(
      html.includes(
        '<span class="breakpoint-name">legacy<span class="sr-only"> (pre-breakpoint layout)</span></span>',
      ),
      'the legacy pill reads "legacy" with the shared pre-breakpoint clarifier',
    );
  });
});

describe('data-breakpoint hooks: every action under exactly one container', () => {
  it('adds data-breakpoint to each breakpoint-group div in a multi-mode story', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 1,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            status: 'pass',
            actions: [
              makeAction({
                breakpoint: 'mobile',
                breakpointWidth: 375,
                breakpointHeight: 667,
              }),
              makeAction({
                breakpoint: 'desktop',
                breakpointWidth: 1280,
                breakpointHeight: 800,
              }),
            ],
          }),
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('<div class="breakpoint-group" data-breakpoint="mobile">'),
      'mobile group carries data-breakpoint="mobile"',
    );
    assert.ok(
      html.includes('<div class="breakpoint-group" data-breakpoint="desktop">'),
      'desktop group carries data-breakpoint="desktop"',
    );
  });

  it('adds data-breakpoint to the flat <ol> of a single-mode story (no visible chrome)', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 1,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            status: 'pass',
            actions: [
              makeAction({
                breakpoint: 'desktop',
                breakpointWidth: 1280,
                breakpointHeight: 800,
              }),
            ],
          }),
        ],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<ol class="actions" aria-label="Actions" data-breakpoint="desktop">',
      ),
      'the flat single-mode list carries data-breakpoint but keeps its aria-label',
    );
    // No visible breakpoint chrome is added to a single-mode story.
    assert.ok(
      !html.includes('class="breakpoint-group"'),
      'single-mode story still renders no breakpoint-group chrome',
    );
    assert.ok(
      !html.includes('class="breakpoint-label"'),
      'single-mode story still renders no breakpoint caption',
    );
  });

  it('maps a blank-breakpoint flat list to data-breakpoint="legacy"', () => {
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 1,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [makeStory({ status: 'pass', actions: [makeAction()] })],
      }),
      REPORT_DIR,
    );
    assert.ok(
      html.includes('data-breakpoint="legacy"'),
      'the blank-bucket flat list hooks onto the reserved legacy token',
    );
    assert.ok(
      !html.includes('data-breakpoint=""'),
      'the hook is never emitted as an empty string',
    );
  });

  it('never leaves an action outside a [data-breakpoint] container (multi-mode)', () => {
    // Selector invariant: the count of data-breakpoint containers equals the
    // number of distinct modes, and each <ol class="actions"> is either the
    // hooked flat list or nested under a hooked group div; so every action row
    // has exactly one [data-breakpoint] ancestor-or-self.
    const html = renderReport(
      makeRunResult({
        totals: {
          stories: 1,
          passed: 1,
          changed: 0,
          failed: 0,
          new: 0,
          deleted: 0,
        },
        stories: [
          makeStory({
            status: 'pass',
            actions: [
              makeAction({
                action: 'a',
                breakpoint: 'mobile',
                breakpointWidth: 375,
                breakpointHeight: 667,
              }),
              makeAction({
                action: 'b',
                breakpoint: 'desktop',
                breakpointWidth: 1280,
                breakpointHeight: 800,
              }),
            ],
          }),
        ],
      }),
      REPORT_DIR,
    );
    // Two group divs, each hooked; no flat aria-label="Actions" list in
    // multi-mode, so the only action lists are the ones nested under a hooked
    // group.
    assert.equal(
      countOccurrences(html, 'data-breakpoint="mobile"'),
      1,
      'exactly one mobile container',
    );
    assert.equal(
      countOccurrences(html, 'data-breakpoint="desktop"'),
      1,
      'exactly one desktop container',
    );
    assert.ok(
      !html.includes('<ol class="actions" aria-label="Actions"'),
      'multi-mode never emits an un-hooked flat aria-label="Actions" list',
    );
  });
});

describe('renderStory: status marker + sr-only word per tier', () => {
  const result = makeRunResult({
    totals: {
      stories: 3,
      passed: 1,
      changed: 1,
      failed: 1,
      new: 0,
      deleted: 0,
    },
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

describe('renderDiffHistory: per-action diff-history trend', () => {
  function historyResult(history?: ActionResult['history']) {
    return makeRunResult({
      totals: {
        stories: 1,
        passed: 1,
        changed: 0,
        failed: 0,
        new: 0,
        deleted: 0,
      },
      stories: [
        makeStory({
          status: 'pass',
          actions: [
            makeAction({
              action: 'visit-home',
              status: 'pass',
              diffPixels: 3,
              diffRatio: 0.0004,
              actualPath: '/fake/report/dir/shots/home.actual.png',
              baselinePath: '/fake/report/dir/shots/home.baseline.png',
              history,
            }),
          ],
        }),
      ],
    });
  }

  it('renders nothing when the action carries no history', () => {
    const html = renderReport(historyResult(undefined), REPORT_DIR);
    assert.ok(
      !html.includes('diff-history'),
      'no history field means no diff-history markup at all',
    );
  });

  it('renders nothing for a single-entry history (nothing to trend)', () => {
    const html = renderReport(
      historyResult([
        {
          finishedAt: '2026-06-11T12:00:00.000Z',
          diffPixels: 3,
          diffRatio: 0.0004,
        },
      ]),
      REPORT_DIR,
    );
    assert.ok(
      !html.includes('diff-history'),
      'a lone entry duplicates the diff-stats line above with no trend',
    );
  });

  it('renders the joined percentages plus an sr-only run-count clarifier for 2+ entries', () => {
    const html = renderReport(
      historyResult([
        {
          finishedAt: '2026-06-09T12:00:00.000Z',
          diffPixels: 2,
          diffRatio: 0.0002,
        },
        {
          finishedAt: '2026-06-10T12:00:00.000Z',
          diffPixels: 5,
          diffRatio: 0.0005,
        },
        {
          finishedAt: '2026-06-11T12:00:00.000Z',
          diffPixels: 3,
          diffRatio: 0.0004,
        },
      ]),
      REPORT_DIR,
    );
    assert.ok(
      html.includes(
        '<p class="diff-history"><span class="label">history</span> 0.02% · 0.05% · 0.04%<span class="sr-only"> (3 runs, oldest to newest)</span></p>',
      ),
      'the trend line lists every entry, oldest to newest, plus the sr-only clarifier',
    );
  });

  it('renders the visible percentages as ordinary text, not inside an aria-hidden wrapper', () => {
    const html = renderReport(
      historyResult([
        {
          finishedAt: '2026-06-10T12:00:00.000Z',
          diffPixels: 2,
          diffRatio: 0.0002,
        },
        {
          finishedAt: '2026-06-11T12:00:00.000Z',
          diffPixels: 3,
          diffRatio: 0.0004,
        },
      ]),
      REPORT_DIR,
    );
    const historyLine = html
      .split('\n')
      .find((line) => line.includes('class="diff-history"'));
    assert.ok(historyLine, 'the diff-history line renders');
    assert.ok(
      !historyLine!.includes('aria-hidden="true">0.02%') &&
        !historyLine!.includes('aria-hidden="true">0.04%'),
      'the visible percentages are not wrapped in an aria-hidden span',
    );
  });
});
