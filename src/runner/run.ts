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
    for (const breakpoint of passes) {
      const participating = subset.filter((item) =>
        storyRendersAt(item, config, breakpoint),
      );
      if (participating.length === 0) continue;
      if (config.database?.reset) {
        process.stdout.write('Resetting test database…\n');
        await resetDatabase(config);
      }
      if (multiPass) {
        process.stdout.write(
          `▷ ${breakpoint.name} ${breakpoint.width}×${breakpoint.height}\n`,
        );
      }
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
        (item) => process.stdout.write(`▶ ${item.file}\n`),
        (item, result) =>
          process.stdout.write(
            `  ${result.status.toUpperCase()} ${item.file} (${result.actions.length} actions, ${result.durationMs} ms)\n`,
          ),
      );
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
    writeRunSummary(results, runResult.totals, reportPath);
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

/**
 * Emits the end-of-run tail. The streaming `▶`/`PASS|CHANGED|FAILED` lines
 * already cover the heartbeat; this groups the noteworthy stories
 * (changed + failed) in finish order so a user scanning the terminal lands
 * on the actionable list directly above the totals. The `Report:` line is
 * a `file://` URL so terminals that recognise file URIs (iTerm2, Warp, VS
 * Code) render it as a clickable link.
 */
function writeRunSummary(
  results: StoryResult[],
  totals: RunResult['totals'],
  reportPath: string,
): void {
  const newStories = results.filter((result) => result.status === 'new');
  const changed = results.filter((result) => result.status === 'changed');
  const failed = results.filter((result) => result.status === 'failed');

  if (newStories.length > 0 || changed.length > 0 || failed.length > 0) {
    process.stdout.write('\n');
    if (newStories.length > 0) {
      process.stdout.write('New:\n');
      for (const result of newStories) {
        process.stdout.write(`  ${formatSummaryLine(result)}\n`);
      }
    }
    if (changed.length > 0) {
      process.stdout.write('Changed:\n');
      for (const result of changed) {
        process.stdout.write(`  ${formatSummaryLine(result)}\n`);
      }
    }
    if (failed.length > 0) {
      process.stdout.write('Failed:\n');
      for (const result of failed) {
        process.stdout.write(`  ${formatSummaryLine(result)}\n`);
      }
    }
  }

  process.stdout.write(
    `\nTotals: ${totals.passed} pass · ${totals.new} new · ${totals.changed} changed · ${totals.failed} failed\n`,
  );
  process.stdout.write(`Report: ${pathToFileURL(reportPath).href}\n`);
}

function formatSummaryLine(result: StoryResult): string {
  const base = `${result.status.toUpperCase()} ${result.file} — ${result.story} (${result.actions.length} actions, ${result.durationMs} ms)`;
  const driving = drivingBreakpoints(result);
  return driving.length > 0 ? `${base} [${driving.join(' · ')}]` : base;
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
