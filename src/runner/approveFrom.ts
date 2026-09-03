import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PNG } from 'pngjs';
import type { ResolvedConfig } from '../config.ts';
import {
  ACTION_NAME_PATTERN,
  BREAKPOINT_SEGMENT_PATTERN,
  readJsonBaseline,
  writeDurablePng,
  writeText,
} from '../screenshots/baselineStore.ts';
import {
  CAPTURE_SCHEMA,
  MANIFEST_FILENAME,
  SCHEMA_VERSION,
  validateManifestShape,
} from './manifest.ts';
import type { EnvironmentManifest } from './manifest.ts';
import {
  A11Y_SUFFIX,
  LEGACY_A11Y,
  LEGACY_BREAKPOINT,
  LEGACY_PNG,
} from './orphanScan.ts';
import {
  HISTORY_FILENAME,
  isHistoryStoreShape,
  readHistory,
  writeHistory,
  type HistoryStore,
} from './history.ts';
import { parseRunResult } from '../schema/result.ts';
import type { RunResult } from '../schema/result.ts';

// ---------------------------------------------------------------------------
// approve --from <dir>: CI candidate promotion into committed baselines.
// ---------------------------------------------------------------------------

export interface ApproveFromOptions {
  /** Absolute (or cwd-relative) path to the candidate tree to promote. */
  from: string;
  /**
   * When `true`, delete committed baseline entries the candidate run's
   * `results.json` recorded as orphaned (`results.deleted`). Prune targets are
   * always recomputed locally under `paths.baselines` from each entry's
   * `action`/`breakpoint`, never the artifact's own `baselinePaths[]` strings,
   * which describe another machine's filesystem.
   */
  prune?: boolean;
}

export interface ApproveFromSummary {
  /** Baseline PNG files written (a11y companions not counted). */
  written: number;
  /** Baseline file groups pruned (`--prune`); `0` without it. */
  pruned: number;
}

/** A single validated candidate file destined for `paths.baselines`. */
interface PlannedWrite {
  /** Absolute source path inside the candidate tree. */
  source: string;
  /** Absolute destination under `paths.baselines`, same relative layout. */
  destination: string;
  /** PNGs are decoded+re-encoded (recompress); yaml companions copied verbatim. */
  kind: 'png' | 'a11y';
  /**
   * The source's bytes, read ONCE during the validation phase and retained here.
   * Phase 2 writes exactly these bytes (it never re-reads `source`) so the
   * committed baseline is provably the same payload that passed validation (PNG
   * decode-check for `png`, verbatim copy for `a11y`). Closes the TOCTOU window
   * where a process with write access to the candidate tree could swap `source`
   * (for a symlink or a corrupt payload) between validation and commit. Candidate
   * trees are small (dozens of files, ~100s KB PNGs), so buffering every payload
   * in memory across the two phases is an accepted cost.
   */
  bytes: Buffer;
}

/**
 * Error thrown when the candidate tree fails a trust-boundary check. Carries no
 * extra data. The message is the whole contract. Distinct type so the CLI can
 * present it plainly; every throw here happens BEFORE any write, so the promise
 * rejecting guarantees `paths.baselines` was not touched.
 */
export class ApproveFromError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApproveFromError';
  }
}

/**
 * Promotes a CI candidate tree (`<dir>/<action>/<breakpoint>.png` + optional
 * `.a11y.yaml`, plus a top-level `results.json`) into the committed
 * `paths.baselines` set, and writes `<baselines>/manifest.json` from the
 * candidate run's captured environment.
 *
 * TRUST BOUNDARY. `<dir>` is an untrusted artifact. A human or bot unzipped it
 * from CI. This is the only path that writes committed baselines, so it is
 * fail-closed and validate-all-then-write:
 *   1. `results.json` must parse, describe a clean CI run (`mode: 'ci'` with
 *      `totals.failed === 0`, never promote a local or broken run's partial
 *      tree, see {@link assertPromotableRun}), and carry a well-shaped
 *      `environment.actual` block (validated against the manifest shape, not
 *      just present).
 *   2. Every tree entry is validated (allowed shape, safe names, no symlinks, no
 *      traversal) and every PNG is decoded to prove it is a real PNG.
 *   3. ONLY after the whole tree passes are any bytes written. A single bad
 *      entry aborts with {@link ApproveFromError} and zero filesystem changes.
 *
 * Every candidate file's bytes are read once during phase 1 and RETAINED for
 * phase 2, which writes exactly those bytes. The sources are never re-read, so
 * the committed baseline is provably the payload that passed validation (no
 * decode-swap / symlink-swap window between the check and the write).
 *
 * PNGs are written through {@link writeDurablePng} (decode→recompress→encode),
 * so the promoted baseline is losslessly recompressed and provably decodable in
 * one step, never a raw `copyFile` of unvalidated artifact bytes.
 */
