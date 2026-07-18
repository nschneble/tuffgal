import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageMetric } from '../schema/result.ts';

const SCREENS_SUBDIR = 'screens';

/**
 * Walks every `visit-*.json` action under `<actions>/screens/` and reports how
 * many have at least one baseline screenshot under
 * `<baselineRoot>/<action-name>/`. The runner keys baselines by breakpoint
 * (`<breakpoint>.png`, e.g. `desktop.png`) and a project baselined before that
 * feature keeps a single legacy `0.png`; either counts, so a screen is covered
 * when its action directory holds any `.png` file (non-PNG siblings such as the
 * `<breakpoint>.a11y.yaml` snapshots are ignored). The action name is taken from
 * the filename (minus the `.json` suffix), which by convention matches the
 * action's declared `action` field.
 *
 * `baselineRoot` is the set the run compares against: committed `paths.baselines`
 * in CI mode, the per-machine `paths.localCache` in local mode (the caller — see
 * `coverageComparisonRoot` — picks it by mode so a local run never reads
 * `paths.baselines`). The metric's meaning is the same either way: how many
 * screens have a baseline to diff against.
 */
export async function computeScreenCoverage(
  actionsDir: string,
  baselineRoot: string,
): Promise<CoverageMetric> {
  const screensRoot = join(actionsDir, SCREENS_SUBDIR);
  let entries: string[] = [];
  try {
    entries = await readdir(screensRoot);
  } catch {
    return { total: 0, covered: 0, ratio: 1, missing: [] };
  }
  const screenNames = entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/i, ''))
    .sort();
  const missing: string[] = [];
  for (const name of screenNames) {
    const actionDir = join(baselineRoot, name);
    let hasBaseline = false;
    try {
      const baselineFiles = await readdir(actionDir);
      hasBaseline = baselineFiles.some((file) =>
        file.toLowerCase().endsWith('.png'),
      );
    } catch {
      hasBaseline = false;
    }
    if (!hasBaseline) {
      missing.push(name);
    }
  }
  const total = screenNames.length;
  const covered = total - missing.length;
  return {
    total,
    covered,
    ratio: total === 0 ? 1 : covered / total,
    missing,
  };
}
