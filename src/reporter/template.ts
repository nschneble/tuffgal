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

/**
 * Per-tier text/glyph markers prepended to the story file name. These are the
 * mandatory non-color cue for WCAG 1.4.1: color + an sr-only word alone do not
 * distinguish status for sighted color-blind users, and the inset accent bar
 * cannot tell changed from failed. Marked `aria-hidden` since the sr-only
 * status word carries the meaning for the accessibility tree.
 */
const STATUS_MARKERS: Record<ActionStatus, string> = {
  pass: '✓',
  changed: '~',
  failed: '✕',
  skipped: '–',
  new: '+',
};

/**
 * Static HTML report. Console / dev-tool aesthetic: dark by default, mono for
 * data, sans for prose, sharp 1px borders, tree branches in box-drawing
 * characters that are hidden from assistive tech. Stories + actions are
 * conveyed semantically through nested `<ol>` elements; the glyphs are
 * pure presentation.
 */
export function renderReport(result: RunResult, reportDir: string): string {
  const failures = collectFailures(result);
  const dateLabel = formatDate(result.finishedAt);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tuffgal report — ${dateLabel}</title>
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
  ${renderFailures(failures, reportDir)}
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
</section>`;
}

function coverageItem(
  label: string,
  metric: { total: number; covered: number; ratio: number },
): string {
  const pct = `${(metric.ratio * 100).toFixed(0)}%`;
  return `<li class="summary-item coverage"><span class="count">${pct}</span><span class="label">${label}</span><span class="coverage-detail" aria-hidden="true">${metric.covered}/${metric.total}</span><span class="sr-only">${metric.covered} of ${metric.total} ${label} covered</span></li>`;
}

function summaryItem(
  label: string,
  value: number,
  statusKey?: ActionStatus,
): string {
  const indicator = statusKey
    ? `<span class="indicator" data-status="${statusKey}" aria-hidden="true"></span>`
    : '';
  return `<li class="summary-item"${
    statusKey ? ` data-status="${statusKey}"` : ''
  }><span class="count">${value}</span>${indicator}<span class="label">${label}</span></li>`;
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
    <!--
      The .story-filter-status region is the single polite live region for the
      stories toolbar — it carries both filter announcements and bulk-toggle
      (expand/collapse all) announcements. Adding a second polite region here
      would race against this one; reuse is intentional.

      DOM order is logical: filters then status then buttons. The buttons are
      pushed visually right via margin-left:auto on .story-bulk-toggle in the
      CSS, never via the order property on the interactive elements (that would
      fail WCAG 2.4.3).
    -->
    <p class="story-filter-status" role="status" aria-live="polite">Showing all ${total} stories.</p>
    <div class="story-bulk-toggle">
      <button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="expand">Expand all screenshots</button>
      <button type="button" class="chip story-bulk-toggle-button" data-bulk-toggle="collapse">Collapse all screenshots</button>
    </div>
  </div>
  <ol class="stories" aria-label="Stories executed in dependency order">
    ${items}
  </ol>
  <p class="stories-empty" hidden>no stories match</p>
</section>`;
}

function storyFilterRadio(status: string, checked: boolean): string {
  const inputId = `story-filter-${status}`;
  const value = status === 'passed' ? 'pass' : status;
  return `<label for="${inputId}" class="chip chip--toggle story-filter-label">
    <input
      type="radio"
      name="story-filter"
      id="${inputId}"
      value="${value}"
      data-filter-name="${status}"
      ${checked ? 'checked' : ''}
    />
    ${status}
  </label>`;
}

function renderStory(
  story: StoryResult,
  storyIndex: number,
  reportDir: string,
): string {
  const actions = story.actions
    .map((action, actionIndex, all) =>
      renderAction(
        action,
        `s${storyIndex}-a${actionIndex}`,
        actionIndex === all.length - 1,
        reportDir,
      ),
    )
    .join('\n');
  return `
<li class="story" data-status="${story.status}">
  <div class="story-row">
    <span class="story-marker" aria-hidden="true">${STATUS_MARKERS[story.status]}</span><span class="sr-only">${STATUS_LABELS[story.status]}</span>
    <code class="story-file">${escapeHtml(story.file)}</code>
    <span class="story-duration">${formatDuration(story.durationMs)}</span>
  </div>
  <p class="story-prose">${escapeHtml(story.story)}</p>
  <ol class="actions" aria-label="Actions">
    ${actions}
  </ol>
</li>`;
}

