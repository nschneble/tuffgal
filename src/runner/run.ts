import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedBreakpoint, ResolvedConfig } from '../config.ts';
import type { Action } from '../schema/action.ts';
import type { RunResult, StoryResult, StoryStatus } from '../schema/result.ts';
import { loadActions, loadStories } from '../schema/load.ts';
import { writeReport } from '../reporter/writeReport.ts';
import { computeFlowCoverage } from '../coverage/flows.ts';
import { computeScreenCoverage } from '../coverage/screens.ts';
import { resetDatabase } from './bridges/database.ts';
import {
  startManagedDevServers,
  type ManagedDevServers,
} from './bridges/devServers.ts';
import { CoverageCollector } from './coverage.ts';
import { mergeStoryStatus, runStory } from './runStory.ts';
import {
  buildSchedule,
  drainSchedule,
  type ScheduledStory,
} from './scheduler.ts';
import {
  adaptNeedsForPass,
  mergeStoryResults,
  resolveBreakpointPasses,
  storyRendersAt,
} from './breakpointPasses.ts';
import { storyMatchesFilter } from './storyFilter.ts';

export interface RunCliOptions {
  storyFilter?: string;
  headed: boolean;
  workers?: number;
  manageServers?: boolean;
  coverage?: boolean;
}

/** One Summary bullet's data: a breakpoint name and that pass's own counts. */
interface PassSummary {
  name: string;
  counts: RunResult['totals'];
}

const HEARTBEAT_FILE = '.heartbeat';

/**
 * Loads every action and story from the configured paths, resets the
 * consumer-supplied test database, schedules stories according to their
 * needs/produces DAG, and drives execution across a fixed worker pool.
 * Returns the aggregate `RunResult` so the CLI can set the process exit
 * code.
 */
export async function runAll(
  config: ResolvedConfig,
  options: RunCliOptions,
): Promise<RunResult> {
  const startedAt = new Date();
  let managedServers: ManagedDevServers | undefined;
  if (options.manageServers) {
    managedServers = await startManagedDevServers(config);
  }
  // Heartbeat is opportunistic. A sibling supervisor process can poll this
  // file to know whether the dev servers are still in active use.
  await touchHeartbeat(config);
  const coverage = options.coverage
    ? new CoverageCollector(config.paths.report)
    : undefined;
  try {
    const actions = await loadActions(config.paths.actions);
    const allStories = await loadStories(config.paths.stories);
    const scheduled = buildSchedule(allStories);
    const subset = options.storyFilter
      ? scheduled.filter((item) => matchesFilter(item, options.storyFilter!))
      : scheduled;

    if (options.storyFilter && subset.length === 0) {
      throw new Error(`No story matched filter "${options.storyFilter}"`);
    }

    const workerCount = resolveWorkerCount(config, options.workers);
    const passes = resolveBreakpointPasses(subset, config);
    const multiPass = passes.length > 1;
    process.stdout.write(
      `Scheduling ${subset.length} stories on ${workerCount} worker${workerCount === 1 ? '' : 's'}` +
        (multiPass ? ` across ${passes.length} breakpoint passes` : '') +
        '.\n',
    );

    // Run each breakpoint as its own pass: a full reset/seed, then the whole
    // schedule rendered at that one breakpoint. This is what keeps breakpoints
    // isolated — a destructive story can mutate the seeded database in the
    // `mobile` pass without the `desktop` pass ever seeing it, because the next
    // pass starts from a fresh reset. Results are merged back per story below.
    const partsByFile = new Map<string, StoryResult[]>();
    const order: string[] = [];
    const passSummaries: PassSummary[] = [];
    for (const breakpoint of passes) {
      const participating = subset.filter((item) =>
        storyRendersAt(item, config, breakpoint),
      );
      if (participating.length === 0) continue;
      // Header for every pass — single- and multi-breakpoint alike. The reset
      // sits beneath the header so the "fresh database" line reads as part of
      // this pass's setup; a trailing blank line then separates setup from the
      // streaming result lines.
      process.stdout.write(
        `\nStarting "${breakpoint.name}" breakpoint pass at ${breakpoint.width}x${breakpoint.height}\n`,
      );
      if (config.database?.reset) {
        process.stdout.write('Resetting test database…\n');
        await resetDatabase(config);
      }
      process.stdout.write('\n');
      const passResults = await drainSchedule(
        adaptNeedsForPass(participating),
        workerCount,
        (item) =>
          runScheduledStory(
            item,
            actions,
            config,
            options.headed,
            coverage,
            breakpoint,
          ),
        () => {},
        (_item, result) =>
          process.stdout.write(
            `${formatResultLine(result.status, result.actions.length, result.durationMs, result.file)}\n`,
          ),
      );
      passSummaries.push({
        name: breakpoint.name,
        counts: summarise(passResults),
      });
      for (const result of passResults) {
        let parts = partsByFile.get(result.file);
        if (!parts) {
          parts = [];
          partsByFile.set(result.file, parts);
          order.push(result.file);
        }
        parts.push(result);
      }
    }
    const results = order.map((file) =>
      mergeStoryResults(partsByFile.get(file)!),
    );

    const finishedAt = new Date();
    const [screens, flows] = await Promise.all([
      computeScreenCoverage(config.paths.actions, config.paths.baselines),
      computeFlowCoverage(config.flowInventory, allStories),
    ]);
    const runResult: RunResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      totals: summarise(results),
      customCoverage: { screens, flows },
      stories: results,
    };
    const reportPath = await writeReport(
      config.paths.report,
      runResult,
      config.interactiveMode,
    );
    writeRunSummary(passSummaries, reportPath);
    if (coverage) {
      const coveragePath = await coverage.generate();
      process.stdout.write(`Coverage: ${coveragePath}\n`);
    }
    return runResult;
  } finally {
    if (managedServers) {
      await managedServers.stop();
    }
  }
}

