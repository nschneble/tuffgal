import { relative } from 'node:path';
import type {
  ActionResult,
  ActionStatus,
  RunResult,
  StoryResult,
} from '../schema/result.ts';

const STATUS_LABELS: Record<ActionStatus, string> = {
  pass: 'passed',
  changed: 'changed',
  failed: 'failed',
  skipped: 'skipped',
  new: 'new baseline',
};

const STATUS_MARKERS: Record<ActionStatus, string> = {
  pass: '✓',
  changed: '~',
  failed: '✕',
  skipped: '–',
  new: '+',
};

/**
 * Static HTML report. Rocks a terminal, dev-tool aesthetic. Dark mode by
 * default, monospace font for data, sharp borders, and minimal but
 * evocative icons + neon colors to indicate statuses.
 */
export function renderReport(
  result: RunResult,
  reportDir: string,
  interactiveMode = false,
): string {
  const dateLabel = formatDate(result.finishedAt);
  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tuffgal report – ${dateLabel}</title>
    <link rel="stylesheet" href="assets/report.css" />
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to report</a>
    <header class="report-header">
      <h1>Tuffgal report</h1>
      <p class="report-meta">
        <time datetime="${result.finishedAt}">${dateLabel}</time>
        <span aria-hidden="true">·</span>
        <span aria-hidden="true">⏲</span> ${formatDuration(result.durationMs)}
      </p>
    </header>
    <main id="main" tabindex="-1">
      ${renderSummary(result)}
      ${renderStories(result, reportDir, interactiveMode)}
    </main>
    <script src="assets/report.js"></script>
  </body>
</html>
`;
}

/**
 * The status totals double as the report's filter controls: each is a native
 * `<button aria-pressed>` single-select filter, with the "stories" total acting
 * as the "show all / clear" control (pressed by default). The expand-all /
 * collapse-all pair sits at the right end of the same row — the slot the old
 * coverage stats used to occupy. The `<ul>` stays a plain list (no composite
 * role): a non-filter total and the bulk-toggle group share it, so a
 * radiogroup/fieldset could not cleanly scope just the filters.
 */
function renderSummary(result: RunResult): string {
  return `
<section class="summary" aria-labelledby="summary-heading">
  <h2 id="summary-heading">summary</h2>
  <ul class="summary-list" aria-label="Run totals">
    ${summaryFilter('stories', result.totals.stories, 'all', true, ' — show all stories')}
    ${summaryFilter('passed', result.totals.passed, 'pass', false, ', show only passed stories')}
    ${summaryFilter('new', result.totals.new, 'new', false, ', show only new stories')}
    ${summaryFilter('changed', result.totals.changed, 'changed', false, ', show only changed stories')}
    ${summaryFilter('failed', result.totals.failed, 'failed', false, ', show only failed stories')}
    <li class="story-bulk-toggle">
      <button type="button" class="story-bulk-toggle-button" data-bulk-toggle="expand"><span class="bulk-verb">Expand</span><span class="bulk-scope-sr sr-only"> all screenshots</span></button>
      <span class="bulk-sep" aria-hidden="true">/</span>
      <button type="button" class="story-bulk-toggle-button" data-bulk-toggle="collapse"><span class="bulk-verb">Collapse</span><span class="bulk-scope-sr sr-only"> all screenshots</span></button>
      <span class="bulk-scope" aria-hidden="true">screenshots</span>
    </li>
  </ul>
</section>
`;
}

/**
 * One status total rendered as a single-select filter button. The visible count
 * sits OUTSIDE the button as a sibling span and is wired to it via
 * aria-describedby, so only the word ("passed") is the underlined link while the
 * count still reads as the button's description. The accessible name is the
 * visible label plus a visually-hidden action suffix (e.g. ", show only passed
 * stories"), composed from contents so the visible text is never dropped (WCAG
 * 2.5.3 — never an aria-label). The `data-filter` token ("pass") is kept
 * distinct from the visible label ("passed") so report.js matches
 * `story[data-status="pass"]`.
 */
function summaryFilter(
  label: string,
  value: number,
  filter: 'all' | ActionStatus,
  pressed: boolean,
  actionSuffix: string,
): string {
  return `
<li class="summary-item" data-status="${filter}">
  <span class="count" id="summary-count-${filter}">${value}</span><button type="button" class="summary-filter" data-filter="${filter}" aria-pressed="${pressed}" aria-controls="stories-list" aria-describedby="summary-count-${filter}"><span class="indicator label">${label}</span><span class="sr-only">${actionSuffix}</span></button>
  <span class="bulk-sep" aria-hidden="true">·</span>
</li>
`;
}

function renderStories(
  result: RunResult,
  reportDir: string,
  interactiveMode: boolean,
): string {
  const items = result.stories
    .map((story, index) =>
      renderStory(story, index, reportDir, interactiveMode),
    )
    .join('\n');
  const total = result.stories.length;
  // The interactive controls now live in the summary row; this section keeps
  // only the two live regions (both server-rendered between the heading and the
  // list so a screen reader announces filter/bulk changes reliably) and the
  // list itself, whose id the summary filter buttons target via aria-controls.
  return `
<section aria-labelledby="stories-heading">
  <h2 id="stories-heading">stories</h2>
  <p class="story-filter-status" role="status" aria-live="polite" aria-atomic="true">Showing all ${total} stories</p>
  <p class="bulk-toggle-status sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
  <ol class="stories" id="stories-list" aria-label="Stories executed in dependency order">
    ${items}
  </ol>
  <p class="stories-empty" hidden>No matching stories</p>
</section>
`;
}

function renderStory(
  story: StoryResult,
  storyIndex: number,
  reportDir: string,
  interactiveMode: boolean,
): string {
  return `
<li class="story" data-status="${story.status}">
  <div class="story-row">
    <span class="story-marker" aria-hidden="true">${STATUS_MARKERS[story.status]}</span>
    <span class="sr-only">${STATUS_LABELS[story.status]}</span>
    <code class="story-file">${escapeHtml(story.file)}</code>
    <span class="story-duration">${formatDuration(story.durationMs)}</span>
  </div>
  <p class="story-prose">${escapeHtml(story.story)}</p>
  <br/>
  ${renderStoryActions(story, storyIndex, reportDir, interactiveMode)}
</li>
`;
}

/**
 * Renders a story's action results as one labelled group per breakpoint, in
 * first-seen order (which the runner emits in run-set order). Two shapes:
 *
 *   - Single mode: when the story ran at exactly one breakpoint (the common
 *     default `desktop` project), we render the historical flat
 *     `<ol class="actions">` with no per-mode caption — no breakpoint chrome
 *     when there is only one mode to show.
 *   - Multi mode: when the story ran at two or more breakpoints, we render one
 *     labelled group per mode so a reader sees results per mode instead of a
 *     flat interleaved list. An action with `screenshot:false` still appears
 *     once per breakpoint — it simply renders as a shot-less row in its mode's
 *     group, no special-casing needed.
 *
 * `actionId` is keyed by the action's index in the original flat array
 * (`s<story>-a<flatIndex>`), NOT a per-group counter, so radio `name`s and
 * shot-panel `id`s stay globally unique across groups and report.js's
 * `name="<actionId>-shot"` radio grouping never collides between modes.
 */
function renderStoryActions(
  story: StoryResult,
  storyIndex: number,
  reportDir: string,
  interactiveMode: boolean,
): string {
  // Bucket actions by breakpoint, preserving first-seen order.
  const order: string[] = [];
  const buckets = new Map<
    string,
    Array<{ action: ActionResult; id: string }>
  >();
  story.actions.forEach((action, actionIndex) => {
    const key = action.breakpoint ?? '';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push({ action, id: `s${storyIndex}-a${actionIndex}` });
  });

  // One mode (or untagged) → flat list, no caption. Captions only earn their
  // chrome when there is more than one mode to tell apart.
  if (order.length <= 1) {
    const actions = story.actions
      .map((action, actionIndex) =>
        renderAction(
          action,
          `s${storyIndex}-a${actionIndex}`,
          reportDir,
          interactiveMode,
        ),
      )
      .join('\n');
    return `<ol class="actions" aria-label="Actions">
    ${actions}
  </ol>`;
  }

  return order
    .map((key, groupIndex) =>
      renderBreakpointGroup(
        key,
        buckets.get(key)!,
        `s${storyIndex}-bp${groupIndex}`,
        reportDir,
        interactiveMode,
      ),
    )
    .join('\n');
}

/**
 * One labelled per-breakpoint subsection. The mode label carries the breakpoint
 * NAME and its DIMENSIONS — the real capture size recorded on the result, so
 * per-config and per-story overrides show their actual size. The label is a
 * non-heading caption: stories live inside an `<ol>` list, not a heading
 * outline, so injecting an `<h3>` here would orphan it under the story's
 * list-item subtree. Instead the action list is a labelled region — its
 * `<ol aria-labelledby>` points at the visible caption, so assistive tech
 * announces e.g. "mobile 375 by 667 pixels actions" without minting a heading
 * level. The trailing "actions" is an sr-only token inside the caption —
 * "actions" never appears in the visible label, only in the computed accessible
 * name, so the region reads as a list of actions rather than a bare dimension
 * string.
 *
 * Dimensions render in their own `aria-hidden` span (decorative "375×667")
 * with an sr-only longhand ("375 by 667 pixels") so screen readers don't read
 * the `×` glyph as "x" mid-stream.
 */
function renderBreakpointGroup(
  key: string,
  entries: Array<{ action: ActionResult; id: string }>,
  groupId: string,
  reportDir: string,
  interactiveMode: boolean,
): string {
  const labelId = `${groupId}-label`;
  const name = key;
  // The capture dimensions recorded on the result reflect per-config and
  // per-story overrides. A result always carries them post-migration; the guard
  // only keeps a malformed entry from emitting a half-empty dimension span.
  const recorded = entries[0]?.action;
  const dimensions =
    recorded?.breakpointWidth !== undefined &&
    recorded.breakpointHeight !== undefined
      ? { width: recorded.breakpointWidth, height: recorded.breakpointHeight }
      : undefined;
  const dimensionMarkup = dimensions
    ? `<span class="breakpoint-dimensions" aria-hidden="true">${dimensions.width}×${dimensions.height}</span><span class="sr-only">${dimensions.width} by ${dimensions.height} pixels</span>`
    : '';
  const actions = entries
    .map(({ action, id }) =>
      renderAction(action, id, reportDir, interactiveMode),
    )
    .join('\n');
  return `
<div class="breakpoint-group">
  <p class="breakpoint-label" id="${labelId}">
    <span class="breakpoint-name">${escapeHtml(name)}</span>
    ${dimensionMarkup}
    <span class="sr-only"> actions</span>
  </p>
  <ol class="actions" aria-labelledby="${labelId}">
    ${actions}
  </ol>
</div>
`;
}

function renderAction(
  action: ActionResult,
  actionId: string,
  reportDir: string,
  interactiveMode: boolean,
): string {
  const screenshots = renderScreenshots(
    action,
    actionId,
    reportDir,
    interactiveMode,
  );
  const errorBlock =
    action.status === 'failed'
      ? `<pre class="action-error">${escapeHtml(action.failureMessage ?? 'unknown error')}</pre>`
      : '';
  const parameters = renderParameters(action.parameters);

  const rowInner = `
${statusBadge(action.status)}
<code class="action-name">${escapeHtml(action.action)}</code>
<span class="action-duration">${formatDuration(action.durationMs)}</span>
`;

  const row = screenshots
    ? `
<details class="shots">
  <summary class="action-row">
    ${rowInner}
    <span class="sr-only">toggle screenshots</span>
  </summary>
  ${screenshots}
</details>`
    : `
<div class="action-row">
  ${rowInner}
</div>
`;

  return `
<li class="action" data-status="${action.status}">
  ${row}
  ${parameters}
  ${errorBlock}
</li>
`;
}

function renderParameters(
  parameters: Record<string, string> | undefined,
): string {
  if (!parameters || Object.keys(parameters).length === 0) {
    return '';
  }
  const entries = Object.entries(parameters)
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`,
    )
    .join('');
  return `<dl class="action-parameters">${entries}</dl>`;
}

