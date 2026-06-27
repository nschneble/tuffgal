import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../schema/result.ts';
import { renderReport } from './template.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const ASSETS_SOURCE_DIR = join(moduleDir, 'assets');

/**
 * Writes the HTML report, the static CSS/JS assets, and the raw `results.json`
 * to the configured report directory. The JSON file is what `tuffgal approve`
 * reads to locate actuals that should be promoted to baselines.
 */
export async function writeReport(
  reportDir: string,
  result: RunResult,
  interactiveMode: boolean,
): Promise<string> {
  await mkdir(join(reportDir, 'assets'), { recursive: true });
  const html = renderReport(result, reportDir, interactiveMode);
  const htmlPath = join(reportDir, 'index.html');
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(
    join(reportDir, 'results.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  await copyFile(
    join(ASSETS_SOURCE_DIR, 'report.css'),
    join(reportDir, 'assets', 'report.css'),
  );
  await copyFile(
    join(ASSETS_SOURCE_DIR, 'report.js'),
    join(reportDir, 'assets', 'report.js'),
  );
  return htmlPath;
}
