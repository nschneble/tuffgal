import { isDeepStrictEqual } from 'node:util';
import type { Locator, Page } from 'playwright';
import { parse as parseYaml } from 'yaml';
import type { Action, Hint, Step } from '../schema/action.ts';
import type { ActionResult, ActionStatus } from '../schema/result.ts';
import type { ResolvedConfig } from '../config.ts';
import { capturePage } from '../screenshots/capture.ts';
import {
  renderDiffOverlay,
  scoreDiff,
  ScreenshotSizeMismatchError,
} from '../screenshots/diff.ts';
import {
  type BaselinePaths,
  deleteIfExists,
  pathsFor,
  readBaseline,
  readJsonBaseline,
  withBaselineLock,
  writeDurablePng,
  writeText,
  writeTransientPng,
} from '../screenshots/baselineStore.ts';
import { sleep } from '../util.ts';
import { buildA11yDiff } from './a11yDiff.ts';
import { comparisonRootFor, type RunMode } from './mode.ts';
import { interpolate, interpolateHint } from './interpolate.ts';
import { LocatorNotFoundError, resolveLocator } from './resolveLocator.ts';
import { runClick } from './steps/click.ts';
import { runInput } from './steps/input.ts';
import { runIntercept } from './steps/intercept.ts';
import { runNavigate } from './steps/navigate.ts';
import { runRead } from './steps/read.ts';
import { runScroll } from './steps/scroll.ts';
import { runType } from './steps/type.ts';
import { runWait } from './steps/wait.ts';
import { runWaitFor } from './steps/waitFor.ts';

export interface RunActionOptions {
  page: Page;
  action: Action;
  parameters: Record<string, string>;
  storyFile: string;
  config: ResolvedConfig;
  /**
   * Named breakpoint this action is rendering at. `runStoryWithBrowser` threads
   * the current breakpoint context's name down so the resulting paths (and the
   * `ActionResult.breakpoint` tag) key per-mode captures apart.
   */
  breakpoint: string;
  /**
   * Comparison contract for this run (see {@link RunMode}). Optional so
   * pre-existing programmatic callers and tests keep compiling; the run driver
   * always supplies it. Governs both the comparison target and the write
   * behaviour:
   *   - `ci`: compare against the committed `paths.baselines`, and NEVER write
   *     into it. A missing baseline reads `new` and the proposed render lands in
   *     the candidate tree only; `approve --from` is what promotes candidates to
   *     baselines. `paths.localCache` is never touched.
   *   - `local` (default when omitted): compare against the per-machine,
   *     gitignored `paths.localCache`, and self-manage it: a missing cache entry
   *     is auto-seeded (written as a fresh cache baseline, status `new`). The
   *     committed `paths.baselines` is never read or written in local mode.
   */
  mode?: RunMode;
}

const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BACKOFF_MS = 200;
const DEFAULT_EXPECT_TIMEOUT_MS = 10_000;

/**
 * Runs every step of an action in order, applies optional step-level retry on
 * transient locator misses, waits for at least one `expect.anyOf` hint to
 * become visible, then captures a masked full-page screenshot. Fails fast on
 * the first non-recoverable step error so the harness never compares a
 * screenshot of a half-finished state.
 */
export async function runAction(
  options: RunActionOptions,
): Promise<ActionResult> {
  const { action, page, parameters, storyFile, config, breakpoint } = options;
  const mode: RunMode = options.mode ?? 'local';
  validateParameters(action, parameters);
  // The current breakpoint name is exposed to interpolation as `${breakpoint}`
  // so a story can key test-created data per mode (e.g. registering
  // `fresh+${breakpoint}@example.test` at each viewport instead of colliding on
  // a shared email). It is injected only into the interpolation map, never the
  // validated `parameters`, `validateParameters` rejects undeclared keys, and
  // the ActionResult must still report the author's parameters verbatim. A
  // story parameter literally named `breakpoint` overrides the injected value.
  const interpolationParameters: Record<string, string> = {
    breakpoint,
    ...parameters,
  };
  const startedAt = new Date();
  const attempts = action.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const backoffMs = action.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  for (let index = 0; index < action.steps.length; index += 1) {
    const step = action.steps[index];
    if (!step) continue;
    try {
      await dispatchWithRetry(
        page,
        step,
        interpolationParameters,
        config,
        attempts,
        backoffMs,
      );
    } catch (error) {
      return failedResult(
        action,
        parameters,
        breakpoint,
        startedAt,
        index,
        error,
      );
    }
  }

  if (action.expect) {
    try {
      await waitForExpectation(page, action.expect, interpolationParameters);
    } catch (error) {
      return failedResult(
        action,
        parameters,
        breakpoint,
        startedAt,
        action.steps.length,
        error,
      );
    }
  }

  if (action.screenshot === false) {
    return successResultWithoutScreenshot(
      action,
      parameters,
      breakpoint,
      startedAt,
    );
  }

  return captureAndCompare({
    action,
    page,
    parameters,
    interpolationParameters,
    config,
    storyFile,
    startedAt,
    breakpoint,
    mode,
  });
}

