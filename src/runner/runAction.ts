import type { Locator, Page } from 'playwright';
import type { Action, Hint, Step } from '../schema/action.ts';
import type { ActionResult, ActionStatus } from '../schema/result.ts';
import type { ResolvedConfig } from '../config.ts';
import { capturePage } from '../screenshots/capture.ts';
import { diffPngs, ScreenshotSizeMismatchError } from '../screenshots/diff.ts';
import {
  deleteIfExists,
  pathsFor,
  readBaseline,
  readJsonBaseline,
  writePng,
  writeText,
} from '../screenshots/baselineStore.ts';
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
  const { action, page, parameters, storyFile, config } = options;
  validateParameters(action, parameters);
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
        parameters,
        config,
        attempts,
        backoffMs,
      );
    } catch (error) {
      return failedResult(action, parameters, startedAt, index, error);
    }
  }

  if (action.expect) {
    try {
      await waitForExpectation(page, action.expect, parameters);
    } catch (error) {
      return failedResult(
        action,
        parameters,
        startedAt,
        action.steps.length,
        error,
      );
    }
  }

  if (action.screenshot === false) {
    return successResultWithoutScreenshot(action, parameters, startedAt);
  }

  return captureAndCompare({
    action,
    page,
    parameters,
    config,
    storyFile,
    startedAt,
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
      if (!(error instanceof LocatorNotFoundError) || attempt === attempts) {
        throw error;
      }
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

async function dispatch(
  page: Page,
  step: Step,
  parameters: Record<string, string>,
  config: ResolvedConfig,
): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      return runNavigate(page, interpolate(step.path, parameters), config);
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
 * Race semantics: any single match satisfies the expectation — this is what
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
  parameters: Record<string, string>;
  config: ResolvedConfig;
  storyFile: string;
  startedAt: Date;
}

async function captureAndCompare(
  options: CaptureOptions,
): Promise<ActionResult> {
  const { action, page, parameters, config, storyFile, startedAt } = options;
  const paths = pathsFor({
    baselinesDir: config.paths.baselines,
    reportDir: config.paths.report,
    storyFile,
    actionName: action.action,
  });
  const masks = resolveMasks(page, action.mask, parameters);
  const actualPng = await capturePage(page, masks);
  await writePng(paths.actual, actualPng);
  const a11yJson = await captureA11yTree(page);
  await writeText(paths.a11yActual, a11yJson);

  const baselinePng = await readBaseline(paths.baseline);
  const baselineA11y = await readJsonBaseline(paths.a11yBaseline);
  const baseResult = baseResultFor(action.action, parameters, startedAt);

  if (baselinePng === undefined) {
    await writePng(paths.baseline, actualPng);
    await writeText(paths.a11yBaseline, a11yJson);
    return finishResult(baseResult, {
      status: 'new',
      baselinePath: paths.baseline,
      actualPath: paths.actual,
      a11yBaselinePath: paths.a11yBaseline,
      a11yActualPath: paths.a11yActual,
    });
  }

  const a11yChanged = baselineA11y !== undefined && baselineA11y !== a11yJson;

  try {
    const pixelThreshold = action.diff?.pixelThreshold ?? 0.1;
    const ssimThreshold = action.diff?.ssimThreshold ?? 0.99;
    const outcome = diffPngs(baselinePng, actualPng, pixelThreshold);
    const passesSsim = outcome.ssimScore >= ssimThreshold;
    if (passesSsim) {
      await deleteIfExists(paths.diff);
      return finishResult(baseResult, {
        status: 'pass',
        baselinePath: paths.baseline,
        actualPath: paths.actual,
        diffPixels: outcome.diffPixels,
        diffRatio: outcome.diffRatio,
        ssimScore: outcome.ssimScore,
        a11yChanged: a11yChanged || undefined,
        a11yBaselinePath: paths.a11yBaseline,
        a11yActualPath: paths.a11yActual,
      });
    }
    await writePng(paths.diff, outcome.diffPng);
    return finishResult(baseResult, {
      status: 'changed',
      baselinePath: paths.baseline,
      actualPath: paths.actual,
      diffPath: paths.diff,
      diffPixels: outcome.diffPixels,
      diffRatio: outcome.diffRatio,
      ssimScore: outcome.ssimScore,
      a11yChanged: a11yChanged || undefined,
      a11yBaselinePath: paths.a11yBaseline,
      a11yActualPath: paths.a11yActual,
    });
  } catch (error) {
    if (error instanceof ScreenshotSizeMismatchError) {
      return finishResult(baseResult, {
        status: 'changed',
        baselinePath: paths.baseline,
        actualPath: paths.actual,
        failureMessage: error.message,
        a11yBaselinePath: paths.a11yBaseline,
        a11yActualPath: paths.a11yActual,
      });
    }
    throw error;
  }
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
 * Snapshots the page's accessibility tree as a YAML-shaped string. Two
 * runs of the same page produce byte-identical output so a simple string
 * comparison detects semantic changes (button label, role, structure)
 * without flagging visual-only drift.
 */
async function captureA11yTree(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot();
}

function baseResultFor(
  actionName: string,
  parameters: Record<string, string>,
  startedAt: Date,
): ActionResult {
  return {
    action: actionName,
    parameters,
    status: 'pass',
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
  };
}

function successResultWithoutScreenshot(
  action: Action,
  parameters: Record<string, string>,
  startedAt: Date,
): ActionResult {
  const finishedAt = new Date();
  return {
    action: action.action,
    parameters,
    status: 'pass',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

function failedResult(
  action: Action,
  parameters: Record<string, string>,
  startedAt: Date,
  failedIndex: number,
  error: unknown,
): ActionResult {
  const finishedAt = new Date();
  return {
    action: action.action,
    parameters,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
