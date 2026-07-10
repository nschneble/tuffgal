import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { ResolvedBreakpoint, ResolvedConfig } from '../config.ts';
import type { Action } from '../schema/action.ts';
import type {
  EnvironmentReport,
  RunResult,
  StoryResult,
  StoryStatus,
} from '../schema/result.ts';
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
import { mergeStoryStatus, runStory } from './runStory.ts';
import {
  buildSchedule,
  drainSchedule,
  type ScheduledStory,
} from './scheduler.ts';
import {
  adaptNeedsForPass,
  mergeStoryResults,
  resolveBreakpointPasses,
  storyRendersAt,
} from './breakpointPasses.ts';
import { storyMatchesFilter } from './storyFilter.ts';
import { candidatesDir } from '../screenshots/baselineStore.ts';
import {
  executedActionNames,
  scanOrphanedBaselines,
  shouldScanForOrphans,
} from './orphanScan.ts';
import { comparisonRootFor, type RunMode } from './mode.ts';
import {
  captureEnvironment,
  compareEnvironment,
  readManifest,
  type CapturedBrowser,
  type EnvironmentManifest,
} from './manifest.ts';
import type { DeletedBaseline } from '../schema/result.ts';

export interface RunCliOptions {
  storyFilter?: string;
  headed: boolean;
  workers?: number;
  manageServers?: boolean;
  coverage?: boolean;
  /**
   * Resolved comparison contract (see {@link RunMode}). Governs baseline-write
   * vs candidate-write in `runAction` and the run's exit-code derivation. The
   * CLI always supplies it (resolved from `--ci`/`--local`/`$CI`); it stays
   * optional so existing programmatic callers keep compiling, defaulting to
   * `local` (the legacy auto-write behaviour) when omitted.
   */
  mode?: RunMode;
}

/** One Summary bullet's data: a breakpoint name and that pass's own counts. */
interface PassSummary {
  name: string;
  counts: RunResult['totals'];
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
  const mode: RunMode = options.mode ?? 'local';
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
    const passes = resolveBreakpointPasses(subset, config);
    const multiPass = passes.length > 1;
    process.stdout.write(
      `Scheduling ${subset.length} stories on ${workerCount} worker${workerCount === 1 ? '' : 's'}` +
        (multiPass ? ` across ${passes.length} breakpoint passes` : '') +
        '.\n',
    );

    // Run each breakpoint as its own pass: a full reset/seed, then the whole
    // schedule rendered at that one breakpoint. This is what keeps breakpoints
    // isolated — a destructive story can mutate the seeded database in the
    // `mobile` pass without the `desktop` pass ever seeing it, because the next
    // pass starts from a fresh reset. Results are merged back per story below.
    const partsByFile = new Map<string, StoryResult[]>();
    const order: string[] = [];
    const passSummaries: PassSummary[] = [];
    for (const breakpoint of passes) {
      const participating = subset.filter((item) =>
        storyRendersAt(item, config, breakpoint),
      );
      if (participating.length === 0) continue;
      // Header for every pass — single- and multi-breakpoint alike. The reset
      // sits beneath the header so the "fresh database" line reads as part of
      // this pass's setup; a trailing blank line then separates setup from the
      // streaming result lines.
      process.stdout.write(
        `\nStarting "${breakpoint.name}" breakpoint pass at ${breakpoint.width}x${breakpoint.height}\n`,
      );
      if (config.database?.reset) {
        process.stdout.write('Resetting test database…\n');
        await resetDatabase(config);
      }
      process.stdout.write('\n');
      const passResults = await drainSchedule(
        adaptNeedsForPass(participating),
        workerCount,
        (item) =>
          runScheduledStory(
            item,
            actions,
            config,
            options.headed,
            coverage,
            breakpoint,
            mode,
          ),
        () => {},
        (_item, result) =>
          process.stdout.write(
            `${formatResultLine(result.status, result.actions.length, result.durationMs, result.file)}\n`,
          ),
      );
      passSummaries.push({
        name: breakpoint.name,
        counts: summarise(passResults),
      });
      for (const result of passResults) {
        let parts = partsByFile.get(result.file);
        if (!parts) {
          parts = [];
          partsByFile.set(result.file, parts);
          order.push(result.file);
        }
        parts.push(result);
      }
    }
    const results = order.map((file) =>
      mergeStoryResults(partsByFile.get(file)!),
    );