async function dispatchWithRetry(
  page: Page,
  step: Step,
  parameters: Record<string, string>,
  config: ResolvedConfig,
  attempts: number,
  backoffMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await dispatch(page, step, parameters, config);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        throw error;
      }
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Only transient faults are retried; real infrastructure errors rethrow
 * immediately so a genuine fault is not masked by burning the retry budget:
 *   - `LocatorNotFoundError`: the UI has not hydrated the target element yet.
 *   - any bounded Playwright `TimeoutError`: every step whose dispatch is
 *     bounded by a Playwright timeout qualifies, not just navigation: a
 *     `page.goto` that did not reach its ready signal, AND the step-level
 *     click/input/waitFor timeouts (a slow first paint, a lagging dev server, a
 *     control still rendering), each of which a re-drive routinely clears.
 *     Classified by `name` so it holds for any Playwright timeout whether it
 *     arrives as `errors.TimeoutError` or is reconstructed across an async
 *     boundary.
 * Anything else (connection refused, protocol error, an origin-escape throw)
 * is a NON-retryable fault and rethrows on the first occurrence.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof LocatorNotFoundError) return true;
  return error instanceof Error && error.name === 'TimeoutError';
}

async function dispatch(
  page: Page,
  step: Step,
  parameters: Record<string, string>,
  config: ResolvedConfig,
): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      return runNavigate(
        page,
        interpolate(step.path, parameters),
        config,
        step.waitUntil,
      );
    case 'click':
      return runClick(
        page,
        interpolateHint(step.hint, parameters),
        config.defaultTimeoutMs,
      );
    case 'input':
      return runInput(
        page,
        interpolateHint(step.hint, parameters),
        interpolate(step.value, parameters),
        config.defaultTimeoutMs,
      );
    case 'scroll':
      return runScroll(page, step.direction, step.amount);
    case 'intercept':
      return runIntercept(page, step.pattern, step.respond, step.method);
    case 'waitFor':
      return runWaitFor(
        page,
        interpolateHint(step.hint, parameters),
        config.defaultTimeoutMs,
      );
    case 'read':
      return runRead(page, interpolateHint(step.hint, parameters));
    case 'type':
      return runType(page, interpolate(step.value, parameters));
    case 'wait':
      return runWait(page, step.ms);
  }
}

/**
 * Polls every hint in `expect.anyOf` concurrently and resolves as soon as one
 * becomes visible. Throws when none resolve within the configured timeout.
 * Race semantics: any single match satisfies the expectation. This is what
 * lets a single action declare "success looks like list-item OR toast OR
 * status banner" without the story knowing which renderer the app picked.
 */
async function waitForExpectation(
  page: Page,
  expectation: NonNullable<Action['expect']>,
  parameters: Record<string, string>,
): Promise<void> {
  const timeoutMs = expectation.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS;
  const resolvedCandidates = expectation.anyOf.map((hint) =>
    interpolateHint(hint, parameters),
  );
  const candidates = resolvedCandidates.map((hint) =>
    resolveLocator(page, hint)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => hint)
      .catch((error: unknown) => {
        throw new LocatorNotFoundError(hint, error);
      }),
  );
  try {
    await Promise.any(candidates);
  } catch (error) {
    const inner =
      error instanceof AggregateError && error.errors.length > 0
        ? error.errors[error.errors.length - 1]
        : error;
    throw new ExpectationTimedOutError(expectation, inner, timeoutMs);
  }
}

