import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunMode } from './mode.ts';
import type { DeletedBaseline, RunResult } from '../schema/result.ts';

/**
 * A11y companion suffix for a breakpoint-keyed baseline PNG. `<action>/<bp>.png`
 * carries `<action>/<bp>.a11y.yaml` beside it (see `baselineStore.pathsFor`).
 * Exported so `approve --from` derives the same companion filename from the
 * shared constant instead of re-literalling the suffix at its own producer/
 * consumer boundary.
 */
export const A11Y_SUFFIX = '.a11y.yaml';

/**
 * Pre-breakpoint (legacy) baseline files: a project baselined before the
 * per-breakpoint layout committed `<action>/0.png` + `<action>/a11y.yaml`. The
 * scan keys these under the synthetic breakpoint name `'legacy'` so a prune step
 * can delete them without re-deriving the layout. Exported so `approve --from`
 * shares the same legacy-layout literals rather than re-declaring them.
 */
export const LEGACY_PNG = '0.png';
export const LEGACY_A11Y = 'a11y.yaml';
export const LEGACY_BREAKPOINT = 'legacy';

/**
 * Non-action files that may sit at the baselines root and must never be treated
 * as orphan candidates. `manifest.json` (the environment manifest, wave 6) is
 * the known one; it is a file, not an action directory, so the readdir walk
 * already skips it by virtue of only descending into directories. This set is a
 * belt-and-suspenders guard for any future flat file a sibling wave drops here.
 */
const NON_ACTION_ENTRIES = new Set(['manifest.json']);

/**
 * Whether the orphan scan should run for this invocation. Two gates, both
 * must hold:
 *   - CI mode only. Local runs never read `paths.baselines` (they self-diff
 *     against the per-machine cache), so there is no committed set to orphan.
 *   - Unfiltered runs only. A `--story` filter runs a deliberate subset, so
 *     every unselected story's baseline would look orphaned when it is merely
 *     unvisited; a filtered run must never mark a live baseline `deleted`.
 *
 * Kept pure and separate from `run.ts` so the CI/local × filtered/unfiltered
 * matrix is unit-testable without launching a browser.
 */
export function shouldScanForOrphans(
  mode: RunMode,
  storyFilter: string | undefined,
): boolean {
  return mode === 'ci' && storyFilter === undefined;
}

/**
 * The distinct set of action names that ran at least one result this run. An
 * action directory under `paths.baselines` whose name is absent from this set
 * had no story compare against it. It is a candidate orphan. Derived from the
 * flat `stories[].actions[]` walk so `skipped` entries (an earlier step failed)
 * still count the action as executed: the baseline was reachable this run, the
 * story simply broke before reaching it, which is a failure to surface, not a
 * baseline to retire.
 */
export function executedActionNames(
  stories: RunResult['stories'],
): Set<string> {
  const names = new Set<string>();
  for (const story of stories) {
    for (const action of story.actions) {
      names.add(action.action);
    }
  }
  return names;
}

/**
 * Scans `baselinesDir` for orphaned committed baselines: action directories no
 * story executed this run. Detection only. The returned entries carry the
 * absolute paths a later `approve --prune` deletes; this function never touches
 * the filesystem beyond reading directory listings.
 *
 * Caller contract (enforced in `run.ts`, documented here so the module reads
 * standalone): only meaningful for an UNFILTERED CI run. A `--story`-filtered run
 * executes a deliberate subset, so every unselected story's baseline would look
 * orphaned; the caller skips the scan entirely on a filtered run rather than
 * mark live baselines `deleted`. Local mode never reads `paths.baselines` at all,
 * so it never calls this.
 *
 * Layout handled (mirrors `baselineStore.pathsFor`):
 *   - breakpoint-keyed  `<action>/<breakpoint>.png` (+ `.a11y.yaml` companion)
 *   - legacy            `<action>/0.png` (+ `a11y.yaml` companion)
 *
 * One {@link DeletedBaseline} per orphaned breakpoint (or the single `'legacy'`
 * group), each bundling the PNG with its a11y companion when present. Files that
 * are neither a recognised PNG nor a matching companion are ignored, so a stray
 * file in an orphaned dir neither crashes the scan nor smuggles an untracked
 * path into the prune list.
 */
export async function scanOrphanedBaselines(
  baselinesDir: string,
  executed: Set<string>,
): Promise<DeletedBaseline[]> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const dirents = await readdir(baselinesDir, { withFileTypes: true });
    entries = dirents.map((dirent) => ({
      name: dirent.name,
      isDir: dirent.isDirectory(),
    }));
  } catch {
    // No baselines directory yet (a never-approved project), nothing to orphan.
    return [];
  }

  const orphans: DeletedBaseline[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDir) continue;
    if (NON_ACTION_ENTRIES.has(entry.name)) continue;
    if (executed.has(entry.name)) continue;

    const actionDir = join(baselinesDir, entry.name);
    orphans.push(...(await scanOrphanedActionDir(entry.name, actionDir)));
  }
  return orphans;
}

/**
 * Groups one orphaned action directory's baseline files into per-breakpoint
 * {@link DeletedBaseline} entries. Each PNG anchors a group; its a11y companion
 * (breakpoint-keyed `<bp>.a11y.yaml`, or legacy `a11y.yaml`) joins the same group
 * when it exists on disk. Files matching neither shape are skipped.
 */
async function scanOrphanedActionDir(
  action: string,
  actionDir: string,
): Promise<DeletedBaseline[]> {
  let files: string[];
  try {
    files = await readdir(actionDir);
  } catch {
    return [];
  }
  const present = new Set(files);
  const groups: DeletedBaseline[] = [];

  for (const file of files.slice().sort()) {
    if (file === LEGACY_PNG) {
      const paths = [join(actionDir, LEGACY_PNG)];
      if (present.has(LEGACY_A11Y)) paths.push(join(actionDir, LEGACY_A11Y));
      groups.push({
        action,
        breakpoint: LEGACY_BREAKPOINT,
        baselinePaths: paths,
      });
      continue;
    }
    if (file.endsWith('.png')) {
      const breakpoint = file.slice(0, -'.png'.length);
      const companion = `${breakpoint}${A11Y_SUFFIX}`;
      const paths = [join(actionDir, file)];
      if (present.has(companion)) paths.push(join(actionDir, companion));
      groups.push({ action, breakpoint, baselinePaths: paths });
    }
  }
  return groups;
}
