import { readFile } from 'node:fs/promises';
import type { StoryFile } from '../schema/load.ts';

export interface FlowCoverage {
  total: number;
  covered: number;
  ratio: number;
  missing: string[];
}

/**
 * Compares the journeys catalogued in the consumer's `flowInventory`
 * markdown table with the stories under the configured `stories/`
 * directory. A story is counted as covering a journey when its `flow`
 * field matches a journey row (case- and whitespace-insensitive).
 *
 * Returns 1.0 coverage when no inventory was configured or the file
 * cannot be read, so a fresh checkout without an inventory does not
 * break the report.
 */
export async function computeFlowCoverage(
  inventoryPath: string | undefined,
  stories: StoryFile[],
): Promise<FlowCoverage> {
  if (!inventoryPath) {
    return { total: 0, covered: 0, ratio: 1, missing: [] };
  }
  let raw: string;
  try {
    raw = await readFile(inventoryPath, 'utf8');
  } catch {
    return { total: 0, covered: 0, ratio: 1, missing: [] };
  }
  const journeys = parseJourneyTable(raw);
  const claimed = new Set(
    stories
      .map((entry) => entry.story.flow)
      .filter((flow): flow is string => typeof flow === 'string')
      .map((flow) => normalise(flow)),
  );
  const missing: string[] = [];
  for (const journey of journeys) {
    if (!claimed.has(normalise(journey))) {
      missing.push(journey);
    }
  }
  const total = journeys.length;
  const covered = total - missing.length;
  return {
    total,
    covered,
    ratio: total === 0 ? 1 : covered / total,
    missing,
  };
}

/**
 * Pulls the first column of every body row from the first markdown table
 * in the document. Skips the header row and the dash separator row. The
 * inventory contains one row per journey, so this is the journey list.
 */
function parseJourneyTable(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const journeys: string[] = [];
  let insideTable = false;
  let skippedHeaderAndSeparator = 0;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (insideTable) break;
      continue;
    }
    insideTable = true;
    if (skippedHeaderAndSeparator < 2) {
      skippedHeaderAndSeparator += 1;
      continue;
    }
    const firstCell = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)[0];
    if (firstCell) {
      journeys.push(firstCell);
    }
  }
  return journeys;
}

function normalise(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}
