import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { copyRecompressedPng } from '../screenshots/baselineStore.ts';
import { parseRunResult } from '../schema/result.ts';
import type { ActionResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import { storyMatchesFilter } from './storyFilter.ts';

export interface ApproveOptions {
  storyFilter?: string;
  /**
   * When `true`, only refresh actions whose status is `new` (i.e. cache entries
   * that don't exist yet). Actions with status `changed` are counted as
   * skipped. Lets users cache newly-introduced stories without accepting drift
   * on existing cache entries.
   */
  newOnly?: boolean;
  /**
   * When non-empty, only refresh actions whose `breakpoint` is in this set
   * (matched by mode name, e.g. `desktop`). Lets a reviewer accept a drift at
   * one viewport without touching the others. Empty/undefined approves every
   * breakpoint. Composes with `storyFilter` and `newOnly` as an AND filter.
   */
  breakpoints?: string[];
}

export interface ApproveSummary {
  approved: number;
  skipped: number;
}

/**
 * `approve` is dual-mode. Plain `approve` (this module, {@link approveAll})
 * refreshes the local per-machine comparison cache (`paths.localCache`) from the
 * last run's `<report>/results.json`. Advisory. It never writes committed
 * baselines. The other half, `approve --from <dir>` (`approveFrom`), promotes a
 * CI candidate tree into the committed `paths.baselines` set and lives in its
 * own module (`approveFrom.ts`), since the two commands share no code beyond the
 * `copyRecompressedPng` helper.
 */

/**
 * Reads `<report>/results.json` from the previous run and refreshes the local
 * comparison cache with every `changed` or `new` action's actual screenshot.
 * The accessibility-tree snapshot (`a11y.yaml`) travels alongside the PNG so
 * the cached a11y baseline stays in lock-step with the visual one. The optional
 * filters, `storyFilter` (one story), `breakpoints` (named modes), and
 * `newOnly` (new not changed), compose as an AND: an action is refreshed only
 * when it clears every filter that was supplied.
 *
 * This command targets `paths.localCache` ONLY. It never writes the committed
 * `paths.baselines` set. Those are owned by CI and written solely through the
 * approval flow (`approve --from`, a later wave). Each recorded baseline path is
 * re-rooted onto `paths.localCache`, keeping its `<action>/<file>` tail, so a
 * plain `approve` refreshes the cache regardless of which mode produced the run
 * (the recorded root may be the cache or, for an older CI run's results, the
 * committed baselines dir, either way the copy lands in the cache).
 */
export async function approveAll(
  config: ResolvedConfig,
  options: ApproveOptions,
): Promise<ApproveSummary> {
  const resultsPath = join(config.paths.report, 'results.json');
  const raw = await readFile(resultsPath, 'utf8').catch(() => {
    throw new Error(
      `No prior run found at ${resultsPath}. Run \`tuffgal run\` first.`,
    );
  });
  const result = parseRunResult(raw, resultsPath);
  // An empty/undefined breakpoint list means "every breakpoint"; otherwise only
  // actions tagged with one of these mode names are eligible.
  const breakpointFilter =
    options.breakpoints && options.breakpoints.length > 0
      ? new Set(options.breakpoints)
      : undefined;
  let approved = 0;
  let skipped = 0;
  for (const story of result.stories) {
    if (
      options.storyFilter &&
      !storyMatchesFilter(
        { file: story.file, storyName: story.story },
        options.storyFilter,
      )
    ) {
      continue;
    }
    for (const action of story.actions) {
      if (
        breakpointFilter &&
        (action.breakpoint === undefined ||
          !breakpointFilter.has(action.breakpoint))
      ) {
        skipped += 1;
        continue;
      }
      if (!isApprovable(action, options.newOnly === true)) {
        skipped += 1;
        continue;
      }
      await copyRecompressedPng(
        action.actualPath,
        cacheDestination(config, action.baselinePath),
      );
      if (
        action.a11yActualPath &&
        action.a11yBaselinePath &&
        (await pathExists(action.a11yActualPath))
      ) {
        await copyRecompressedPng(
          action.a11yActualPath,
          cacheDestination(config, action.a11yBaselinePath),
        );
      }
      approved += 1;
      process.stdout.write(`  approved ${action.action}\n`);
    }
  }
  return { approved, skipped };
}

/**
 * Re-roots a recorded baseline path onto `paths.localCache`, preserving its
 * trailing `<action>/<file>` layout. Every baseline path `pathsFor` emits is
 * exactly `<root>/<action>/<file>` (action names are validated lowercase-kebab
 * with no slashes), so keeping the last two segments and re-joining under the
 * cache is a mode-agnostic remap: it lands the copy in the cache whether the
 * run recorded a cache-rooted path (local mode) or a baselines-rooted one (an
 * older CI run's results). The committed `paths.baselines` set is never a
 * destination here.
 */
function cacheDestination(
  config: ResolvedConfig,
  baselinePath: string,
): string {
  const actionDir = basename(dirname(baselinePath));
  const file = basename(baselinePath);
  return join(config.paths.localCache, actionDir, file);
}

type ApprovableAction = ActionResult & {
  actualPath: string;
  baselinePath: string;
};

function isApprovable(
  action: ActionResult,
  newOnly: boolean,
): action is ApprovableAction {
  if (action.status !== 'changed' && action.status !== 'new') {
    return false;
  }
  if (newOnly && action.status === 'changed') {
    return false;
  }
  return Boolean(action.actualPath && action.baselinePath);
}
