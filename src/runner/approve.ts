import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { copyToBaseline } from '../screenshots/baselineStore.ts';
import { parseRunResult } from '../schema/result.ts';
import type { ActionResult } from '../schema/result.ts';
import { pathExists } from '../util.ts';
import { storyMatchesFilter } from './storyFilter.ts';

export interface ApproveOptions {
  storyFilter?: string;
  /**
   * When `true`, only promote actions whose status is `new` (i.e. baselines
   * that don't exist yet). Actions with status `changed` are counted as
   * skipped. Lets users baseline newly-introduced stories without accepting
   * drift on existing baselines.
   */
  newOnly?: boolean;
}

export interface ApproveSummary {
  approved: number;
  skipped: number;
}

/**
 * Reads `<report>/results.json` from the previous run and promotes every
 * `changed` or `new` action's actual screenshot to its baseline. The
 * accessibility-tree snapshot (`a11y.yaml`) is promoted alongside the PNG
 * so the a11y baseline stays in lock-step with the visual one. Optional
 * `storyFilter` limits the approval to one story file. Optional `newOnly`
 * limits promotion to `new` actions, leaving `changed` baselines untouched.
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
      if (!isApprovable(action, options.newOnly === true)) {
        skipped += 1;
        continue;
      }
      await copyToBaseline(action.actualPath, action.baselinePath);
      if (
        action.a11yActualPath &&
        action.a11yBaselinePath &&
        (await pathExists(action.a11yActualPath))
      ) {
        await copyToBaseline(action.a11yActualPath, action.a11yBaselinePath);
      }
      approved += 1;
      process.stdout.write(`  approved ${action.action}\n`);
    }
  }
  return { approved, skipped };
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