interface CaptureOptions {
  action: Action;
  page: Page;
  /** Author-declared parameters, reported verbatim on the ActionResult. */
  parameters: Record<string, string>;
  /** `parameters` plus the injected `${breakpoint}`, used for mask selectors. */
  interpolationParameters: Record<string, string>;
  config: ResolvedConfig;
  storyFile: string;
  startedAt: Date;
  breakpoint: string;
  /** Comparison contract. Governs baseline-write vs candidate-write. */
  mode: RunMode;
}

/**
 * Which existing baseline the read matched, so the caller knows where to source
 * the a11y companion from:
 *   - `breakpoint`: the breakpoint-keyed baseline existed (a11y from
 *     `paths.a11yBaseline`);
 *   - `legacy`: only the pre-breakpoint `0.png` existed; we compare against it
 *     but never auto-promote it to the breakpoint location (a11y from
 *     `paths.legacyA11yBaseline`).
 * When neither exists the lock returns `undefined` (a fresh baseline is written
 * and the action reads as `new`), so that case needs no member here.
 */
type BaselineSource = 'breakpoint' | 'legacy';

async function captureAndCompare(
  options: CaptureOptions,
): Promise<ActionResult> {
  const {
    action,
    page,
    parameters,
    interpolationParameters,
    config,
    storyFile,
    startedAt,
    breakpoint,
    mode,
  } = options;
  // The comparison target moves with the mode (see `comparisonRootFor`, the
  // single owner of the mode→root mapping). CI compares against (and, on
  // approval, promotes into) the committed `paths.baselines`; local mode
  // self-diffs against (and auto-seeds) the per-machine, gitignored
  // `paths.localCache`, never reading or writing `paths.baselines`. Report-side
  // artifacts (actual, diff, candidate) stay report-rooted regardless; only the
  // baseline/legacy side follows `comparisonRoot`. Legacy `<action>/0.png`
  // fallback resolves within whichever root is active, so a project migrating
  // its committed baselines and a developer with a legacy cache each get the
  // pre-breakpoint fallback within their own root.
  const comparisonRoot = comparisonRootFor(config, mode);
  const paths = pathsFor({
    baselinesDir: config.paths.baselines,
    comparisonRoot,
    reportDir: config.paths.report,
    storyFile,
    actionName: action.action,
    breakpoint,
  });
  const masks = resolveMasks(page, action.mask, interpolationParameters);
  const actualPng = await capturePage(page, masks, config.captureMode, {
    maxPixels: config.maxFullPagePixels,
    label: `story "${storyFile}" action "${action.action}" (${breakpoint})`,
  });
  // The run's `actual` is a transient report artifact (overwritten next run,
  // never re-read as a comparison target), so it skips the max-effort recompress.
  await writeTransientPng(paths.actual, actualPng);
  const a11yJson = await captureA11yTree(page);
  await writeText(paths.a11yActual, a11yJson);

  const baseResult = baseResultFor(
    action.action,
    parameters,
    breakpoint,
    startedAt,
  );

  // Read-then-maybe-create the baseline under a per-path lock so two stories
  // sharing this action can't both see "no baseline" and race to write it.
  // The first holder decides; later holders observe the baseline it produced.
  //
  // Read order under the lock:
  //   1. breakpoint-keyed baseline (`<action>/<bp>.png`): the canonical
  //      location once a project has migrated to named breakpoints;
  //   2. legacy baseline (`<action>/0.png`): a project baselined before this
  //      feature has only this file. We compare against it (so it still gates
  //      pass/changed) but deliberately do NOT copy it forward to the
  //      breakpoint location: a real baseline already lives at the legacy path,
  //      and promotion to the new layout is `tuffgal approve`'s job, not a
  //      silent side effect of a read. Auto-creating here would also clobber
  //      the legacy file's role as the shared fallback for every breakpoint.
  //   3. neither, the missing-baseline branch, and it splits on mode:
  //        - `local`: auto-seed the per-machine cache, write a fresh
  //          breakpoint baseline under the lock (rooted at `comparisonRoot`,
  //          i.e. `paths.localCache`) and report `new`. Zero-ceremony first run.
  //          `paths.baselines` is never touched.
  //        - `ci`: NEVER write `paths.baselines`. Committed baselines are
  //          written only through the approval flow, never as a side effect of
  //          a run. Report `new`; the proposed render is emitted to the
  //          candidate tree below (outside the lock, since candidate paths are
  //          per-report and never raced across stories).
  const found = await withBaselineLock(
    paths.baseline,
    async (): Promise<{ png: Buffer; source: BaselineSource } | undefined> => {
      const existing = await readBaseline(paths.baseline);
      if (existing !== undefined) {
        return { png: existing, source: 'breakpoint' };
      }
      const legacy = await readBaseline(paths.legacyBaseline);
      if (legacy !== undefined) {
        return { png: legacy, source: 'legacy' };
      }
      if (mode === 'local') {
        // A local-cache baseline is durable (re-read on every later run), so
        // it earns the lossless recompress.
        await writeDurablePng(paths.baseline, actualPng);
        await writeText(paths.a11yBaseline, a11yJson);
      }
      return undefined;
    },
  );

  if (found === undefined) {
    // Missing baseline → `new`. In CI mode the proposed render is the candidate
    // (nothing was written to baselines); in local mode the fresh cache entry
    // was auto-seeded above and there is no candidate tree. `writeCandidate`
    // no-ops outside CI mode.
    await writeCandidate(mode, paths, actualPng, a11yJson);
    return finishResult(baseResult, {
      status: 'new',
      baselinePath: paths.baseline,
      actualPath: paths.actual,
      a11yBaselinePath: paths.a11yBaseline,
      a11yActualPath: paths.a11yActual,
    });
  }

  const baselinePng = found.png;
  // When the comparison ran against the legacy baseline, its a11y companion
  // lives at the legacy a11y path too. Read that one so the a11yChanged
  // signal reflects the baseline we actually diffed against.
  const a11yBaselinePathForRead =
    found.source === 'legacy' ? paths.legacyA11yBaseline : paths.a11yBaseline;
  const baselineA11y = await readJsonBaseline(a11yBaselinePathForRead);
  const a11yChanged =
    baselineA11y !== undefined && a11yTreeChanged(baselineA11y, a11yJson);
  // Rendered once here and carried on the result, so the report and the Action's
  // sticky comment render the same diff instead of each re-deriving one.
  const a11yDiff =
    a11yChanged && baselineA11y !== undefined
      ? buildA11yDiff(baselineA11y, a11yJson)
      : undefined;

  try {
    const pixelThreshold = action.diff?.pixelThreshold ?? 0.1;
    const ssimThreshold = action.diff?.ssimThreshold ?? 0.99;
    const maxDiffPixels = action.diff?.maxDiffPixels ?? 0;
    // Score first (SSIM plus the differing-pixel count) without encoding
    // the overlay. The red-highlight diff image is expensive to encode and is
    // discarded on a pass, so it is rendered only on the changed branch below.
    // One decode of the pair serves both the score and (on the changed branch
    // below) the overlay render. `decoded` is threaded into renderDiffOverlay
    // so the failing path reads the image pair once, not twice.
    const { score, decoded } = scoreDiff(
      baselinePng,
      actualPng,
      pixelThreshold,
    );
    // both are necessary: SSIM's tolerance band absorbs real drift that is
    // small and localised, and a pixel count alone misses a structurally
    // different page whose differing pixels happen to be few
    const passesSsim = score.ssimScore >= ssimThreshold;
    const passesPixels = score.diffPixels <= maxDiffPixels;
    if (passesSsim && passesPixels) {
      await deleteIfExists(paths.diff);
      // A11y-only drift: pixels match but the committed aria snapshot has moved.
      // In CI mode this must surface as `changed` with a candidate pair, not a
      // silent `pass`. Under the sole-writer model a `pass` writes no candidate,
      // so a drifted committed `a11y.yaml` would be permanently unre-approvable
      // (`approve --from` has nothing to promote). The pixel-drift path below is
      // mutually exclusive with this branch, so exactly one candidate pair is
      // ever written per action. Local mode keeps the advisory behaviour. The
      // cache is auto-managed, there is no human-approval step, so the flag stays
      // informational and no candidate is proposed. There is no pixel diff here
      // (pixels passed), so `diffPath` is omitted. That, alongside
      // `a11yChanged`, is what marks a11y-only drift apart from pixel drift
      // downstream.
      const a11yDriftInCi = mode === 'ci' && a11yChanged;
      if (a11yDriftInCi) {
        await writeCandidate(mode, paths, actualPng, a11yJson);
      }
      return finishResult(baseResult, {
        status: a11yDriftInCi ? 'changed' : 'pass',
        baselinePath: paths.baseline,
        actualPath: paths.actual,
        diffPixels: score.diffPixels,
        diffRatio: score.diffRatio,
        ssimScore: score.ssimScore,
        a11yChanged: a11yChanged || undefined,
        a11yDiff,
        a11yBaselinePath: a11yBaselinePathForRead,
        a11yActualPath: paths.a11yActual,
      });
    }
    // Changed → the human needs the red-highlight overlay. This is the only
    // branch that pays the pixelmatch-fill + PNG encode cost; it reuses the
    // decode from scoreDiff above. The overlay is a transient report artifact
    // (deleted the moment a later run passes), so it skips the recompress pass.
    // It is already deflate-encoded by renderDiffOverlay.
    await writeTransientPng(
      paths.diff,
      renderDiffOverlay(decoded, pixelThreshold),
    );
    // A `changed` action in CI mode proposes a new baseline. Emit it to the
    // candidate tree so approval is a plain tree copy. Local mode does not
    // (its comparison target is the auto-managed cache, not a human-approved
    // set); `writeCandidate` no-ops there.
    await writeCandidate(mode, paths, actualPng, a11yJson);
    return finishResult(baseResult, {
      status: 'changed',
      baselinePath: paths.baseline,
      actualPath: paths.actual,
      diffPath: paths.diff,
      diffPixels: score.diffPixels,
      diffRatio: score.diffRatio,
      ssimScore: score.ssimScore,
      a11yChanged: a11yChanged || undefined,
      a11yDiff,
      a11yBaselinePath: a11yBaselinePathForRead,
      a11yActualPath: paths.a11yActual,
    });
  } catch (error) {
    if (error instanceof ScreenshotSizeMismatchError) {
      // Dimension drift is still a `changed` outcome, same candidate emission
      // (CI only; `writeCandidate` no-ops in local mode).
      await writeCandidate(mode, paths, actualPng, a11yJson);
      // CONTRACT: this branch must NEVER emit `a11yChanged`. The a11y-only-drift
      // discriminator downstream is `a11yChanged === true`, and this pixel-drift
      // (size-mismatch) result already carries no `diffPath`. Were it to also set
      // `a11yChanged`, a consumer that (incorrectly) inferred a11y-only drift from
      // `!diffPath` would misclassify it, but the positive `a11yChanged` gate,
      // which this branch deliberately leaves unset, keeps the two apart. The
      // locking test `never carries a11yChanged` guards this omission against a
      // future "cleanup" that would add it. See the `a11yChanged` doc in
      // schema/result.ts for the consumer-side rule.
      return finishResult(baseResult, {
        status: 'changed',
        baselinePath: paths.baseline,
        actualPath: paths.actual,
        failureMessage: error.message,
        // Structured mirror of `error.message` so the reporter renders the
        // dimensions in an accessible split idiom rather than parsing the prose.
        sizeMismatch: { baseline: error.baseline, actual: error.actual },
        a11yBaselinePath: a11yBaselinePathForRead,
        a11yActualPath: paths.a11yActual,
      });
    }
    throw error;
  }
}