export async function approveFrom(
  config: ResolvedConfig,
  options: ApproveFromOptions,
): Promise<ApproveFromSummary> {
  const candidateDir = options.from;
  await assertRealDirectory(candidateDir);

  // Phase 1: validate the whole tree and build a write plan. Every source is
  // read exactly ONCE here and its bytes are retained on the plan; no writes yet.
  const result = await readCandidateResults(candidateDir);
  assertPromotableRun(result);
  const environment = extractEnvironment(result);
  const history = await extractHistory(candidateDir);
  const plan = await planWrites(candidateDir, config.paths.baselines);
  await assertAllPngsDecode(plan);
  const pruneTargets = options.prune
    ? computePruneTargets(result, config.paths.baselines)
    : [];

  // Phase 2: every check passed; commit the RETAINED bytes. Nothing is re-read
  // from the candidate tree here, so the bytes committed are exactly the bytes
  // that were validated (no decode-swap / symlink-swap window).
  for (const write of plan) {
    if (write.kind === 'png') {
      await writeDurablePng(write.destination, write.bytes);
    } else {
      await writeText(write.destination, write.bytes.toString('utf8'));
    }
  }
  await writeManifest(config.paths.baselines, environment);
  if (history) {
    // Merge, don't overwrite: an out-of-order approval whose candidate never
    // touched some action must not drop that action's already-promoted
    // series. The candidate's own entries win per key (they're already the
    // up-to-date, capped series for what THIS run touched); every other
    // key's committed history passes through untouched.
    const target = join(config.paths.baselines, HISTORY_FILENAME);
    const committed = await readHistory(target);
    await writeHistory(target, { ...committed, ...history });
  }

  let pruned = 0;
  for (const group of pruneTargets) {
    for (const path of group) {
      await rm(path, { force: true });
    }
    pruned += 1;
  }

  return {
    written: plan.filter((write) => write.kind === 'png').length,
    pruned,
  };
}

