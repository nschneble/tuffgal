import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ResolvedConfig } from '../config.ts';
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

async function runStoryWithBrowser(
  browser: Browser,
  options: RunStoryOptions,
  startedAt: Date,
): Promise<StoryResult> {
  const { story, file, needs, produces, actions, config, coverage } = options;
  const storageStatePath = await resolveStorageStateForNeeds(config, needs);
  const context = await browser.newContext({
    baseURL: config.baseUrl,
    viewport: config.viewport,
    storageState: storageStatePath,
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(config.defaultTimeoutMs);
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
    title: file,
  });
  const page = await context.newPage();
  await page.clock.install({ time: config.frozenTime });
  if (coverage) {
    await coverage.startForPage(page);
  }

  const results: ActionResult[] = [];
  let storyStatus: StoryStatus = 'pass';

  for (const storyStep of story.actions) {
    const action = actions.get(storyStep.action);
    if (!action) {
      results.push(skipped(storyStep.action, 'unknown action'));
      storyStatus = 'failed';
      continue;
    }
    if (storyStatus === 'failed') {
      results.push(skipped(storyStep.action, 'earlier action failed'));
      continue;
    }
    const result = await runAction({
      page,
      action,
      parameters: storyStep.parameters ?? {},
      storyFile: file,
      config,
    });
    results.push(result);
    if (result.status === 'failed') {
      storyStatus = 'failed';
    } else if (result.status === 'changed' || result.status === 'new') {
      if (storyStatus === 'pass') {
        storyStatus = 'changed';
      }
    }
  }

  if (coverage) {
    await coverage.stopForPage(page);
  }
  const tracePath = await stopTracing(context, config, file, storyStatus);
  if (storyStatus !== 'failed' && produces.length > 0) {
    await persistProducedAuthState(context, config, produces);
  }
  await context.close();

  const finishedAt = new Date();
  return {
    story: story.story,
    file,
    status: storyStatus,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    actions: results,
    tracePath,
  };
}

/**
 * Stops Playwright tracing. Writes the zip to `<report>/traces/<story>.zip`
 * when the story failed (debugging payload); discards on success to keep
 * the report directory small. Stories that need traces on every run can be
 * tweaked here later — for now failure-only is the cheap default.
 */
async function stopTracing(
  context: BrowserContext,
  config: ResolvedConfig,
  storyFile: string,
  storyStatus: StoryStatus,
): Promise<string | undefined> {
  if (storyStatus !== 'failed') {
    await context.tracing.stop();
    return undefined;
  }
  const traceDirectory = join(config.paths.report, TRACE_SUBDIR);
  await mkdir(traceDirectory, { recursive: true });
  const tracePath = join(
    traceDirectory,
    `${storyFile.replace(/\.json$/i, '')}.zip`,
  );
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

function skipped(actionName: string, reason: string): ActionResult {
  const now = new Date().toISOString();
  return {
    action: actionName,
    status: 'skipped',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    failureMessage: reason,
  };
}