    const finishedAt = new Date();
    // Screen coverage measures how many screens have a baseline in the set this
    // run compares against — the committed `paths.baselines` in CI mode, the
    // per-machine `paths.localCache` in local mode. Local runs never read
    // `paths.baselines` (PRD invariant). Both the metric and `runAction` pick
    // their root through the shared `comparisonRootFor`, so the metric measures
    // against the exact set the run diffed against; its meaning ("screens with a
    // baseline to diff against") is preserved rather than blanked.
    const [screens, flows] = await Promise.all([
      computeScreenCoverage(
        config.paths.actions,
        coverageComparisonRoot(config, mode),
      ),
      computeFlowCoverage(config.flowInventory, allStories),
    ]);
    // Orphan scan: committed baselines whose action ran no story this run are
    // retired candidates (status `deleted`). Only meaningful for an UNFILTERED
    // CI run — a `--story` filter runs a deliberate subset, so unselected
    // stories' baselines would look orphaned when they are merely unvisited; we
    // skip the scan rather than mark live baselines deleted. Local mode never
    // reads `paths.baselines`, so it never scans. Detection only — pruning is a
    // later wave, so the baselines directory stays untouched here.
    const deleted: DeletedBaseline[] = shouldScanForOrphans(
      mode,
      options.storyFilter,
    )
      ? await scanOrphanedBaselines(
          config.paths.baselines,
          executedActionNames(results),
        )
      : [];
    const totals = summarise(results);
    totals.deleted = deleted.length;
    // Capture-environment provenance: what this run rendered under, and — in CI
    // mode — whether it drifted from the committed baselines' manifest. Local
    // mode never reads `paths.baselines`, so `expected` stays null and mismatch
    // is always false (see resolveEnvironmentReport).
    const environment = await resolveEnvironmentReport(config, mode);
    const runResult: RunResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      mode,
      totals,
      environment,
      customCoverage: { screens, flows },
      deleted,
      stories: results,
    };
    const reportPath = await writeReport(
      config.paths.report,
      runResult,
      config.interactiveMode,
    );
    // In CI mode the `<report>/candidates/` tree is the self-contained approval
    // artifact — copy the run's `results.json` beside the candidate renders so a
    // downstream `approve --from <candidates>` has the outcome data (which
    // actions are new/changed, and later the environment/deleted blocks) without
    // needing the rest of the report dir. Only meaningful in CI mode, where the
    // candidate tree exists.
    if (mode === 'ci') {
      await copyResultsIntoCandidates(config.paths.report);
    }
    writeRunSummary(passSummaries, reportPath);
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
  breakpoint: ResolvedBreakpoint,
  mode: RunMode,
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
    breakpoint,
    mode,
  });
}