/**
 * A "changed" row whose diff could not be computed: baseline and actual differ
 * in dimensions, so pixelmatch throws before producing a diffRatio or diff
 * image, leaving only the recorded failureMessage. Centralizes the predicate
 * shared by the radio fallback, the diff radio's describedby wiring, and
 * renderDiffStats' unavailable note.
 */
function isDiffUnavailable(action: ActionResult): boolean {
  return (
    action.diffRatio === undefined &&
    action.status === 'changed' &&
    !!action.failureMessage
  );
}

function renderScreenshots(
  action: ActionResult,
  actionId: string,
  reportDir: string,
  interactiveMode: boolean,
): string {
  if (!action.actualPath && !action.baselinePath) {
    return '';
  }
  // interactiveMode swaps the radio-tab output for the single-image hover/press
  // viewer. When it is false the function falls through to the radio-tab output
  // below, byte-identical with the pre-interactiveMode render.
  //
  // When the baseline and actual differ in dimensions the diff is uncomputable
  // (renderDiffStats' unavailable branch — both paths present, `changed` status,
  // a recorded failureMessage, no diffRatio). The hover/press gesture has no diff
  // image to reveal, so fall back to the radio-tab render: visible chips,
  // baseline + actual, and the disabled diff option carrying the mismatch reason.
  const diffUncomputable =
    action.baselinePath !== undefined &&
    action.actualPath !== undefined &&
    isDiffUnavailable(action);
  if (interactiveMode && !diffUncomputable) {
    return renderInteractiveScreenshots(action, actionId, reportDir);
  }
  // A `new` baseline writes its baseline straight from this run's actual, so the
  // two paths point at byte-identical PNGs. There is no prior state to compare
  // against, so suppress the baseline variant for display — like the diff, it is
  // not a real artifact here. The path stays in the data model for `approve`.
  const baseline =
    action.baselinePath && action.status !== 'new'
      ? toReportRelative(reportDir, action.baselinePath)
      : undefined;
  const actual = action.actualPath
    ? toReportRelative(reportDir, action.actualPath)
    : undefined;
  const diff = action.diffPath
    ? toReportRelative(reportDir, action.diffPath)
    : undefined;
  const defaultTab = 'actual';
  const available = { baseline, actual, diff };
  const initialTab =
    available[defaultTab] !== undefined
      ? defaultTab
      : (['baseline', 'actual', 'diff'] as const).find(
          (name) => available[name] !== undefined,
        );
  const diffStatsId = `${actionId}-diff-stats`;
  const diffStats = renderDiffStats(action, diffStatsId);
  // renderDiffStats emits the `diff-stats--unavailable` note (with this id) when
  // the diff is uncomputable. The diff radio is disabled in that case, so wire
  // its aria-describedby to the note — a keyboard/AT user reaching the disabled
  // diff option then hears why no diff exists. (The diff PANEL only takes the
  // association when a real diff image renders, below.)
  const diffNoteUnavailable = isDiffUnavailable(action);
  // When only one variant is real (the common case for a `new` baseline, whose
  // baseline is suppressed and has no diff), a radio group offering a single
  // choice is noise to AT. Drop the controls and show the image alone; the row's
  // status badge already announces "new baseline". Zero variants — a `new` row
  // whose actual capture is somehow missing — collapses to nothing.
  const soleVariant = (['baseline', 'actual', 'diff'] as const).filter(
    (name) => available[name] !== undefined,
  );
  if (soleVariant.length <= 1) {
    const only = soleVariant[0];
    if (only === undefined) {
      return '';
    }
    const lone = shotPanel(
      actionId,
      only,
      available[only],
      SHOT_ALT[only](action),
      true,
    );
    return `${diffStats}${lone}`;
  }
  return `
<fieldset class="shot-radio" data-default-tab="${defaultTab}">
  <legend class="sr-only">Screenshot to display</legend>
  ${shotRadio(actionId, 'baseline', baseline === undefined, initialTab === 'baseline')}
  ${shotRadio(actionId, 'actual', actual === undefined, initialTab === 'actual')}
  ${shotRadio(actionId, 'diff', diff === undefined, initialTab === 'diff', diffNoteUnavailable ? { describedById: diffStatsId } : undefined)}
  ${diffStats}
</fieldset>
${shotPanel(actionId, 'baseline', baseline, SHOT_ALT.baseline(action), initialTab === 'baseline')}
${shotPanel(actionId, 'actual', actual, SHOT_ALT.actual(action), initialTab === 'actual')}
${shotPanel(actionId, 'diff', diff, SHOT_ALT.diff(action), initialTab === 'diff', action.diffRatio !== undefined ? diffStatsId : undefined)}
`;
}