function runScheduledStory(
  item: ScheduledStory,
  actions: Map<string, Action>,
  config: ResolvedConfig,
  headed: boolean,
  coverage: CoverageCollector | undefined,
  breakpoint: ResolvedBreakpoint,
): Promise<StoryResult> {
  return runStory({
    story: item.story,
    file: item.file,
    needs: item.needs,
    produces: item.produces,
    actions,
    config,
    headed,
    coverage,
    breakpoint,
  });
}

function matchesFilter(item: ScheduledStory, filter: string): boolean {
  return storyMatchesFilter(
    { file: item.file, storyName: item.story.story },
    filter,
  );
}

function resolveWorkerCount(
  config: ResolvedConfig,
  requested: number | undefined,
): number {
  if (requested && requested > 0) {
    return requested;
  }
  if (config.workers && config.workers > 0) {
    return config.workers;
  }
  const half = Math.floor(cpus().length / 2);
  return Math.max(1, Math.min(half, 4));
}

async function touchHeartbeat(config: ResolvedConfig): Promise<void> {
  try {
    await mkdir(config.paths.report, { recursive: true });
    await writeFile(
      join(config.paths.report, HEARTBEAT_FILE),
      new Date().toISOString(),
      'utf8',
    );
  } catch {
    // The heartbeat is opportunistic — a missing parent dir or a disk
    // hiccup should not fail the entire run.
  }
}

function summarise(results: StoryResult[]): RunResult['totals'] {
  return {
    stories: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    changed: results.filter((result) => result.status === 'changed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    new: results.filter((result) => result.status === 'new').length,
  };
}

/** Status → leading glyph for a streaming result line. */
const STATUS_SYMBOL: Record<StoryStatus, string> = {
  pass: '✓',
  changed: '~',
  new: '+',
  failed: '✗',
};

/**
 * One streaming finish line: `<symbol> <actionCount> <elapsed>s <stem>`. The
 * count is how many steps the story ran, the elapsed time is wall-clock
 * duration to hundredths of a second, and the stem is the story file without
 * its `.json` extension.
 */
export function formatResultLine(
  status: StoryStatus,
  actionCount: number,
  durationMs: number,
  file: string,
): string {
  const elapsed = (durationMs / 1000).toFixed(2);
  const stem = file.replace(/\.json$/, '');
  return `${STATUS_SYMBOL[status]} ${actionCount} ${elapsed}s ${stem}`;
}

/**
 * One Summary bullet for a breakpoint pass: `• <parts> on "<name>" breakpoint`,
 * where `<parts>` joins only the nonzero outcome categories in a fixed order
 * (passed, new, changed, failed) — e.g. `2 passed, 1 changed`. Falls back to
 * `0 passed` for the degenerate all-zero pass the run loop never actually
 * emits (it `continue`s past a pass with no participating stories).
 */
export function formatSummaryBullet(
  name: string,
  counts: RunResult['totals'],
): string {
  const parts: string[] = [];
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.new > 0) parts.push(`${counts.new} new`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  const summary = parts.length > 0 ? parts.join(', ') : '0 passed';
  return `• ${summary} on "${name}" breakpoint`;
}

/**
 * Emits the end-of-run tail: a `Summary` section with one bullet per breakpoint
 * pass — counted from that pass's own results, not the merged-across-passes
 * rollup — then the `Report:` line. The report link is a `file://` URL so
 * terminals that recognise file URIs (iTerm2, Warp, VS Code) render it as a
 * clickable link.
 */
function writeRunSummary(
  passSummaries: PassSummary[],
  reportPath: string,
): void {
  process.stdout.write('\nSummary\n');
  for (const pass of passSummaries) {
    process.stdout.write(`${formatSummaryBullet(pass.name, pass.counts)}\n`);
  }
  process.stdout.write(`\nReport: ${pathToFileURL(reportPath).href}\n`);
}

/**
 * The breakpoint names that drove a merged story to its status — the modes the
 * reader actually needs to inspect. A `changed` story that drifted only at
 * `desktop` tags `[desktop]`, not the `mobile` pass that stayed clean. Returns
 * empty (no tag) when the story spans a single breakpoint, since there is
 * nothing to disambiguate. The merged actions still carry their `breakpoint`
 * tag, so this is derived, not separately tracked.
 */
export function drivingBreakpoints(result: StoryResult): string[] {
  const order: string[] = [];
  const perBreakpoint = new Map<string, StoryStatus>();
  for (const action of result.actions) {
    const breakpoint = action.breakpoint;
    if (!breakpoint) continue;
    if (!perBreakpoint.has(breakpoint)) {
      perBreakpoint.set(breakpoint, 'pass');
      order.push(breakpoint);
    }
    perBreakpoint.set(
      breakpoint,
      mergeStoryStatus(
        perBreakpoint.get(breakpoint)!,
        // A skipped action means an earlier action in that breakpoint failed.
        action.status === 'skipped' ? 'failed' : action.status,
      ),
    );
  }
  if (order.length <= 1) return [];
  return order.filter(
    (breakpoint) => perBreakpoint.get(breakpoint) === result.status,
  );
}
