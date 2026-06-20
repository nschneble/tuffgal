import { normalisedNeeds } from '../schema/story.ts';
import type { StoryFile } from '../schema/load.ts';
import type { StoryResult, StoryStatus } from '../schema/result.ts';

export interface ScheduledStory extends StoryFile {
  needs: string[];
  produces: string[];
}

export interface ScheduleSummary {
  ready: ScheduledStory[];
  blocked: ScheduledStory[];
}

/**
 * Validates that every produced label is emitted by at most one story and
 * that every `needs` label has a matching producer. Throws a descriptive
 * error on any mismatch so a typo in a JSON file fails loudly at load time,
 * not at run time.
 */
export function buildSchedule(stories: StoryFile[]): ScheduledStory[] {
  const scheduled: ScheduledStory[] = stories.map((entry) => ({
    ...entry,
    needs: normalisedNeeds(entry.story),
    produces: entry.story.produces ?? [],
  }));

  const producerByLabel = new Map<string, string>();
  for (const item of scheduled) {
    for (const label of item.produces) {
      const previous = producerByLabel.get(label);
      if (previous !== undefined) {
        throw new SchedulerError(
          `Label "${label}" is produced by both ${previous} and ${item.file}. Labels must be unique.`,
        );
      }
      producerByLabel.set(label, item.file);
    }
  }

  for (const item of scheduled) {
    for (const label of item.needs) {
      if (!producerByLabel.has(label)) {
        throw new SchedulerError(
          `${item.file} needs label "${label}" but no story produces it.`,
        );
      }
    }
  }

  detectCycles(scheduled, producerByLabel);
  return scheduled;
}

interface RunContext {
  satisfied: Set<string>;
  completed: Set<string>;
  inFlight: Set<string>;
  results: Map<string, StoryResult>;
  skipped: Set<string>;
}

export type StoryRunner = (scheduled: ScheduledStory) => Promise<StoryResult>;

/**
 * Drains the dependency graph with up to `workerCount` concurrent runs.
 * Stories whose `needs` are satisfied move into the ready pool; the
 * scheduler keeps the pool full until everything has either completed or
 * been transitively blocked by a failure. Stories blocked by failure receive
 * a synthetic `failed` result with a descriptive message so the report
 * shows the chain of effects, not a silent absence.
 */
export async function drainSchedule(
  scheduled: ScheduledStory[],
  workerCount: number,
  runner: StoryRunner,
  onStart: (item: ScheduledStory) => void,
  onFinish: (item: ScheduledStory, result: StoryResult) => void,
): Promise<StoryResult[]> {
  const context: RunContext = {
    satisfied: new Set(),
    completed: new Set(),
    inFlight: new Set(),
    results: new Map(),
    skipped: new Set(),
  };
  const ordered: ScheduledStory[] = [];

  const allDone = (): boolean =>
    scheduled.every((item) => context.results.has(item.file));

  await new Promise<void>((resolveOuter, rejectOuter) => {
    const fillSlots = (): void => {
      while (context.inFlight.size < workerCount) {
        const next = pickNextReady(scheduled, context);
        if (!next) {
          break;
        }
        context.inFlight.add(next.file);
        onStart(next);
        // Invariant: `runner` must always be async. The completion `.then`
        // re-enters fillSlots; if a runner ever resolved synchronously it would
        // re-enter while this `while` is still iterating and inFlight accounting
        // could momentarily exceed workerCount.
        runner(next)
          .then((result) => {
            context.inFlight.delete(next.file);
            context.results.set(next.file, result);
            ordered.push(next);
            if (result.status === 'failed') {
              skipDependents(next, scheduled, context, ordered);
            } else {
              for (const label of next.produces) {
                context.satisfied.add(label);
              }
            }
            context.completed.add(next.file);
            onFinish(next, result);
            if (allDone()) {
              resolveOuter();
              return;
            }
            fillSlots();
          })
          .catch(rejectOuter);
      }
      if (context.inFlight.size === 0 && allDone()) {
        resolveOuter();
      }
    };
    fillSlots();
  });

  return ordered.map((item) => context.results.get(item.file)!);
}

function pickNextReady(
  scheduled: ScheduledStory[],
  context: RunContext,
): ScheduledStory | undefined {
  return scheduled.find(
    (item) =>
      !context.completed.has(item.file) &&
      !context.inFlight.has(item.file) &&
      !context.skipped.has(item.file) &&
      item.needs.every((label) => context.satisfied.has(label)),
  );
}

function skipDependents(
  failed: ScheduledStory,
  scheduled: ScheduledStory[],
  context: RunContext,
  ordered: ScheduledStory[],
): void {
  const failedLabels = new Set(failed.produces);
  for (const item of scheduled) {
    if (context.results.has(item.file) || context.skipped.has(item.file)) {
      continue;
    }
    if (item.needs.some((label) => failedLabels.has(label))) {
      context.skipped.add(item.file);
      context.results.set(item.file, {
        story: item.story.story,
        file: item.file,
        status: 'failed' as StoryStatus,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        actions: [
          {
            action: '(blocked)',
            status: 'skipped',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            failureMessage: `blocked by failed prerequisite ${failed.file}`,
          },
        ],
      });
      context.completed.add(item.file);
      // Surface the synthetic skip in the same ordered list that the
      // run loop populates, so downstream consumers (report, totals,
      // exit code) see the chain of effects instead of a silent absence.
      ordered.push(item);
      // Propagate skip transitively — the now-skipped item's "produces"
      // labels stay unsatisfied, so other consumers of the same label
      // will be caught by the next loop iteration.
      skipDependents(item, scheduled, context, ordered);
    }
  }
}

function detectCycles(
  scheduled: ScheduledStory[],
  producerByLabel: Map<string, string>,
): void {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const visit = (file: string): void => {
    if (onStack.has(file)) {
      throw new SchedulerError(
        `Cycle detected in story dependencies involving ${file}`,
      );
    }
    if (visited.has(file)) {
      return;
    }
    onStack.add(file);
    const item = scheduled.find((entry) => entry.file === file);
    if (item) {
      for (const label of item.needs) {
        const upstream = producerByLabel.get(label);
        if (upstream && upstream !== file) {
          visit(upstream);
        }
      }
    }
    onStack.delete(file);
    visited.add(file);
  };
  for (const item of scheduled) {
    visit(item.file);
  }
}

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}
