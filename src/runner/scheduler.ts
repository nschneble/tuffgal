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
  completed: Set<string>;
  inFlight: Set<string>;
  results: Map<string, StoryResult>;
  skipped: Set<string>;
}

export type StoryRunner = (scheduled: ScheduledStory) => Promise<StoryResult>;

/**
 * Drains the dependency graph with up to `workerCount` concurrent runs.
 * Readiness is tracked incrementally: each story carries the set of `needs`
 * labels still outstanding, and completing a producer decrements only the
 * direct consumers of its `produces` labels (looked up through a prebuilt
 * label → consumers index). A story enters the ready queue the moment its last
 * outstanding need clears. This avoids rescanning the whole story list on every
 * completion. Stories blocked by a failure receive a synthetic `failed` result
 * so the report shows the chain of effects, not a silent absence.
 */
export async function drainSchedule(
  scheduled: ScheduledStory[],
  workerCount: number,
  runner: StoryRunner,
  onStart: (item: ScheduledStory) => void,
  onFinish: (item: ScheduledStory, result: StoryResult) => void,
): Promise<StoryResult[]> {
  const context: RunContext = {
    completed: new Set(),
    inFlight: new Set(),
    results: new Map(),
    skipped: new Set(),
  };
  const ordered: ScheduledStory[] = [];

  // Label → the stories that need it, plus each story's still-outstanding needs.
  const consumersByLabel = new Map<string, ScheduledStory[]>();
  const outstandingNeeds = new Map<string, Set<string>>();
  for (const item of scheduled) {
    outstandingNeeds.set(item.file, new Set(item.needs));
    for (const label of item.needs) {
      const consumers = consumersByLabel.get(label) ?? [];
      consumers.push(item);
      consumersByLabel.set(label, consumers);
    }
  }

  // Stories with no prerequisites are ready immediately. Later stories are
  // pushed here as their last outstanding need clears.
  const ready: ScheduledStory[] = scheduled.filter(
    (item) => item.needs.length === 0,
  );

  const allDone = (): boolean => context.results.size === scheduled.length;

  const pickReady = (): ScheduledStory | undefined => {
    while (ready.length > 0) {
      const candidate = ready.shift();
      if (
        candidate &&
        !context.completed.has(candidate.file) &&
        !context.inFlight.has(candidate.file) &&
        !context.skipped.has(candidate.file)
      ) {
        return candidate;
      }
    }
    return undefined;
  };

  const satisfyProduced = (item: ScheduledStory): void => {
    for (const label of item.produces) {
      for (const consumer of consumersByLabel.get(label) ?? []) {
        const outstanding = outstandingNeeds.get(consumer.file);
        if (!outstanding) continue;
        outstanding.delete(label);
        if (
          outstanding.size === 0 &&
          !context.completed.has(consumer.file) &&
          !context.inFlight.has(consumer.file) &&
          !context.skipped.has(consumer.file)
        ) {
          ready.push(consumer);
        }
      }
    }
  };

  await new Promise<void>((resolveOuter, rejectOuter) => {
    const fillSlots = (): void => {
      while (context.inFlight.size < workerCount) {
        const next = pickReady();
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
            context.completed.add(next.file);
            if (result.status === 'failed') {
              skipDependents(next, scheduled, context, ordered);
            } else {
              satisfyProduced(next);
            }
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

  return ordered.map((item) => {
    const result = context.results.get(item.file);
    if (!result) {
      throw new SchedulerError(`internal: missing result for ${item.file}`);
    }
    return result;
  });
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
  const byFile = new Map(scheduled.map((entry) => [entry.file, entry]));
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
    const item = byFile.get(file);
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
