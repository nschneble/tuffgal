import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type { ResolvedBreakpoint, ResolvedConfig } from '../config.ts';
import type { Action } from '../schema/action.ts';
import type { Story } from '../schema/story.ts';
import type {
  ActionResult,
  StoryResult,
  StoryStatus,
} from '../schema/result.ts';
import { applyFixture } from './bridges/database.ts';
import type { CoverageCollector } from './coverage.ts';
import { runAction } from './runAction.ts';

export interface RunStoryOptions {
  story: Story;
  file: string;
  needs: string[];
  produces: string[];
  actions: Map<string, Action>;
  config: ResolvedConfig;
  headed: boolean;
  coverage?: CoverageCollector;
}

const TRACE_SUBDIR = 'traces';

/**
 * Drives one story end-to-end on a freshly launched browser. Wraps the
 * context in Playwright tracing so a failed action leaves behind a
 * full-fidelity `trace.zip` for post-mortem in the Playwright trace viewer.
 * If the story declares `produces` labels, the post-run storage state is
 * persisted under `<authState>/<label>.json` so consumer stories can attach
 * to it without replaying the producer's actions.
 */
export async function runStory(options: RunStoryOptions): Promise<StoryResult> {
  const startedAt = new Date();
  for (const fixture of options.story.fixtures ?? []) {
    await applyFixture(options.config, fixture);
  }
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    return await runStoryWithBrowser(browser, options, startedAt);
  } finally {
    await browser.close();
  }
}

/**
 * Drives every selected breakpoint of one story against an already-launched
 * browser. Split out from `runStory` (which owns browser lifecycle + fixtures)
 * so tests can exercise the per-breakpoint loop — context isolation, the
 * failed-action-does-not-abort-others guarantee, trace-zip uniqueness, `produces`
 * persistence, and the throw-closes-context invariant — against fake
 * Browser/BrowserContext/Page objects without launching a real Chromium.
 */
export async function runStoryWithBrowser(
  browser: Browser,
  options: RunStoryOptions,
  startedAt: Date,
): Promise<StoryResult> {
  const { story, file, needs, produces, config, coverage } = options;
  // Resolve the storage state once: it is viewport-independent, so every
  // breakpoint context loads the same `needs` auth payload.
  const storageStatePath = await resolveStorageStateForNeeds(config, needs);
  const runSet = resolveRunSet(story, config);

  const results: ActionResult[] = [];
  // The story's status is the worst outcome across every breakpoint it ran at:
  // failed if any breakpoint had a failed/skipped action, else changed if any
  // breakpoint drifted or introduced a new baseline, else pass.
  let storyStatus: StoryStatus = 'pass';
  // `produces` writes the post-run storage state exactly once — from the first
  // breakpoint whose action sequence did not fail. Persisting per breakpoint
  // would redundantly rewrite (and risk clobbering) the same `<label>.json`
  // with state that is identical for auth purposes; one good run is enough.
  let producedPersisted = false;
  // Trace zips collected from the breakpoints that failed. We keep only one in
  // the StoryResult (the first failing breakpoint) since the result carries a
  // single `tracePath`, but each failing breakpoint still writes its own
  // uniquely-named zip so none overwrite each other on disk.
  let firstTracePath: string | undefined;

  for (const breakpoint of runSet) {
    const context = await browser.newContext({
      baseURL: config.baseUrl,
      viewport: { width: breakpoint.width, height: breakpoint.height },
      storageState: storageStatePath,
      ignoreHTTPSErrors: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    // The whole per-breakpoint lifecycle runs under try/finally so the context
    // is ALWAYS closed, even when something inside throws. Throw policy: an
    // *action* failing is a normal visual-regression outcome — it returns a
    // `failed` ActionResult, the loop records it, and the remaining breakpoints
    // still run (the documented "one breakpoint failing does not abort the
    // others" guarantee). A *thrown* exception here is different: it means the
    // harness itself faulted (tracing/coverage threw, the page crashed, an
    // unexpected error escaped `runActionsForBreakpoint`). That is not a diff to
    // report — it is an infra fault, so we let it propagate and abort the whole
    // story. The `finally` guarantees we still close this context first, so a
    // throw can never leak the in-flight BrowserContext (the bug this guards).
    try {
      context.setDefaultTimeout(config.defaultTimeoutMs);
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
        title: `${file} (${breakpoint.name})`,
      });
      const page = await context.newPage();
      await page.clock.install({ time: config.frozenTime });
      if (coverage) {
        await coverage.startForPage(page);
      }

      const breakpointRun = await runActionsForBreakpoint(
        page,
        breakpoint.name,
        options,
      );
      results.push(...breakpointRun.results);
      storyStatus = mergeStoryStatus(storyStatus, breakpointRun.status);

      if (coverage) {
        await coverage.stopForPage(page);
      }
      const tracePath = await stopTracing(
        context,
        config,
        file,
        breakpoint.name,
        breakpointRun.status,
      );
      if (tracePath && firstTracePath === undefined) {
        firstTracePath = tracePath;
      }
      // Persist once, from the first breakpoint that ran clean. A failure in
      // this breakpoint does not abort the loop — the remaining breakpoints
      // still run so the report shows every mode — but it cannot supply the
      // auth state.
      if (
        !producedPersisted &&
        breakpointRun.status !== 'failed' &&
        produces.length > 0
      ) {
        await persistProducedAuthState(context, config, produces);
        producedPersisted = true;
      }
    } finally {
      await context.close();
    }
  }

  const finishedAt = new Date();
  return {
    story: story.story,
    file,
    status: storyStatus,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    actions: results,
    tracePath: firstTracePath,
  };
}

