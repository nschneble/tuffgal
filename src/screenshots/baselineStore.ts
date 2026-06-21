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
  /**
   * Pre-breakpoint baseline location (`<action>/0.png`). Populated so a caller
   * that finds no breakpoint-keyed baseline can fall back to a project's
   * legacy committed baseline instead of declaring every action `new`. Read
   * fallback only — the runner reads `baseline` first, then `legacyBaseline`;
   * promotion always writes the breakpoint-keyed `baseline`, never this. See
   * the read-order note below.
   */
  legacyBaseline: string;
  /** Pre-breakpoint a11y baseline (`<action>/a11y.yaml`); see `legacyBaseline`. */
  legacyA11yBaseline: string;
}

export interface StoreOptions {
  baselinesDir: string;
  reportDir: string;
  storyFile: string;
  actionName: string;
  /**
   * Named breakpoint (`mobile`/`desktop`/…) this capture renders at. Every
   * returned path is keyed by it so two breakpoints of the same action never
   * collide on disk.
   */
  breakpoint: string;
}

/**
 * Reduces an arbitrary breakpoint name to a filesystem-safe path segment.
 * Breakpoint names are simple lowercase identifiers today (`mobile`, `desktop`,
 * the synthetic `viewport`), but they reach here as plain strings, so we guard
 * against anything a future config could supply: lowercase, then collapse every
 * character outside `[a-z0-9_-]` to `-`. Deterministic so the runner and
 * `approve` derive byte-identical paths from the same name.
 */
function breakpointSegment(breakpoint: string): string {
  return breakpoint.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/**
 * Computes deterministic paths for the baseline (committed), actual
 * (regenerated each run), and diff (regenerated when a baseline existed and
 * the diff was non-zero) PNGs. Centralised so the runner and the CLI's
 * `approve` command agree on layout.
 *
 * Every path is keyed by both action name and breakpoint so per-breakpoint
 * captures of the same action stay isolated: baselines nest the breakpoint as a
 * filename under the action directory (`<action>/<breakpoint>.png`), while
 * report-side artifacts splice it into the filename
 * (`<action>.<breakpoint>.actual.png`) since they already share one per-story
 * directory.
 */
export function pathsFor(options: StoreOptions): BaselinePaths {
  const storySlug = options.storyFile.replace(/\.json$/i, '');
  const bp = breakpointSegment(options.breakpoint);
  return {
    baseline: join(options.baselinesDir, options.actionName, `${bp}.png`),
    actual: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.${bp}.actual.png`,
    ),
    diff: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.${bp}.diff.png`,
    ),
    a11yBaseline: join(
      options.baselinesDir,
      options.actionName,
      `${bp}.a11y.yaml`,
    ),
    a11yActual: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.${bp}.a11y.yaml`,
    ),
    // Pre-breakpoint locations. A project baselined before this feature has
    // its only committed snapshot here; the runner reads `baseline` first and
    // falls back to these when the breakpoint-keyed file is absent, so existing
    // baselines keep matching instead of all reading as `new`.
    legacyBaseline: join(options.baselinesDir, options.actionName, '0.png'),
    legacyA11yBaseline: join(
      options.baselinesDir,
      options.actionName,
      'a11y.yaml',
    ),
  };
}

/**
 * Per-path serialization for baseline creation. A baseline is keyed on action
 * name *and* breakpoint (see `pathsFor` — the breakpoint is part of the
 * filename), so when the same action+breakpoint runs in two stories
 * concurrently (`workers > 1`, fresh run), both would otherwise read "no
 * baseline" and race to write the same `<breakpoint>.png` — a torn or
 * last-writer-wins file. Callers wrap their read-then-maybe-write critical
 * section in this lock so exactly one writer per baseline path runs at a time;
 * later callers see the baseline the first writer produced. The map is keyed by
 * path, so distinct actions — and now distinct breakpoints of the same action,
 * whose baseline paths differ — never block each other; entries are bounded by
 * action count times breakpoint count.
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