/** Alt text per screenshot variant, shared by the radio-tab and collapsed render. */
const SHOT_ALT: Record<
  'baseline' | 'actual' | 'diff',
  (action: ActionResult) => string
> = {
  baseline: (action) => `${action.action} baseline screenshot`,
  actual: (action) => `${action.action} actual screenshot from this run`,
  diff: (action) =>
    `Pixel diff overlay for ${action.action}; changed regions are highlighted`,
};

/**
 * The pixel-diff overlay only exists when baseline and actual share dimensions.
 * A mismatch (e.g. a fullPage capture whose document grew taller) throws before
 * a diff is computed, so `diffRatio` is absent and there is no diff image to
 * show — surface the recorded reason here, in the slot the "% differs" stat
 * would normally occupy, so a "changed" row never reads as an unexplained no-op.
 */
function renderDiffStats(action: ActionResult, diffStatsId: string): string {
  return action.diffRatio !== undefined
    ? `<p class="diff-stats" id="${diffStatsId}"><span class="count">${parseFloat((action.diffRatio * 100).toFixed(2))}%</span> <span class="label">differs</span> <span class="coverage-detail">· ${(action.diffPixels ?? 0).toLocaleString('en-US')} pixels</span></p>`
    : action.status === 'changed' && action.failureMessage
      ? `<p class="diff-stats diff-stats--unavailable" id="${diffStatsId}"><span class="label">No pixel diff. ${escapeHtml(action.failureMessage)}</span></p>`
      : '';
}