/**
 * Emits the proposed-new-baseline render (PNG + a11y companion) to the
 * report-rooted candidate tree (`<report>/candidates/<action>/<breakpoint>.*`).
 * The layout mirrors `paths.baselines` exactly, so approving a candidate set is
 * a plain tree copy. A candidate is a proposed durable baseline, so it is
 * routed through the durable `writeDurablePng`/`writeText` seams and inherits
 * the lossless recompress pass. The promoted baseline is dense from the start.
 *
 * The candidate tree is a CI-only artifact: local mode self-diffs against the
 * per-machine cache and has no human-approval step, so it never proposes
 * candidates. The mode guard lives here (a single early-return) rather than
 * being repeated at each of the four call sites (`new`, pixel-`changed`,
 * size-mismatch, and CI a11y-only drift).
 */
async function writeCandidate(
  mode: RunMode,
  paths: BaselinePaths,
  actualPng: Buffer,
  a11yJson: string,
): Promise<void> {
  if (mode !== 'ci') return;
  await writeDurablePng(paths.candidate, actualPng);
  await writeText(paths.a11yCandidate, a11yJson);
}

function resolveMasks(
  page: Page,
  maskHints: Hint[] | undefined,
  parameters: Record<string, string>,
): Locator[] {
  if (!maskHints || maskHints.length === 0) {
    return [];
  }
  return maskHints.map((hint) =>
    resolveLocator(page, interpolateHint(hint, parameters)),
  );
}

