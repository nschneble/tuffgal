import type { ResolvedBreakpoint, ResolvedConfig } from '../config.ts';
import type { StoryResult } from '../schema/result.ts';
import type { ScheduledStory } from './scheduler.ts';
import { mergeStoryStatus, resolveRunSet } from './runStory.ts';

/**
 * A breakpoint pass is uniquely a (name, width, height) triple: two stories may
 * both name `desktop` but override its dimensions differently, and those are
 * genuinely separate render targets that each want their own clean database.
 */
function passKey(breakpoint: ResolvedBreakpoint): string {
  return `${breakpoint.name}@${breakpoint.width}x${breakpoint.height}`;
}

/**
 * True when `item` renders at `breakpoint` — i.e. its resolved run set (its own
 * `breakpoints` override, else the project default) contains a breakpoint with
 * the same name AND dimensions.
 */
export function storyRendersAt(
  item: ScheduledStory,
  config: ResolvedConfig,
  breakpoint: ResolvedBreakpoint,
): boolean {
  const key = passKey(breakpoint);
  return resolveRunSet(item.story, config).some((bp) => passKey(bp) === key);
}

/**
 * The ordered list of breakpoint passes a run executes. Multi-breakpoint runs
 * are driven as one pass per breakpoint — a full reset/seed then the whole
 * schedule — so each breakpoint sees a pristine database instead of inheriting
 * the previous breakpoint's mutations (the password a `mobile` pass changed no
 * longer leaks into the `desktop` pass). Order follows `config.breakpoints`
 * first so the default run keeps its configured order, then appends any extra
 * breakpoints that only per-story overrides introduce. Deduped by name+dims.
 */
export function resolveBreakpointPasses(
  stories: ScheduledStory[],
  config: ResolvedConfig,
): ResolvedBreakpoint[] {
  const seen = new Set<string>();
  const passes: ResolvedBreakpoint[] = [];
  const add = (bp: ResolvedBreakpoint): void => {
    const key = passKey(bp);
    if (seen.has(key)) return;
    seen.add(key);
    passes.push(bp);
  };
  for (const bp of config.breakpoints) add(bp);
  for (const item of stories) {
    for (const bp of resolveRunSet(item.story, config)) add(bp);
  }
  return passes;
}

/**
 * Re-keys a pass's stories so the scheduler only waits on prerequisites that
 * actually run in THIS pass. A `needs` label whose producer renders at a
 * different breakpoint than this pass would otherwise never clear and deadlock
 * the drain; that producer instead persisted its auth state to disk in its own
 * (earlier) pass, so the dependency is already satisfied off-disk. `produces` is
 * left intact so failure cascades still propagate within the pass.
 */
export function adaptNeedsForPass(
  participating: ScheduledStory[],
): ScheduledStory[] {
  const producesInPass = new Set<string>();
  for (const item of participating) {
    for (const label of item.produces) producesInPass.add(label);
  }
  return participating.map((item) => ({
    ...item,
    needs: item.needs.filter((label) => producesInPass.has(label)),
  }));
}

/**
 * Folds one story's per-pass results back into the single `StoryResult` the
 * report expects. Each part is the same story at one breakpoint; their actions
 * (already tagged with their breakpoint) concatenate in pass order, the status
 * is the worst across passes, the window spans the earliest start to the latest
 * finish, and the first trace zip produced wins (mirroring the single-pass
 * "first failing breakpoint" rule). A single part returns an equivalent result,
 * so single-breakpoint runs are unchanged.
 */
export function mergeStoryResults(parts: StoryResult[]): StoryResult {
  if (parts.length === 1) return parts[0]!;
  const first = parts[0]!;
  let status = first.status;
  let startedAt = first.startedAt;
  let finishedAt = first.finishedAt;
  let durationMs = 0;
  let tracePath: string | undefined;
  const actions = [];
  for (const part of parts) {
    status = mergeStoryStatus(status, part.status);
    if (part.startedAt < startedAt) startedAt = part.startedAt;
    if (part.finishedAt > finishedAt) finishedAt = part.finishedAt;
    durationMs += part.durationMs;
    if (tracePath === undefined && part.tracePath !== undefined) {
      tracePath = part.tracePath;
    }
    actions.push(...part.actions);
  }
  return {
    story: first.story,
    file: first.file,
    status,
    startedAt,
    finishedAt,
    durationMs,
    actions,
    tracePath,
  };
}
