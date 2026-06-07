import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { copyToBaseline } from '../screenshots/baselineStore.ts';
import type { ActionResult, RunResult } from '../schema/result.ts';
import { storyMatchesFilter } from './storyFilter.ts';

export interface ApproveOptions {
  storyFilter?: string;
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
 * `storyFilter` limits the approval to one story file.
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
  const result = JSON.parse(raw) as RunResult;
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
      if (!isApprovable(action)) {
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

function isApprovable(action: ActionResult): action is ApprovableAction {
  if (action.status !== 'changed' && action.status !== 'new') {
    return false;
  }
  return Boolean(action.actualPath && action.baselinePath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