function matchesFilter(item: ScheduledStory, filter: string): boolean {
  return storyMatchesFilter(
    { file: item.file, storyName: item.story.story },
    filter,
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

/**
 * Copies the just-written `results.json` into `<report>/candidates/` so the
 * candidate tree is a self-contained approval artifact. `writeReport` has
 * already written `<report>/results.json`; this places a sibling copy under
 * candidates. The candidates dir may not exist yet (a run where every action
 * passed writes no candidate renders), so it is created first — an empty
 * `candidates/` carrying only `results.json` still correctly describes "nothing
 * to approve".
 */
export async function copyResultsIntoCandidates(
  reportDir: string,
): Promise<void> {
  const dir = candidatesDir(reportDir);
  await mkdir(dir, { recursive: true });
  await copyFile(join(reportDir, 'results.json'), join(dir, 'results.json'));
}

/**
 * The baseline root the screen-coverage metric measures against: committed
 * `paths.baselines` in CI mode, per-machine `paths.localCache` in local mode.
 * A thin, coverage-named alias over the shared {@link comparisonRootFor} so the
 * metric counts screens against the SAME set the run (via `runAction`) diffed
 * against — the mode→root mapping now lives once, in `mode.ts`. Preserved as a
 * named export because the coverage metric's PRD invariant (a local run never
 * reads `paths.baselines`) reads most clearly against a coverage-specific name.
 */
export function coverageComparisonRoot(
  config: ResolvedConfig,
  mode: RunMode,
): string {
  return comparisonRootFor(config, mode);
}

/**
 * Reads the launched Chromium's `browser.version()` so the run's environment
 * manifest records the exact browser build the baselines were rendered against —
 * the single pixel-affecting fact that only a live browser can report. Launched
 * throwaway (not the per-story browsers, which spin up and tear down inside the
 * schedule) because the version is invariant across stories, so one probe covers
 * the whole run. Kept narrow: launch, read, close.
 */
async function captureBrowserIdentity(): Promise<CapturedBrowser> {
  const browser = await chromium.launch({ headless: true });
  try {
    return { name: 'chromium', version: browser.version() };
  } finally {
    await browser.close();
  }
}

/**
 * The browser identity stamped into a LOCAL run's environment block. Local mode
 * skips the live probe (see {@link resolveEnvironmentReport}), so `version` is an
 * empty sentinel: it is shape-valid for the manifest, never compared (local
 * `expected` is always null), and never promoted (local candidates are refused
 * by `approve --from`). Kept as chromium's name for provenance, since that is
 * still the browser a local run renders under.
 */
const LOCAL_BROWSER_IDENTITY = { name: 'chromium', version: '' } as const;

/**
 * Builds the run's {@link EnvironmentReport}: the environment this run captured
 * under (`actual`), and — in CI mode — the committed `<baselines>/manifest.json`
 * (`expected`) plus whether their pixel-affecting keys diverge.
 *
 * The live browser-version probe ({@link captureBrowserIdentity}) runs in CI
 * mode ONLY. Local mode never reads `paths.baselines`, so `expected` is always
 * `null` and `browserVersion` is never compared against anything — launching a
 * throwaway chromium just to stamp a value nothing reads is pure cost, so local
 * mode fills the browser identity with an empty sentinel and skips the probe.
 *
 * In CI mode a missing manifest is the bootstrap case (no expectation yet, no
 * mismatch); a malformed one surfaces as a mismatch note (see
 * {@link compareEnvironment}). `expected` carries the parsed manifest only when
 * it read cleanly, so a malformed file reports `null` here while still driving a
 * mismatch.
 *
 * `probe` is the live browser-identity reader, injected (defaulting to the real
 * {@link captureBrowserIdentity}) so a test can assert it is invoked in CI mode
 * and NEVER invoked in local mode without launching a real chromium.
 */
export async function resolveEnvironmentReport(
  config: ResolvedConfig,
  mode: RunMode,
  probe: () => Promise<CapturedBrowser> = captureBrowserIdentity,
): Promise<EnvironmentReport> {
  if (mode !== 'ci') {
    // Local mode never gates on `browserVersion` (expected is always null), so
    // skip the browser launch entirely. The empty sentinel is shape-valid and
    // never promoted — a local run writes no candidate tree, and `approve --from`
    // refuses non-ci candidates outright.
    const actual = captureEnvironment(config, LOCAL_BROWSER_IDENTITY);
    return { expected: null, actual, mismatch: false, mismatchKeys: [] };
  }
  const actual = captureEnvironment(config, await probe());
  const read = await readManifest(config.paths.baselines);
  const { mismatch, mismatchKeys } = compareEnvironment(read, actual);
  const expected: EnvironmentManifest | null =
    read.status === 'ok' ? read.manifest : null;
  return { expected, actual, mismatch, mismatchKeys };
}

/**
 * Rolls a set of story results into the outcome counts. `deleted` counts
 * orphaned baselines, which are a run-level detection (not a per-story outcome),
 * so it always seeds `0` here; `runAll` overwrites the run-total `deleted` from
 * the orphan scan. Per-breakpoint pass summaries keep `0`, which is correct —
 * an orphan is not attributable to a single breakpoint pass.
 */
export function summarise(results: StoryResult[]): RunResult['totals'] {
  return {
    stories: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    changed: results.filter((result) => result.status === 'changed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    new: results.filter((result) => result.status === 'new').length,
    deleted: 0,
  };
}

/** Status → leading glyph for a streaming result line. */
const STATUS_SYMBOL: Record<StoryStatus, string> = {
  pass: '✓',
  changed: '~',
  new: '+',
  failed: '✗',
};

/**
 * One streaming finish line: `<symbol> <actionCount> <elapsed>s <stem>`. The
 * count is how many steps the story ran, the elapsed time is wall-clock
 * duration to hundredths of a second, and the stem is the story file without
 * its `.json` extension.
 */
export function formatResultLine(
  status: StoryStatus,
  actionCount: number,
  durationMs: number,
  file: string,
): string {
  const elapsed = (durationMs / 1000).toFixed(2);
  const stem = file.replace(/\.json$/, '');
  return `${STATUS_SYMBOL[status]} ${actionCount} ${elapsed}s ${stem}`;
}

/**
 * One Summary bullet for a breakpoint pass: `• <parts> on "<name>" breakpoint`,
 * where `<parts>` joins only the nonzero outcome categories in a fixed order
 * (passed, new, changed, failed) — e.g. `2 passed, 1 changed`. Falls back to
 * `0 passed` for the degenerate all-zero pass the run loop never actually
 * emits (it `continue`s past a pass with no participating stories).
 */
export function formatSummaryBullet(
  name: string,
  counts: RunResult['totals'],
): string {
  const parts: string[] = [];
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.new > 0) parts.push(`${counts.new} new`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  const summary = parts.length > 0 ? parts.join(', ') : '0 passed';
  return `• ${summary} on "${name}" breakpoint`;
}

/**
 * Emits the end-of-run tail: a `Summary` section with one bullet per breakpoint
 * pass — counted from that pass's own results, not the merged-across-passes
 * rollup — then the `Report:` line. The report link is a `file://` URL so
 * terminals that recognise file URIs (iTerm2, Warp, VS Code) render it as a
 * clickable link.
 */
function writeRunSummary(
  passSummaries: PassSummary[],
  reportPath: string,
): void {
  process.stdout.write('\nSummary\n');
  for (const pass of passSummaries) {
    process.stdout.write(`${formatSummaryBullet(pass.name, pass.counts)}\n`);
  }
  process.stdout.write(`\nReport: ${pathToFileURL(reportPath).href}\n`);
}

/**
 * The breakpoint names that drove a merged story to its status — the modes the
 * reader actually needs to inspect. A `changed` story that drifted only at
 * `desktop` tags `[desktop]`, not the `mobile` pass that stayed clean. Returns
 * empty (no tag) when the story spans a single breakpoint, since there is
 * nothing to disambiguate. The merged actions still carry their `breakpoint`
 * tag, so this is derived, not separately tracked.
 */
export function drivingBreakpoints(result: StoryResult): string[] {
  const order: string[] = [];
  const perBreakpoint = new Map<string, StoryStatus>();
  for (const action of result.actions) {
    const breakpoint = action.breakpoint;
    if (!breakpoint) continue;
    if (!perBreakpoint.has(breakpoint)) {
      perBreakpoint.set(breakpoint, 'pass');
      order.push(breakpoint);
    }
    perBreakpoint.set(
      breakpoint,
      mergeStoryStatus(
        perBreakpoint.get(breakpoint)!,
        // A skipped action means an earlier action in that breakpoint failed.
        action.status === 'skipped' ? 'failed' : action.status,
      ),
    );
  }
  if (order.length <= 1) return [];
  return order.filter(
    (breakpoint) => perBreakpoint.get(breakpoint) === result.status,
  );
}