/**
 * Snapshots the page's accessibility tree as a YAML-shaped string, exactly as
 * Playwright's `ariaSnapshot()` emits it (an ordered YAML list where array order
 * encodes DOM/reading order). Drift is detected by parsing this against the
 * committed baseline and deep-equal comparing the trees, NOT by string equality,
 * so pure serialization noise (indentation, quote style, mapping-key order,
 * trailing whitespace) in a re-run or hand-edited baseline is not mistaken for a
 * semantic change. See {@link a11yTreeChanged}.
 */
async function captureA11yTree(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot();
}

/**
 * True when two aria snapshots describe DIFFERENT accessibility trees. Both
 * sides are parsed with the `yaml` package and deep-equal compared, so only a
 * genuine tree change reads as drift: a different role, accessible name/label,
 * added or removed node, or a reordering of siblings (list order is significant
 * and preserved by the parse, so a real reading-order change still counts). What
 * it deliberately ignores is serialization noise that `YAML.parse` normalizes
 * away, indentation, quote style, mapping-key order, trailing whitespace, none
 * of which changes the tree.
 *
 * A byte-identical fast path short-circuits the common unchanged case (two runs
 * of the same page). Parse errors are NOT swallowed: `actual` is produced by our
 * own {@link captureA11yTree}, so a parse failure there is a real capture bug,
 * and a malformed committed baseline is worth surfacing loudly rather than
 * silently reading as "unchanged". Either throws.
 */
