import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageMetric } from '../schema/result.ts';

const SCREENS_SUBDIR = 'screens';

/**
 * Walks every `visit-*.json` action under `<actions>/screens/` and reports how
 * many have a baseline screenshot at `<baselineRoot>/<action-name>/0.png`. The
 * action name is taken from the filename (minus the `.json` suffix), which by
 * convention matches the action's declared `action` field.
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
    const baseline = join(baselineRoot, name, '0.png');
    try {
      await access(baseline);
    } catch {
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