/**
 * Interactive screenshot viewer (interactiveMode). One native radio group per
 * action is the committed-state source of truth — keyboard, touch, and AT all
 * operate the radios (reusing `name="${actionId}-shot"`). report.js layers a
 * VISUAL-ONLY mouse preview (hover→baseline, press→diff, release→committed) on
 * a SINGLE shared `<img>`; that gesture never mutates radio state, the img alt,
 * or any ARIA. The controls + caption live OUTSIDE the clipped `.shot-stage` so
 * the focus ring is never clipped or painted over screenshot pixels. The diff
 * variant — and its radio — is omitted entirely (not disabled) when this action
 * produced no diff image; the existing diff-stats association then rides on the
 * diff radio control rather than the image, leaving no dangling describedby.
 * (Distinct from the dimension-mismatch case, where the diff is uncomputable:
 * renderScreenshots never reaches this viewer and instead falls back to the
 * radio-tab render with a disabled — not omitted — diff radio.)
 */
function renderInteractiveScreenshots(
  action: ActionResult,
  actionId: string,
  reportDir: string,
): string {
  // A `new` baseline writes its baseline straight from this run's actual, so the
  // two paths point at byte-identical PNGs. There is no prior state to compare
  // against, so suppress the baseline variant for display — like the diff, it is
  // omitted (no radio, no image). The path stays in the data model for `approve`.
  const baseline =
    action.baselinePath && action.status !== 'new'
      ? toReportRelative(reportDir, action.baselinePath)
      : undefined;
  const actual = action.actualPath
    ? toReportRelative(reportDir, action.actualPath)
    : undefined;
  const diff = action.diffPath
    ? toReportRelative(reportDir, action.diffPath)
    : undefined;

  // Default committed variant is `actual`; only a baseline-only row (no actual
  // capture this run) commits to baseline instead. renderScreenshots' guard
  // guarantees at least one of the two exists, so `committedSrc` is never empty
  // at runtime — the `?? ''` only satisfies the optional types.
  const committed: 'actual' | 'baseline' =
    actual !== undefined ? 'actual' : 'baseline';
  const committedSrc = (committed === 'actual' ? actual : baseline) ?? '';

  // When only one variant is real (the common case for a `new` baseline, whose
  // baseline is suppressed and has no diff), the hover/press switcher has nothing
  // to toggle to — a lone radio in a group is noise to AT. Render the image alone;
  // the row's status badge already announces "new baseline". Zero variants — a
  // `new` row whose actual capture is missing — collapses to nothing.
  const variantCount = [baseline, actual, diff].filter(
    (v) => v !== undefined,
  ).length;
  if (variantCount === 0) {
    return '';
  }
  if (variantCount === 1) {
    return `
<div class="shot-stage">
  <img
    class="shot-image"
    src="${escapeHtml(committedSrc)}"
    alt="${escapeHtml(`Screenshot of ${action.action}`)}"
    loading="lazy"
  />
</div>
`;
  }

  const diffStatsId = `${actionId}-diff-stats`;
  const diffStats = renderDiffStats(action, diffStatsId);

  const radios = [
    baseline !== undefined
      ? shotRadio(actionId, 'baseline', false, committed === 'baseline', {
          label: 'Baseline',
        })
      : '',
    actual !== undefined
      ? shotRadio(actionId, 'actual', false, committed === 'actual', {
          label: 'Actual',
        })
      : '',
    diff !== undefined
      ? shotRadio(actionId, 'diff', false, false, {
          label: 'Diff',
          describedById: diffStats !== '' ? diffStatsId : undefined,
        })
      : '',
  ].join('');

  const captionLabel = committed === 'actual' ? 'Actual' : 'Baseline';
  const dataSrc = [
    baseline !== undefined
      ? ` data-src-baseline="${escapeHtml(baseline)}"`
      : '',
    actual !== undefined ? ` data-src-actual="${escapeHtml(actual)}"` : '',
    diff !== undefined ? ` data-src-diff="${escapeHtml(diff)}"` : '',
  ].join('');

  return `
<fieldset class="shot-interactive">
  <legend class="sr-only">${escapeHtml(action.action)} screenshot</legend>
  ${radios}
  <p class="shot-caption" aria-hidden="true">Showing: <span class="shot-caption-variant">${captionLabel}</span></p>
  ${diffStats}
</fieldset>
<div class="shot-stage">
  <img
    class="shot-image"
    src="${escapeHtml(committedSrc)}"
    alt="${escapeHtml(`Screenshot of ${action.action}`)}"
    loading="lazy"
    ${dataSrc}
  />
</div>
`;
}