function a11yTreeChanged(baseline: string, actual: string): boolean {
  if (baseline === actual) return false;
  return !isDeepStrictEqual(parseYaml(baseline), parseYaml(actual));
}

function baseResultFor(
  actionName: string,
  parameters: Record<string, string>,
  breakpoint: string,
  startedAt: Date,
): ActionResult {
  return {
    action: actionName,
    parameters,
    breakpoint,
    status: 'pass',
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
  };
}

function successResultWithoutScreenshot(
  action: Action,
  parameters: Record<string, string>,
  breakpoint: string,
  startedAt: Date,
): ActionResult {
  const finishedAt = new Date();
  return {
    action: action.action,
    parameters,
    breakpoint,
    status: 'pass',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

function failedResult(
  action: Action,
  parameters: Record<string, string>,
  breakpoint: string,
  startedAt: Date,
  failedIndex: number,
  error: unknown,
): ActionResult {
  const finishedAt = new Date();
  return {
    action: action.action,
    parameters,
    breakpoint,
    status: 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    failedStepIndex: failedIndex,
    failureMessage: error instanceof Error ? error.message : String(error),
  };
}

function finishResult(
  base: ActionResult,
  overrides: Partial<ActionResult> & { status: ActionStatus },
): ActionResult {
  const finishedAt = new Date();
  return {
    ...base,
    ...overrides,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - new Date(base.startedAt).getTime(),
  };
}

function validateParameters(
  action: Action,
  parameters: Record<string, string>,
): void {
  const declared = new Set(action.parameters ?? []);
  for (const key of Object.keys(parameters)) {
    if (!declared.has(key)) {
      throw new Error(
        `Action "${action.action}" received unknown parameter "${key}"`,
      );
    }
  }
  for (const required of declared) {
    if (parameters[required] === undefined) {
      throw new Error(
        `Action "${action.action}" is missing parameter "${required}"`,
      );
    }
  }
}

export class ExpectationTimedOutError extends Error {
  readonly expectation: NonNullable<Action['expect']>;
  readonly innerError: unknown;
  constructor(
    expectation: NonNullable<Action['expect']>,
    innerError: unknown,
    timeoutMs: number,
  ) {
    const summary = expectation.anyOf
      .map((hint) => JSON.stringify(hint))
      .join(', ');
    super(
      `expect.anyOf did not resolve within ${timeoutMs}ms (candidates: ${summary})`,
    );
    this.name = 'ExpectationTimedOutError';
    this.expectation = expectation;
    this.innerError = innerError;
  }
}
