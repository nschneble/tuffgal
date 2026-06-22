import { relative } from 'node:path';
import type {
  ActionResult,
  ActionStatus,
  CoverageMetric,
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
export function renderReport(result: RunResult, reportDir: string): string {
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
      ${renderStories(result, reportDir)}
    </main>
    <script src="assets/report.js"></script>
  </body>
</html>
`;
}

function renderSummary(result: RunResult): string {
  const screens = result.customCoverage.screens;
  const flows = result.customCoverage.flows;
  return `
<section class="summary" aria-labelledby="summary-heading">
  <h2 id="summary-heading">summary</h2>
  <ul class="summary-list" aria-label="Run totals">
    ${summaryItem('stories', result.totals.stories)}
    ${summaryItem('passed', result.totals.passed, 'pass')}
    ${summaryItem('changed', result.totals.changed, 'changed')}
    ${summaryItem('failed', result.totals.failed, 'failed')}
    ${coverageItem('screens', screens)}
    ${coverageItem('flows', flows)}
  </ul>
</section>
`;
}

function coverageItem(label: string, metric: CoverageMetric): string {
  const pct = `${(metric.ratio * 100).toFixed(0)}%`;
  return `
<li class="summary-item coverage">
  <span class="count">${pct}</span>
  <span class="label">${label}</span>
  <span class="coverage-detail" aria-hidden="true">· ${metric.covered}/${metric.total}</span>
  <span class="sr-only">${metric.covered} of ${metric.total} ${label} covered</span>
</li>
`;
}

function summaryItem(
  label: string,
  value: number,
  statusKey?: ActionStatus,
): string {
  return `
<li class="summary-item"${statusKey ? ` data-status="${statusKey}"` : ''}>
  <span class="count">${value}</span>
  <span class="indicator label">${label}</span>
</li>
`;
}

function renderStories(result: RunResult, reportDir: string): string {
  const items = result.stories
    .map((story, index) => renderStory(story, index, reportDir))
    .join('\n');
  const total = result.stories.length;
  return `
<section aria-labelledby="stories-heading">
  <h2 id="stories-heading">stories</h2>
  <div class="stories-toolbar">
    <fieldset class="story-filter">
      <legend class="sr-only">filter</legend>
      ${storyFilterRadio('all', true)}
      ${storyFilterRadio('passed', false)}
      ${storyFilterRadio('changed', false)}
      ${storyFilterRadio('failed', false)}
    </fieldset>
    <p class="story-filter-status" role="status" aria-live="polite">Showing all ${total} stories</p>
    <div class="story-bulk-toggle">
      <button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="expand">Expand all</button>
      <button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="collapse">Collapse all</button>
    </div>
    <p class="bulk-toggle-status sr-only" role="status" aria-live="polite"></p>
  </div>
  <ol class="stories" aria-label="Stories executed in dependency order">
    ${items}
  </ol>
  <p class="stories-empty" hidden>No matching stories</p>
</section>
`;
}

function storyFilterRadio(status: string, checked: boolean): string {
  const inputId = `story-filter-${status}`;
  const value = status === 'passed' ? 'pass' : status;
  return `
<label for="${inputId}" class="chip chip--toggle story-filter-label">
  <input
    type="radio"
    name="story-filter"
    id="${inputId}"
    value="${value}"
    data-filter-name="${status}"
    ${checked ? 'checked' : ''}
  />
  ${status}
</label>
`;
}

function renderStory(
  story: StoryResult,
  storyIndex: number,
  reportDir: string,
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
  ${renderStoryActions(story, storyIndex, reportDir)}
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
        renderAction(action, `s${storyIndex}-a${actionIndex}`, reportDir),
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
    .map(({ action, id }) => renderAction(action, id, reportDir))
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
): string {
  const screenshots = renderScreenshots(action, actionId, reportDir);
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

function renderScreenshots(
  action: ActionResult,
  actionId: string,
  reportDir: string,
): string {
  if (!action.actualPath && !action.baselinePath) {
    return '';
  }
  const baseline = action.baselinePath
    ? toReportRelative(reportDir, action.baselinePath)
    : undefined;
  const actual = action.actualPath
    ? toReportRelative(reportDir, action.actualPath)
    : undefined;
  const diff = action.diffPath
    ? toReportRelative(reportDir, action.diffPath)
    : undefined;
  const defaultTab = diff ? 'diff' : 'actual';
  const available = { baseline, actual, diff };
  const initialTab =
    available[defaultTab] !== undefined
      ? defaultTab
      : (['baseline', 'actual', 'diff'] as const).find(
          (name) => available[name] !== undefined,
        );
  const diffStatsId = `${actionId}-diff-stats`;
  const diffStats =
    action.diffRatio !== undefined
      ? `<p class="diff-stats" id="${diffStatsId}"><span class="count">${parseFloat((action.diffRatio * 100).toFixed(2))}%</span> <span class="label">differs</span> <span class="coverage-detail">· ${(action.diffPixels ?? 0).toLocaleString('en-US')} pixels</span></p>`
      : '';
  return `
<fieldset class="shot-radio" data-default-tab="${defaultTab}">
  <legend class="sr-only">Screenshot to display</legend>
  ${shotRadio(actionId, 'baseline', baseline === undefined, initialTab === 'baseline')}
  ${shotRadio(actionId, 'actual', actual === undefined, initialTab === 'actual')}
  ${shotRadio(actionId, 'diff', diff === undefined, initialTab === 'diff')}
  ${diffStats}
</fieldset>
${shotPanel(actionId, 'baseline', baseline, `${action.action} baseline screenshot`, initialTab === 'baseline')}
${shotPanel(actionId, 'actual', actual, `${action.action} actual screenshot from this run`, initialTab === 'actual')}
${shotPanel(actionId, 'diff', diff, `Pixel diff overlay for ${action.action}; changed regions are highlighted`, initialTab === 'diff', action.diffRatio !== undefined ? diffStatsId : undefined)}
`;
}

function shotRadio(
  actionId: string,
  name: string,
  disabled: boolean,
  checked: boolean,
): string {
  const inputId = `${actionId}-radio-${name}`;
  return `
<label for="${inputId}" class="chip chip--toggle shot-radio-label">
  <input
    type="radio"
    name="${actionId}-shot"
    id="${inputId}"
    value="${name}"
    data-tab="${name}"
    ${disabled ? 'disabled' : ''}
    ${checked ? 'checked' : ''}
  />
  ${name}
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