function renderAction(
  action: ActionResult,
  actionId: string,
  isLast: boolean,
  reportDir: string,
): string {
  const branch = isLast ? '└─' : '├─';
  const screenshots = renderScreenshots(action, actionId, reportDir);
  const errorBlock =
    action.status === 'failed'
      ? `<pre class="action-error">${escapeHtml(action.failureMessage ?? 'unknown error')}</pre>`
      : '';
  const parameters = renderParameters(action.parameters);
  return `
<li class="action" data-status="${action.status}">
  <div class="action-row">
    <span class="branch" aria-hidden="true">${branch}</span>
    ${statusBadge(action.status)}
    <code class="action-name">${escapeHtml(action.action)}</code>
    <span class="action-duration">${formatDuration(action.durationMs)}</span>
    ${screenshots ? `<span class="action-shots">${screenshots}</span>` : ''}
  </div>
  ${parameters}
  ${errorBlock}
</li>`;
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
  const diffStatsId = `${actionId}-diff-stats`;
  const diffStats =
    action.diffRatio !== undefined
      ? `<p class="diff-stats" id="${diffStatsId}">${action.diffPixels} pixels differ (${(action.diffRatio * 100).toFixed(3)}%)</p>`
      : '';
  return `
<details class="shots">
  <summary><span aria-hidden="true">[</span>view<span aria-hidden="true">]</span></summary>
  <fieldset class="shot-radio" data-default-tab="${defaultTab}">
    <legend class="sr-only">Screenshot to display</legend>
    ${shotRadio(actionId, 'baseline', baseline === undefined)}
    ${shotRadio(actionId, 'actual', actual === undefined)}
    ${shotRadio(actionId, 'diff', diff === undefined)}
  </fieldset>
  ${shotPanel(actionId, 'baseline', baseline, `${action.action} baseline screenshot`)}
  ${shotPanel(actionId, 'actual', actual, `${action.action} actual screenshot from this run`)}
  ${shotPanel(actionId, 'diff', diff, `Pixel diff overlay for ${action.action}: red pixels mark changed regions`, action.diffRatio !== undefined ? diffStatsId : undefined)}
  ${diffStats}
</details>`;
}

function shotRadio(actionId: string, name: string, disabled: boolean): string {
  const inputId = `${actionId}-radio-${name}`;
  return `<label for="${inputId}" class="chip chip--toggle shot-radio-label">
    <input
      type="radio"
      name="${actionId}-shot"
      id="${inputId}"
      value="${name}"
      data-tab="${name}"
      ${disabled ? 'disabled' : ''}
    />
    ${name}
  </label>`;
}

function shotPanel(
  actionId: string,
  name: string,
  src: string | undefined,
  alt: string,
  describedById?: string,
): string {
  return `<div
    class="shot-panel"
    id="panel-${actionId}-${name}"
    data-tab="${name}"
    hidden
  >
    ${
      src
        ? `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy"${describedById ? ` aria-describedby="${describedById}"` : ''} />`
        : `<p class="shot-missing">no ${name} screenshot for this action</p>`
    }
  </div>`;
}

function renderFailures(failures: FailureRecord[], reportDir: string): string {
  if (failures.length === 0) {
    return `
<section aria-labelledby="failures-heading">
  <h2 id="failures-heading">failures</h2>
  <p class="prose-block empty">(none)</p>
</section>`;
  }
  const items = failures
    .map(
      (failure) => `
<article class="failure">
  <header class="failure-head">
    <code>${escapeHtml(failure.storyFile)}</code>
    <span aria-hidden="true">·</span>
    <code>${escapeHtml(failure.actionName)}</code>
  </header>
  <pre class="failure-message">${escapeHtml(failure.message)}</pre>
  ${
    failure.tracePath
      ? `<p class="failure-trace">trace: <a href="${escapeAttribute(toReportRelative(reportDir, failure.tracePath))}">${escapeHtml(toReportRelative(reportDir, failure.tracePath))}</a></p>`
      : ''
  }
</article>`,
    )
    .join('\n');
  return `
<section aria-labelledby="failures-heading">
  <h2 id="failures-heading">failures</h2>
  <ol class="failures" aria-label="Failed actions">
    ${items}
  </ol>
</section>`;
}

interface FailureRecord {
  storyFile: string;
  actionName: string;
  message: string;
  tracePath?: string;
}

function collectFailures(result: RunResult): FailureRecord[] {
  const out: FailureRecord[] = [];
  for (const story of result.stories) {
    for (const action of story.actions) {
      if (action.status === 'failed') {
        out.push({
          storyFile: story.file,
          actionName: action.action,
          message: action.failureMessage ?? 'unknown error',
          tracePath: story.tracePath,
        });
      }
    }
  }
  return out;
}

function statusBadge(status: ActionStatus): string {
  return `<span class="status" data-status="${status}">
    <span class="sr-only">${STATUS_LABELS[status]}</span><span class="status-label" aria-hidden="true">${STATUS_LABELS[status]}</span>
  </span>`;
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

/**
 * Friendly human-readable timestamp, e.g. "June 19, 1:58pm". Month name, day,
 * 12-hour clock with lowercase am/pm and no leading zero on the hour, no
 * seconds. Uses local time; the machine-readable ISO value is preserved
 * separately on the `<time datetime>` attribute for assistive tech.
 */
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

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
