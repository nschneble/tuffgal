/**
 * Outcome model. The runner emits a `RunResult` per invocation; the reporter
 * consumes it to render the HTML report. Status values map onto the three
 * outcomes the framework distinguishes:
 *
 * - `pass`  — action succeeded and screenshot matched baseline (or no baseline).
 * - `changed` — action succeeded but screenshot drifted past the threshold.
 *   The story does not fail. The user reviews and either approves the new
 *   baseline or files a bug.
 * - `failed` — a step threw. The story fails fast and skips any later actions.
 */
export type ActionStatus = 'pass' | 'changed' | 'failed' | 'skipped' | 'new';

export interface ActionResult {
  action: string;
  parameters?: Record<string, string>;
  /**
   * Named breakpoint (`mobile`/`tablet`/`laptop`/`desktop`) this result was
   * produced at. An action that runs at N breakpoints contributes N
   * `ActionResult` entries to the flat `StoryResult.actions` array, each tagged
   * here so the reporter groups results by mode. Optional in the type only as a
   * defensive parse guard for malformed `results.json`; every result the runner
   * emits carries it.
   */
  breakpoint?: string;
  /**
   * Viewport dimensions this result was actually captured at. Carried alongside
   * `breakpoint` so the reporter labels each group with the real size —
   * including per-config and per-story overrides — rather than a registry
   * lookup that would show stale dimensions for an overridden mode. Optional in
   * the type only as a defensive parse guard; the runner always records them.
   */
  breakpointWidth?: number;
  breakpointHeight?: number;
  status: ActionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * Number of the step (0-indexed) that failed. Undefined if the action
   * succeeded or was skipped without running.
   */
  failedStepIndex?: number;
  failureMessage?: string;
  baselinePath?: string;
  actualPath?: string;
  diffPath?: string;
  diffPixels?: number;
  diffRatio?: number;
  /** Mean SSIM score of baseline vs actual — see screenshots/diff.ts. */
  ssimScore?: number;
  /**
   * `true` when the captured page accessibility tree differs from the
   * baseline tree. Informational only — does not gate pass/changed by
   * itself; pixel/SSIM still drives the status.
   */
  a11yChanged?: boolean;
  /**
   * Path to the committed accessibility-tree baseline (`a11y.yaml`) for
   * this action. Populated alongside `baselinePath` so `tuffgal approve`
   * can promote the new tree at the same time as the screenshot.
   */
  a11yBaselinePath?: string;
  /** Path to the accessibility-tree snapshot captured during this run. */
  a11yActualPath?: string;
}

export type StoryStatus = 'pass' | 'changed' | 'failed';

export interface StoryResult {
  story: string;
  file: string;
  status: StoryStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  actions: ActionResult[];
  /** Absolute path to the Playwright trace zip when the story failed. */
  tracePath?: string;
}

export interface CoverageMetric {
  total: number;
  covered: number;
  ratio: number;
  missing: string[];
}

/**
 * Parses and shape-checks a `results.json` blob. `approve` re-reads the run's
 * own output, the one JSON re-entry point that skips the zod validation every
 * input file gets. A truncated or stale-schema artifact would otherwise throw
 * an opaque TypeError deep in the approval loop; this fails loudly with the
 * file path instead. Validation is intentionally shallow — enough to trust the
 * `stories[].actions[]` walk, not a full structural mirror.
 */
export function parseRunResult(raw: string, sourcePath: string): RunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Malformed results file ${sourcePath}: ${reason}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { stories?: unknown }).stories)
  ) {
    throw new Error(
      `Unexpected results file ${sourcePath}: missing a "stories" array. ` +
        `Re-run \`tuffgal run\` to regenerate it.`,
    );
  }
  return parsed as RunResult;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: {
    stories: number;
    passed: number;
    changed: number;
    failed: number;
  };
  /**
   * Custom coverage metrics layered on top of V8 line coverage:
   * `screens` = baselined visit-* actions / declared screens,
   * `flows` = stories with `flow` tag / journeys in `flowInventory`.
   */
  customCoverage: {
    screens: CoverageMetric;
    flows: CoverageMetric;
  };
  stories: StoryResult[];
}