/** Aborts unless `dir` exists and is a real directory (not a symlink). */
async function assertRealDirectory(dir: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(dir);
  } catch {
    throw new ApproveFromError(`--from directory not found: ${dir}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ApproveFromError(`--from path is a symlink, refusing: ${dir}`);
  }
  if (!stats.isDirectory()) {
    throw new ApproveFromError(`--from path is not a directory: ${dir}`);
  }
}

/**
 * Reads + parses `<dir>/results.json`. Absence is a hard error: the candidate
 * artifact is incomplete without it (prune targets and the environment manifest
 * both come from here).
 */
async function readCandidateResults(dir: string): Promise<RunResult> {
  const resultsPath = join(dir, 'results.json');
  let raw: string;
  try {
    raw = await readFile(resultsPath, 'utf8');
  } catch {
    throw new ApproveFromError(
      `Candidate tree is missing results.json at ${resultsPath}`,
    );
  }
  try {
    return parseRunResult(raw, resultsPath);
  } catch (error) {
    throw new ApproveFromError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Refuses to promote a candidate tree that did not come from a clean CI run.
 * Three fail-closed gates, all derived from the candidate's own `results.json`:
 *   - `mode !== 'ci'`: a local (advisory) run's candidate tree is rendered
 *     against the per-machine cache on the developer's own platform, so
 *     promoting it commits cross-platform pixels the CI gate would immediately
 *     re-flag. Only a CI-mode run's renders are eligible for the committed set.
 *   - `totals.failed` is not a number: `parseRunResult` validates only that
 *     `stories` is an array, so a truncated or foreign artifact can reach here
 *     with `totals` (or `totals.failed`) missing or non-numeric. Reading it
 *     unguarded would either throw a raw `TypeError` (not an `ApproveFromError`,
 *     breaking the trust-boundary contract) or, worse, evaluate `undefined > 0`
 *     to `false` and SILENTLY pass the gate. A non-numeric `failed` is therefore
 *     an explicit fail-closed refusal, not an assumed-zero.
 *   - `totals.failed > 0`: a run with failed stories produced a PARTIAL tree
 *     (broken stories wrote no candidate, or wrote a candidate mid-failure), so
 *     promoting it would commit an incomplete baseline set. A broken run is
 *     never a source of truth.
 * All abort before any write. `mode` is read defensively (older artifacts may
 * omit it). A missing `mode` is treated as non-`ci` and refused, since only a
 * current CI run stamps `mode: 'ci'`.
 */
function assertPromotableRun(result: RunResult): void {
  if (result.mode !== 'ci') {
    throw new ApproveFromError(
      `Candidate results.json was produced by a ${result.mode ?? 'pre-mode'} ` +
        'run, not a CI run; only `mode: "ci"` candidates may be promoted into ' +
        'committed baselines. Re-run under `tuffgal run --ci`.',
    );
  }
  if (typeof result.totals?.failed !== 'number') {
    throw new ApproveFromError(
      'Candidate results.json is missing a numeric totals.failed count. The ' +
        'artifact is truncated or was not produced by tuffgal. Refusing to ' +
        'promote a run whose pass/fail status cannot be verified.',
    );
  }
  if (result.totals.failed > 0) {
    throw new ApproveFromError(
      `Candidate results.json reports ${result.totals.failed} failed ` +
        'story(ies); a broken run produces a partial candidate tree that must ' +
        'never be promoted. Fix the failures and re-run before approving.',
    );
  }
}

/**
 * Pulls the captured environment (`environment.actual`) out of the candidate
 * run's results and validates its SHAPE before it can be promoted. Two failure
 * modes, both fail closed:
 *   - Missing: a candidate artifact produced by a pre-manifest tuffgal cannot
 *     populate `<baselines>/manifest.json`, and writing baselines without the
 *     manifest that gates them would silently defeat the environment-drift
 *     check. The user re-runs with a manifest-aware tuffgal.
 *   - Present but wrong-shaped: `parseRunResult` only checks that `stories` is
 *     an array, so a well-formed-but-false `environment.actual` block would
 *     otherwise flow straight into the committed manifest and defeat the drift
 *     gate from the inside. It is run through the SAME {@link
 *     validateManifestShape} check `readManifest` uses (reused, not duplicated),
 *     so a malformed block aborts before any write.
 */
function extractEnvironment(result: RunResult): EnvironmentManifest {
  const actual = result.environment?.actual;
  if (!actual) {
    throw new ApproveFromError(
      'Candidate results.json has no environment block; it was produced by a ' +
        'pre-manifest tuffgal. Re-run with a manifest-aware version before ' +
        'approving, so baselines/manifest.json can be written.',
    );
  }
  const invalid = validateManifestShape(actual);
  if (invalid) {
    throw new ApproveFromError(
      `Candidate results.json has a malformed environment block: ${invalid}`,
    );
  }
  return actual;
}

/** Unlike `extractEnvironment`, this never aborts the approve: history is advisory, so absent or malformed just drops promotion for it. */
async function extractHistory(
  candidateDir: string,
): Promise<HistoryStore | undefined> {
  const raw = await readJsonBaseline(
    join(candidateDir, HISTORY_FILENAME),
  ).catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `Candidate ${HISTORY_FILENAME} is not valid JSON; skipping history promotion.\n`,
    );
    return undefined;
  }
  if (!isHistoryStoreShape(parsed)) {
    process.stderr.write(
      `Candidate ${HISTORY_FILENAME} is malformed; skipping history promotion.\n`,
    );
    return undefined;
  }
  return parsed;
}

/**
 * Walks the candidate tree and returns the validated set of files to write.
 * Enforces the whole allow-list: top level holds only `results.json`,
 * `history.json`, and action directories; each action directory holds only
 * `<breakpoint>.png` / `<breakpoint>.a11y.yaml` (or legacy `0.png` /
 * `a11y.yaml`). Every other shape (stray extensions, nested dirs, dotfiles,
 * symlinks, traversal names) aborts. Every PNG is decoded here so a corrupt
 * payload fails validation, not a write.
 */
async function planWrites(
  candidateDir: string,
  baselinesDir: string,
): Promise<PlannedWrite[]> {
  const plan: PlannedWrite[] = [];
  const topEntries = await readdir(candidateDir, { withFileTypes: true });
  for (const entry of topEntries) {
    assertSafeName(entry.name, candidateDir);
    const entryPath = join(candidateDir, entry.name);
    await assertNotSymlink(entryPath);
    if (entry.name === 'results.json' || entry.name === HISTORY_FILENAME) {
      continue; // consumed separately; never written into baselines here
    }
    if (!entry.isDirectory()) {
      throw new ApproveFromError(
        `Unexpected top-level file in candidate tree: ${entry.name} ` +
          '(only results.json and action directories are allowed)',
      );
    }
    if (!ACTION_NAME_PATTERN.test(entry.name)) {
      throw new ApproveFromError(
        `Invalid action directory name "${entry.name}": must be ` +
          'lowercase-kebab ([a-z0-9-]+)',
      );
    }
    plan.push(...(await planActionDir(candidateDir, baselinesDir, entry.name)));
  }
  return plan;
}

/**
 * Validates one action directory's contents and returns its planned writes. Each
 * source file is read exactly once here (after its symlink/name checks pass) and
 * its bytes are retained on the {@link PlannedWrite} for phase 2. The source is
 * never re-read, closing the validate-then-swap TOCTOU window.
 */
async function planActionDir(
  candidateDir: string,
  baselinesDir: string,
  action: string,
): Promise<PlannedWrite[]> {
  const actionPath = join(candidateDir, action);
  const files = await readdir(actionPath, { withFileTypes: true });
  const plan: PlannedWrite[] = [];
  for (const file of files) {
    assertSafeName(file.name, candidateDir);
    const source = join(actionPath, file.name);
    await assertNotSymlink(source);
    if (!file.isFile()) {
      throw new ApproveFromError(
        `Unexpected non-file entry in candidate tree: ${action}/${file.name} ` +
          '(action directories hold only PNG + a11y.yaml files)',
      );
    }
    const kind = classifyCandidateFile(file.name, `${action}/${file.name}`);
    // Read once, after the symlink check, and retain the bytes. Phase 2 writes
    // exactly these, never re-reading `source`.
    const bytes = await readFile(source);
    // The destination is derived purely from validated names (never from any
    // path string in the artifact), so it always lands inside <baselines>.
    plan.push({
      source,
      destination: join(baselinesDir, action, file.name),
      kind,
      bytes,
    });
  }
  return plan;
}

/**
 * Decodes every planned PNG's RETAINED bytes (validation phase) so a corrupt or
 * non-PNG payload aborts the whole approve with zero writes. Decoding the bytes
 * already held on the plan (not a fresh read) is what makes the decode-check and
 * the eventual write see the same payload. `writeDurablePng`'s own recompress
 * step SWALLOWS a decode failure (it falls back to writing the given bytes),
 * which is the right behaviour for a trusted capture but wrong for an untrusted
 * artifact. A corrupt candidate PNG must fail closed, not land verbatim as a
 * baseline.
 */
async function assertAllPngsDecode(plan: PlannedWrite[]): Promise<void> {
  for (const write of plan) {
    if (write.kind !== 'png') continue;
    try {
      PNG.sync.read(write.bytes);
    } catch {
      throw new ApproveFromError(
        `Candidate PNG is not a decodable PNG: ${write.source}`,
      );
    }
  }
}

/**
 * Classifies a candidate file inside an action dir, validating its breakpoint
 * stem. Accepts breakpoint-keyed `<bp>.png` / `<bp>.a11y.yaml` and the legacy
 * `0.png` / `a11y.yaml` pair. Anything else aborts.
 */
function classifyCandidateFile(name: string, label: string): 'png' | 'a11y' {
  if (name === LEGACY_A11Y) return 'a11y'; // legacy companion
  if (name === LEGACY_PNG) return 'png'; // legacy PNG
  if (name.endsWith(A11Y_SUFFIX)) {
    assertBreakpointStem(name.slice(0, -A11Y_SUFFIX.length), label);
    return 'a11y';
  }
  if (name.endsWith('.png')) {
    assertBreakpointStem(name.slice(0, -'.png'.length), label);
    return 'png';
  }
  throw new ApproveFromError(
    `Unexpected file in candidate tree: ${label} ` +
      '(only <breakpoint>.png and <breakpoint>.a11y.yaml are allowed)',
  );
}

/** Aborts unless `stem` matches the runner's own breakpoint-segment shape. */
function assertBreakpointStem(stem: string, label: string): void {
  if (!BREAKPOINT_SEGMENT_PATTERN.test(stem)) {
    throw new ApproveFromError(
      `Invalid breakpoint name in candidate tree: ${label} ` +
        '(must be [a-z0-9_-]+)',
    );
  }
}

/**
 * Rejects a filesystem name that is a dotfile or carries a path separator /
 * traversal segment. `readdir` yields single path segments, so a `..` or a
 * separator here means a hostile or malformed entry, not normal nesting.
 */
function assertSafeName(name: string, context: string): void {
  if (name === '' || name === '.' || name === '..') {
    throw new ApproveFromError(
      `Unsafe entry name "${name}" in candidate tree under ${context}`,
    );
  }
  if (name.startsWith('.')) {
    throw new ApproveFromError(
      `Dotfile "${name}" not allowed in candidate tree under ${context}`,
    );
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new ApproveFromError(
      `Path separator in candidate entry name "${name}" under ${context}`,
    );
  }
}

/** Aborts if `path` is a symlink. Never follow a link out of the tree. */
async function assertNotSymlink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new ApproveFromError(
      `Symlink not allowed in candidate tree: ${path}`,
    );
  }
}

/**
 * Recomputes the local prune targets for `--prune` from the candidate run's
 * `results.deleted`, entirely under the resolved `baselinesDir`. The artifact's
 * own `baselinePaths[]` strings are ignored. They describe the CI machine's
 * filesystem and could point anywhere. Instead each entry's `action` +
 * `breakpoint` is re-validated and re-rooted here, so a prune can only ever
 * delete files inside this repo's baselines directory.
 */
function computePruneTargets(
  result: RunResult,
  baselinesDir: string,
): string[][] {
  const groups: string[][] = [];
  for (const entry of result.deleted ?? []) {
    if (!ACTION_NAME_PATTERN.test(entry.action)) {
      throw new ApproveFromError(
        `results.deleted has an invalid action name "${entry.action}"`,
      );
    }
    const actionDir = join(baselinesDir, entry.action);
    const paths =
      entry.breakpoint === LEGACY_BREAKPOINT
        ? [join(actionDir, LEGACY_PNG), join(actionDir, LEGACY_A11Y)]
        : breakpointKeyedPaths(entry.breakpoint, actionDir);
    for (const path of paths) {
      assertInsideBaselines(path, baselinesDir);
    }
    groups.push(paths);
  }
  return groups;
}

/** The PNG + a11y companion paths for a breakpoint-keyed orphan. */
function breakpointKeyedPaths(breakpoint: string, actionDir: string): string[] {
  if (!BREAKPOINT_SEGMENT_PATTERN.test(breakpoint)) {
    throw new ApproveFromError(
      `results.deleted has an invalid breakpoint name "${breakpoint}"`,
    );
  }
  return [
    join(actionDir, `${breakpoint}.png`),
    join(actionDir, `${breakpoint}${A11Y_SUFFIX}`),
  ];
}

/**
 * Belt-and-suspenders: even though prune paths are recomputed from validated
 * names, assert the resolved path stays inside `baselinesDir` before any delete.
 * A path that escapes (it should be impossible after name validation) aborts.
 */
function assertInsideBaselines(path: string, baselinesDir: string): void {
  const rel = relative(baselinesDir, path);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new ApproveFromError(
      `Refusing to prune a path outside the baselines directory: ${path}`,
    );
  }
}

/**
 * Writes `<baselines>/manifest.json` from the candidate run's captured
 * environment. `schemaVersion`/`captureSchema` are re-stamped from this
 * tuffgal's constants (the single source of truth for the file format), so a
 * candidate carrying a stale schema number is normalised on promotion.
 */
async function writeManifest(
  baselinesDir: string,
  environment: EnvironmentManifest,
): Promise<void> {
  const manifest: EnvironmentManifest = {
    ...environment,
    schemaVersion: SCHEMA_VERSION,
    captureSchema: CAPTURE_SCHEMA,
  };
  await writeText(
    join(baselinesDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
