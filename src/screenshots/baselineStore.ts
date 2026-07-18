import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PNG } from 'pngjs';

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
   * fallback only. The runner reads `baseline` first, then `legacyBaseline`;
   * promotion always writes the breakpoint-keyed `baseline`, never this. See
   * the read-order note below.
   */
  legacyBaseline: string;
  /** Pre-breakpoint a11y baseline (`<action>/a11y.yaml`); see `legacyBaseline`. */
  legacyA11yBaseline: string;
  /**
   * Proposed-new-baseline PNG for CI mode, under
   * `<report>/candidates/<action>/<breakpoint>.png`. Mirrors the `baseline`
   * layout exactly (action dir + breakpoint filename) so approving a candidate
   * set is a plain tree copy into `paths.baselines`. Always report-rooted,
   * never affected by the comparison root, which only moves the baseline side.
   */
  candidate: string;
  /** Candidate a11y snapshot (`<report>/candidates/<action>/<breakpoint>.a11y.yaml`). */
  a11yCandidate: string;
}

export interface StoreOptions {
  baselinesDir: string;
  /**
   * Root the baseline-side paths (`baseline`, `a11yBaseline`, and the two
   * `legacy*` fallbacks) resolve under. Defaults to `baselinesDir`, so an
   * omitted root reproduces the committed-baselines layout byte-for-byte, the
   * zero-behaviour-change default. Local mode passes the per-machine cache dir
   * here to self-diff against it instead. Report-side artifacts (actual, diff,
   * candidate, a11yActual, a11yCandidate) ignore this and stay report-rooted.
   */
  comparisonRoot?: string;
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
 * Breakpoint names are simple lowercase identifiers today (`mobile`, `tablet`,
 * `laptop`, `desktop`), but they reach here as plain strings, so we guard
 * against anything a future config could supply: lowercase, then collapse every
 * character outside `[a-z0-9_-]` to `-`. Deterministic so the runner and
 * `approve` derive byte-identical paths from the same name.
 */
function breakpointSegment(breakpoint: string): string {
  return breakpoint.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/**
 * The single owner of the `<report>/candidates/` path. The runner writes the
 * candidate tree + a `results.json` copy here, and `approve --from` reads that
 * same tree back. Centralised so the literal `'candidates'` segment has one
 * definition instead of drifting across the runner, the store, and approve.
 */
export function candidatesDir(reportDir: string): string {
  return join(reportDir, 'candidates');
}

/**
 * The action-name shape the action schema enforces (`/^[a-z0-9-]+$/`,
 * lowercase-kebab). Re-exported here so the trust boundary in `approve --from`
 * can reject a directory name from an untrusted candidate artifact against the
 * exact same invariant the runner produced its layout under, without importing
 * the zod schema. Kept in lock-step with `schema/action.ts` by intent.
 */
export const ACTION_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * The filesystem-safe breakpoint segment shape (`/^[a-z0-9_-]+$/`) that {@link
 * breakpointSegment} emits. `approve --from` validates a candidate PNG's
 * breakpoint stem against this so a name outside the runner's own output shape
 * (path separators, dots, traversal) can never reach a write.
 */
export const BREAKPOINT_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Computes deterministic paths for the baseline (the comparison target:
 * committed baselines by default, or the local cache when `comparisonRoot` is
 * supplied), actual (regenerated each run), diff (regenerated when a baseline
 * existed and the diff was non-zero), and candidate (proposed-new-baseline for
 * CI approval) PNGs. Centralised so the runner and the CLI's `approve` command
 * agree on layout.
 *
 * Every path is keyed by both action name and breakpoint so per-breakpoint
 * captures of the same action stay isolated: baseline- and candidate-side paths
 * nest the breakpoint as a filename under the action directory
 * (`<action>/<breakpoint>.png`), while report-side actual/diff artifacts splice
 * it into the filename (`<action>.<breakpoint>.actual.png`) since they already
 * share one per-story directory.
 *
 * The baseline side resolves under `comparisonRoot` (default `baselinesDir`), so
 * omitting the root reproduces the committed-baselines layout unchanged; the
 * candidate and report-side paths are always report-rooted and ignore it.
 */
export function pathsFor(options: StoreOptions): BaselinePaths {
  const storySlug = options.storyFile.replace(/\.json$/i, '');
  const bp = breakpointSegment(options.breakpoint);
  const comparisonRoot = options.comparisonRoot ?? options.baselinesDir;
  return {
    baseline: join(comparisonRoot, options.actionName, `${bp}.png`),
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
    a11yBaseline: join(comparisonRoot, options.actionName, `${bp}.a11y.yaml`),
    a11yActual: join(
      options.reportDir,
      'screenshots',
      storySlug,
      `${options.actionName}.${bp}.a11y.yaml`,
    ),
    // Candidate tree mirrors the baseline layout under the report so a CI
    // approval is a plain copy of `<report>/candidates/` into `paths.baselines`.
    candidate: join(
      candidatesDir(options.reportDir),
      options.actionName,
      `${bp}.png`,
    ),
    a11yCandidate: join(
      candidatesDir(options.reportDir),
      options.actionName,
      `${bp}.a11y.yaml`,
    ),
    // Pre-breakpoint locations. A project baselined before this feature has
    // its only committed snapshot here; the runner reads `baseline` first and
    // falls back to these when the breakpoint-keyed file is absent, so existing
    // baselines keep matching instead of all reading as `new`. Rooted at the
    // comparison root like the breakpoint-keyed baseline above.
    legacyBaseline: join(comparisonRoot, options.actionName, '0.png'),
    legacyA11yBaseline: join(comparisonRoot, options.actionName, 'a11y.yaml'),
  };
}

/**
 * Per-path serialization for baseline creation. A baseline is keyed on action
 * name *and* breakpoint (see `pathsFor`, the breakpoint is part of the
 * filename), so when the same action+breakpoint runs in two stories
 * concurrently (`workers > 1`, fresh run), both would otherwise read "no
 * baseline" and race to write the same `<breakpoint>.png`, a torn or
 * last-writer-wins file. Callers wrap their read-then-maybe-write critical
 * section in this lock so exactly one writer per baseline path runs at a time;
 * later callers see the baseline the first writer produced. The map is keyed by
 * path, so distinct actions (and now distinct breakpoints of the same action,
 * whose baseline paths differ) never block each other; entries are bounded by
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

/**
 * Losslessly recompresses a PNG buffer. Playwright emits PNGs tuned for capture
 * speed, not size; re-encoding through pngjs applies its default
 * `deflateLevel: 9` plus adaptive per-scanline filtering (filter type chosen per
 * row from the full `[0..4]` set), which typically shrinks the file with zero
 * pixel change. The decode→re-encode round-trip is lossless: pngjs reads and
 * writes 8-bit RGBA, so the recompressed buffer decodes to a byte-identical
 * pixel array (`recompress.test.ts` asserts this).
 *
 * Two safety guarantees:
 *   - Never grows a file. A source that is already densely packed (e.g. a
 *     future oxipng-optimised baseline flowing through `approve --from`) can
 *     re-encode *larger*; in that case the original buffer is returned unchanged.
 *   - Never corrupts. Any decode/encode failure (a non-PNG buffer, a codec edge
 *     case) is swallowed and the original buffer is returned, so a recompress
 *     miss degrades to "write the bytes we were given" rather than a torn file.
 *
 * This is the lossless-recompress seam for the tool's DURABLE PNG writes:
 * {@link writeDurablePng} routes through it, so baseline, candidate, cache, and
 * promoted-baseline writes inherit it without per-callsite wiring. Transient
 * report artifacts (`actual`, `diff`) deliberately skip it via
 * {@link writeTransientPng}. The max-effort encode is wasted on a file that is
 * overwritten or deleted next run. Deterministic: pngjs's encoder is a pure
 * function of the pixel data and the fixed options above.
 *
 * Deliberately NOT palette-quantised and never lossy: colour type and bit depth
 * are preserved by the RGBA round-trip.
 */
export function recompressPng(png: Buffer): Buffer {
  let recompressed: Buffer;
  try {
    recompressed = PNG.sync.write(PNG.sync.read(png));
  } catch {
    // Not a decodable PNG, or an encoder edge case. Write what we were given
    // rather than risk emitting a corrupt or truncated file.
    return png;
  }
  // A recompress that grows the file is a loss, not a win. Keep the smaller.
  return recompressed.length < png.length ? recompressed : png;
}

/**
 * Shared write core: ensure the parent directory exists, then write the bytes
 * verbatim. The durable/transient split lives one level up. This only handles
 * the mkdir + write both share.
 */
async function writePngBytes(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/**
 * Writes a DURABLE PNG (a baseline, a candidate, or a promoted baseline) that
 * outlives the run and is re-read on every later comparison. These earn the
 * max-effort lossless recompress (see {@link recompressPng}): the level-9
 * deflate + adaptive per-scanline filtering is paid once at write, and every
 * subsequent read of the smaller file benefits.
 *
 * Transient report artifacts (the run's `actual`, the `diff` overlay) are
 * overwritten or deleted next run and must NOT pay this cost. They route
 * through {@link writeTransientPng}, which skips recompress entirely.
 */
export async function writeDurablePng(
  path: string,
  png: Buffer,
): Promise<void> {
  await writePngBytes(path, recompressPng(png));
}

/**
 * Writes a TRANSIENT PNG (the run's `actual` capture or the `diff` overlay)
 * verbatim, with NO recompress pass. These artifacts live only for the current
 * report: an `actual` is overwritten on the next run and a `diff` is deleted the
 * moment a comparison passes, so shrinking them with the expensive level-9
 * encode is wasted work. The `diff` overlay in particular arrives already
 * deflate-encoded by {@link renderDiffOverlay}'s `PNG.sync.write`, so a
 * recompress round-trip would only decode and re-encode it back to
 * near-identical bytes.
 *
 * Durable artifacts (baselines, candidates, promoted baselines) DO earn the
 * recompress and use {@link writeDurablePng}.
 */
export async function writeTransientPng(
  path: string,
  png: Buffer,
): Promise<void> {
  await writePngBytes(path, png);
}

export async function deleteIfExists(path: string): Promise<void> {
  try {
    await rm(path);
  } catch {
    // file was not there; nothing to do
  }
}

/**
 * Copies an already-written PNG (the run's `actual`, or a `candidate`) to a new
 * destination verbatim. No recompress here on purpose: the source is a durable
 * baseline produced by {@link writeDurablePng}, which already ran
 * `recompressPng`, so the bytes on disk are the recompressed ones. Copying them
 * forward keeps the destination losslessly recompressed for free. The only
 * non-test caller is `approve` refreshing the per-machine cache; `approve --from`
 * does NOT use this. It reads each source once during validation and writes the
 * retained buffer through {@link writeDurablePng}.
 */
export async function copyRecompressedPng(
  actualPath: string,
  destinationPath: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(actualPath, destinationPath);
}
