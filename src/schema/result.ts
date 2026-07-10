import type { RunMode } from '../runner/mode.ts';
import type { EnvironmentManifest } from '../runner/manifest.ts';

/**
 * Outcome model. The runner emits a `RunResult` per invocation; the reporter
 * consumes it to render the HTML report. Status values map onto the three
 * outcomes the framework distinguishes:
 *
 * - `pass`  — action succeeded and screenshot matched baseline (or no baseline).
 * - `changed` — action succeeded but the baseline drifted: the screenshot moved
 *   past the threshold, or (CI mode) pixels matched while the accessibility-tree
 *   snapshot drifted. The story does not fail. The user reviews and either
 *   approves the new baseline or files a bug.
 * - `new` — no baseline existed; one was written this run. Informational, not a
 *   regression — there is nothing to compare against yet.
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
   * baseline tree. Advisory in local mode (flagged, never gates status). In CI
   * mode it DOES gate: when pixels pass but the aria snapshot drifts, the status
   * becomes `changed` and a candidate pair is written, so a drifted committed
   * `a11y.yaml` stays re-approvable under the sole-writer model. On a
   * `changed` result with no `diffPath` (no pixel diff), this flag being `true`
   * marks the drift as a11y-only — pixel drift always carries a `diffPath`.
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

/**
 * Story-wide rollup of its action results. Precedence (worst wins):
 * `failed` > `changed` > `new` > `pass`. A story is `new` only when it wrote at
 * least one fresh baseline and had no `changed`/`failed` action — so a run of
 * first-time stories no longer masquerades as `changed`.
 */
export type StoryStatus = 'pass' | 'changed' | 'failed' | 'new';

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
 * One orphaned committed baseline: an entry under `paths.baselines` whose action
 * ran no story this run, so nothing compared against it. Recorded (CI mode,
 * unfiltered runs only) so the report can surface it and a later `approve
 * --prune` can delete it — this wave detects, it never removes.
 *
 * Keyed per breakpoint rather than per action so a partially-orphaned action
 * (some breakpoints retired, others still live) could in principle be expressed;
 * today an orphan action is retired wholesale, one entry per baseline file group
 * it left behind. `breakpoint` is the mode name (`mobile`/`desktop`/…) for the
 * breakpoint-keyed `<action>/<breakpoint>.png` layout, or `'legacy'` for the
 * pre-breakpoint `<action>/0.png` layout. `baselinePaths` are the absolute paths
 * the prune step deletes — the PNG plus its a11y companion when one exists — so
 * wave 7 prunes a flat path list without re-deriving layout.
 */
export interface DeletedBaseline {
  action: string;
  breakpoint: string;
  baselinePaths: string[];
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

/**
 * The capture-environment block recorded on every run. Lets the report, the
 * Action, and a human diagnose an environment drift between the committed
 * baselines and the run that compared against them.
 *
 * - `expected` — the committed `<baselines>/manifest.json` when one exists and
 *   parses, else `null`. `null` covers both the bootstrap case (no manifest
 *   written yet — the first `approve --from` creates it) and local mode, which
 *   never reads `paths.baselines` at all.
 * - `actual` — the environment this run actually captured under.
 * - `mismatch` — `true` when a pixel-affecting key diverged (CI mode with a
 *   present manifest), or when the committed manifest was unreadable. Always
 *   `false` in local mode and on the bootstrap (missing-manifest) case.
 * - `mismatchKeys` — the specific diverging keys (see `PIXEL_AFFECTING_KEYS`),
 *   or `['manifest']` when the committed manifest could not be parsed. Empty
 *   when `mismatch` is `false`.
 */
export interface EnvironmentReport {
  expected: EnvironmentManifest | null;
  actual: EnvironmentManifest;
  mismatch: boolean;
  mismatchKeys: string[];
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * Comparison contract the run executed under (`'ci' | 'local'`). Recorded so
   * the report, the Action, and `approve --from` can distinguish a committed-
   * baseline gate run from an advisory local self-diff. Optional in the type
   * only as a defensive parse guard for older `results.json` artifacts that
   * predate this field; every result the current runner emits carries it.
   */
  mode?: RunMode;
  totals: {
    stories: number;
    passed: number;
    changed: number;
    failed: number;
    /** Stories whose rollup status is `new` (wrote a fresh baseline, no drift). */
    new: number;
    /**
     * Orphaned committed baselines detected this run — the length of `deleted`.
     * CI mode + unfiltered runs only; `0` in local mode and on any filtered run
     * (where unselected stories' baselines are not orphans, merely unvisited).
     */
    deleted: number;
  };
  /**
   * Orphaned committed baselines: entries under `paths.baselines` whose action
   * ran no story this run. Populated only for an unfiltered CI run (see
   * {@link DeletedBaseline}); empty in local mode and on filtered runs, where a
   * baseline going unvisited says nothing about whether its story still exists.
   * Detection only — pruning is a later wave.
   */
  deleted: DeletedBaseline[];
  /**
   * Capture-environment provenance for this run (see {@link EnvironmentReport}).
   * `expected` is the committed manifest (null in local mode / bootstrap),
   * `actual` is what this run captured under, and `mismatch`/`mismatchKeys`
   * drive the report banner and the `3` exit code. Optional in the type only as
   * a defensive parse guard for older `results.json` artifacts that predate this
   * block; every result the current runner emits carries it.
   */
  environment?: EnvironmentReport;
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
