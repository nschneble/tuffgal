import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedConfig } from '../config.ts';
import { normalisedNeeds } from '../schema/story.ts';
import type { StoryFile } from '../schema/load.ts';

export interface ScheduledStory extends StoryFile {
  needs: string[];
  produces: string[];
}

/**
 * Validates that every produced label is emitted by at most one story and
 * that every `needs` label is satisfiable: either a scheduled story
 * `produces` it, or the project declared it in `config.seededLabels` AND
 * `<paths.authState>/<label>.json` exists for `resolveStorageStateForNeeds` to
 * load. Both halves are required, because neither alone separates a deliberate
 * seed from residue: a bare file can be what a renamed or deleted producer left
 * behind, and a bare declaration can name a file nobody ever wrote. Throws a
 * descriptive error on any mismatch so a typo in a JSON file fails loudly at
 * load time, not at run time.
 */
export function buildSchedule(
  stories: StoryFile[],
  config: ResolvedConfig,
): ScheduledStory[] {
  const scheduled: ScheduledStory[] = stories.map((entry) => ({
    ...entry,
    needs: normalisedNeeds(entry.story),
    produces: entry.story.produces ?? [],
  }));

  const producerByLabel = new Map<string, string>();
  for (const item of scheduled) {
    for (const label of item.produces) {
      const previous = producerByLabel.get(label);
      if (previous !== undefined) {
        throw new SchedulerError(
          `Label "${label}" is produced by both ${previous} and ${item.file}. Labels must be unique.`,
        );
      }
      producerByLabel.set(label, item.file);
    }
  }

  const declaredSeeds = new Set(config.seededLabels);
  for (const item of scheduled) {
    for (const label of item.needs) {
      if (producerByLabel.has(label)) {
        continue;
      }
      // A declared pre-seeded storage state stands in for a producer: the run
      // reads <authState>/<label>.json instead of rendering the story that
      // would have written it. An undeclared label is indistinguishable from a
      // typo, whether or not some file happens to sit at that path.
      const seedPath = join(config.paths.authState, `${label}.json`);
      if (!declaredSeeds.has(label)) {
        throw new SchedulerError(
          `${item.file} needs label "${label}" but no story produces it and ` +
            `it is not listed in \`seededLabels\`. Add a story that produces ` +
            `it, or declare the label and seed ${seedPath}.`,
        );
      }
      if (!existsSync(seedPath)) {
        throw new SchedulerError(
          `${item.file} needs label "${label}", declared in \`seededLabels\`, ` +
            `but no storage state exists at ${seedPath}. Seed it before ` +
            `\`tuffgal run\`.`,
        );
      }
    }
  }

  detectCycles(scheduled, producerByLabel);
  return scheduled;
}

function detectCycles(
  scheduled: ScheduledStory[],
  producerByLabel: Map<string, string>,
): void {
  const byFile = new Map(scheduled.map((entry) => [entry.file, entry]));
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const visit = (file: string): void => {
    if (onStack.has(file)) {
      throw new SchedulerError(
        `Cycle detected in story dependencies involving ${file}`,
      );
    }
    if (visited.has(file)) {
      return;
    }
    onStack.add(file);
    const item = byFile.get(file);
    if (item) {
      for (const label of item.needs) {
        const upstream = producerByLabel.get(label);
        if (upstream && upstream !== file) {
          visit(upstream);
        }
      }
    }
    onStack.delete(file);
    visited.add(file);
  };
  for (const item of scheduled) {
    visit(item.file);
  }
}

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}
