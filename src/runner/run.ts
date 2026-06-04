import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import type { Action } from '../schema/action.ts';
import type { RunResult, StoryResult } from '../schema/result.ts';
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
import { runStory } from './runStory.ts';
import {
  buildSchedule,
  drainSchedule,
  type ScheduledStory,
} from './scheduler.ts';

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
    if (config.database?.reset) {
      process.stdout.write('Resetting test database…\n');
      await resetDatabase(config);
    }
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
    process.stdout.write(
      `Scheduling ${subset.length} stories on ${workerCount} worker${workerCount === 1 ? '' : 's'}.\n`,
    );

    const results = await drainSchedule(
      subset,
      workerCount,
      (item) => runScheduledStory(item, actions, config, options.headed, coverage),
      (item) => process.stdout.write(`▶ ${item.file}\n`),
      (item, result) =>
        process.stdout.write(
          `  ${result.status.toUpperCase()} ${item.file} (${result.actions.length} actions, ${result.durationMs} ms)\n`,
        ),
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
    const reportPath = await writeReport(config.paths.report, runResult);
    process.stdout.write(`\nReport: ${reportPath}\n`);
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
  });
}

function matchesFilter(item: ScheduledStory, filter: string): boolean {
  return (
    item.file === filter ||
    item.file === `${filter}.json` ||
    item.story.story === filter
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
  };
}
