import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export interface BaselinePaths {
  baseline: string;
  actual: string;
  diff: string;
  a11yBaseline: string;
  a11yActual: string;
}

export interface StoreOptions {
  baselinesDir: string;
  reportDir: string;
  storyFile: string;
  actionName: string;
}

/**
 * Computes deterministic paths for the baseline (committed), actual
 * (regenerated each run), and diff (regenerated when a baseline existed and
 * the diff was non-zero) PNGs. Centralised so the runner and the CLI's
 * `approve` command agree on layout.
 */
export function pathsFor(options: StoreOptions): BaselinePaths {
  const storySlug = options.storyFile.replace(/\.json$/i, '');
  return {
    baseline: join(options.baselinesDir, options.actionName, '0.png'),
    actual: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.actual.png`,
    ),
    diff: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.diff.png`,
    ),
    a11yBaseline: join(options.baselinesDir, options.actionName, 'a11y.yaml'),
    a11yActual: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.a11y.yaml`,
    ),
  };
}

/**
 * Per-path serialization for baseline creation. A baseline is keyed only on
 * action name (see `pathsFor`), so when the same action runs in two stories
 * concurrently (`workers > 1`, fresh run), both would otherwise read "no
 * baseline" and race to write the same `0.png` — a torn or last-writer-wins
 * file. Callers wrap their read-then-maybe-write critical section in this lock
 * so exactly one writer per baseline path runs at a time; later callers see the
 * baseline the first writer produced. The map is keyed by path, so distinct
 * actions never block each other; entries are bounded by the action count.
 */
const baselineLocks = new Map<string, Promise<void>>();

export function withBaselineLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = baselineLocks.get(key) ?? Promise.resolve();
  // Run `fn` only after the prior holder settles, regardless of its outcome.
  const run = previous.then(fn, fn);
  // Tail used purely for sequencing; swallow its result/rejection so a failed
  // critical section never poisons the next caller in the chain.
  baselineLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function readBaseline(path: string): Promise<Buffer | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  return readFile(path);
}

export async function readJsonBaseline(
  path: string,
): Promise<string | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  return readFile(path, 'utf8');
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function writePng(path: string, png: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
}

export async function deleteIfExists(path: string): Promise<void> {
  try {
    await rm(path);
  } catch {
    // file was not there; nothing to do
  }
}

export async function copyToBaseline(
  actualPath: string,
  baselinePath: string,
): Promise<void> {
  await mkdir(dirname(baselinePath), { recursive: true });
  await copyFile(actualPath, baselinePath);
}

/**
 * Turns an absolute screenshot path into a path that is relative to the
 * generated report directory so the HTML report can reference it with a
 * portable `src` attribute.
 */
export function pathRelativeToReport(
  reportDir: string,
  absolute: string,
): string {
  return relative(reportDir, absolute);
}