/**
 * Picks the breakpoint(s) this story runs at. A per-story `viewport` override
 * is an explicit, pre-breakpoints escape hatch: honour it as a single run
 * under the synthetic name `viewport` so legacy stories render exactly as they
 * did before this feature — we do not multiply a story that pinned its own
 * viewport across the project's breakpoint matrix. Otherwise the story runs at
 * every configured breakpoint, in order.
 */
export function resolveRunSet(
  story: Story,
  config: ResolvedConfig,
): ResolvedBreakpoint[] {
  if (story.viewport) {
    return [{ name: 'viewport', ...story.viewport }];
  }
  return config.breakpoints;
}

/**
 * Folds one breakpoint's outcome into the running story status, keeping the
 * worst: any `failed` wins; otherwise any `changed` wins; otherwise `pass`.
 */
export function mergeStoryStatus(
  current: StoryStatus,
  next: StoryStatus,
): StoryStatus {
  if (current === 'failed' || next === 'failed') {
    return 'failed';
  }
  if (current === 'changed' || next === 'changed') {
    return 'changed';
  }
  return 'pass';
}

interface BreakpointRun {
  results: ActionResult[];
  status: StoryStatus;
}

/**
 * Runs every action of the story once, in order, against a single breakpoint's
 * page. Preserves the existing within-breakpoint fail-fast: once an action
 * fails (or names an unknown action), the remaining actions of THIS breakpoint
 * are skipped — we never screenshot state that follows a broken step. The
 * returned status is scoped to this breakpoint; the caller merges it into the
 * story-wide status across all breakpoints.
 */
async function runActionsForBreakpoint(
  page: Page,
  breakpoint: string,
  options: RunStoryOptions,
): Promise<BreakpointRun> {
  const { story, file, actions, config } = options;
  const results: ActionResult[] = [];
  let status: StoryStatus = 'pass';

  for (const storyStep of story.actions) {
    const action = actions.get(storyStep.action);
    if (!action) {
      results.push(
        skipped(
          storyStep.action,
          breakpoint,
          'unknown action',
          storyStep.parameters,
        ),
      );
      status = 'failed';
      continue;
    }
    if (status === 'failed') {
      results.push(
        skipped(
          storyStep.action,
          breakpoint,
          'earlier action failed',
          storyStep.parameters,
        ),
      );
      continue;
    }
    const result = await runAction({
      page,
      action,
      parameters: storyStep.parameters ?? {},
      storyFile: file,
      config,
      breakpoint,
    });
    results.push(result);
    if (result.status === 'failed') {
      status = 'failed';
    } else if (result.status === 'changed' || result.status === 'new') {
      if (status === 'pass') {
        status = 'changed';
      }
    }
  }

  return { results, status };
}

/**
 * Stops Playwright tracing for one breakpoint's context. Writes the zip to
 * `<report>/traces/<story>.<breakpoint>.zip` when that breakpoint failed
 * (debugging payload); discards on success to keep the report directory small.
 * The breakpoint is part of the filename so two breakpoints of the same story
 * that both fail leave distinct zips instead of the second overwriting the
 * first. Failure-only remains the cheap default.
 */
async function stopTracing(
  context: BrowserContext,
  config: ResolvedConfig,
  storyFile: string,
  breakpoint: string,
  breakpointStatus: StoryStatus,
): Promise<string | undefined> {
  if (breakpointStatus !== 'failed') {
    await context.tracing.stop();
    return undefined;
  }
  const traceDirectory = join(config.paths.report, TRACE_SUBDIR);
  await mkdir(traceDirectory, { recursive: true });
  const slug = storyFile.replace(/\.json$/i, '');
  const tracePath = join(traceDirectory, `${slug}.${breakpoint}.zip`);
  await context.tracing.stop({ path: tracePath });
  return tracePath;
}

async function resolveStorageStateForNeeds(
  config: ResolvedConfig,
  needs: string[],
): Promise<string | undefined> {
  for (const label of needs) {
    const path = join(config.paths.authState, `${label}.json`);
    try {
      await access(path);
      return path;
    } catch {
      // Producer ran but did not emit a storage state file. That is fine
      // when the label only carries an ordering constraint, not an auth
      // payload — fall through to the next label.
    }
  }
  return undefined;
}

async function persistProducedAuthState(
  context: BrowserContext,
  config: ResolvedConfig,
  produces: string[],
): Promise<void> {
  await mkdir(config.paths.authState, { recursive: true });
  for (const label of produces) {
    const path = join(config.paths.authState, `${label}.json`);
    await context.storageState({ path });
  }
}

function skipped(
  actionName: string,
  breakpoint: string,
  reason: string,
  parameters?: Record<string, string>,
): ActionResult {
  const now = new Date().toISOString();
  return {
    action: actionName,
    breakpoint,
    status: 'skipped',
    parameters,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    failureMessage: reason,
  };
}