function shotRadio(
  actionId: string,
  name: string,
  disabled: boolean,
  checked: boolean,
  opts?: { label?: string; describedById?: string },
): string {
  const inputId = `${actionId}-radio-${name}`;
  const label = opts?.label ?? name;
  const describedBy = opts?.describedById
    ? ` aria-describedby="${opts.describedById}"`
    : '';
  return `
<label for="${inputId}" class="chip chip--toggle shot-radio-label">
  <input
    type="radio"
    name="${actionId}-shot"
    id="${inputId}"
    value="${name}"
    data-tab="${name}"${describedBy}
    ${disabled ? 'disabled' : ''}
    ${checked ? 'checked' : ''}
  />
  ${label}
</label>
`;
}

function shotPanel(
  actionId: string,
  name: string,
  src: string | undefined,
  alt: string,
  visible: boolean,
  describedById?: string,
): string {
  return `
<div
  class="shot-panel"
  id="panel-${actionId}-${name}"
  data-tab="${name}"
  ${visible ? '' : 'hidden'}
>
  ${
    src
      ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${describedById ? ` aria-describedby="${describedById}"` : ''} />`
      : `<p class="shot-missing">no ${name} screenshot for this action</p>`
  }
</div>
`;
}

function statusBadge(status: ActionStatus): string {
  return `
<span class="status" data-status="${status}">
  <span class="sr-only">${STATUS_LABELS[status]}</span>
  <span class="status-label" aria-hidden="true">${STATUS_LABELS[status]}</span>
</span>
`;
}

function toReportRelative(reportDir: string, absolute: string): string {
  return relative(reportDir, absolute);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatDate(iso: string): string {
  const date = new Date(iso);
  const month = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const hours24 = date.getHours();
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hours12}:${minutes}${meridiem}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
