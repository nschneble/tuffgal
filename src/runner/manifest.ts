import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { ResolvedConfig } from '../config.ts';

/**
 * Bump when the capture pipeline changes behaviour in a way that shifts pixels
 * for the same input UI — a new default screenshot option, a change to how the
 * clock is frozen, a mask-application tweak, etc. A committed baseline set was
 * rendered under one `CAPTURE_SCHEMA`; a run under a higher value is a pixel-
 * affecting mismatch (see {@link PIXEL_AFFECTING_KEYS}) that prompts re-approve.
 *
 * This is deliberately separate from `schemaVersion` (the manifest *file*
 * format): the file shape can stay stable while capture behaviour evolves, and
 * vice versa.
 */
export const CAPTURE_SCHEMA = 1;

/** Manifest file-format version. Bumped only when this JSON shape changes. */
export const SCHEMA_VERSION = 1;

/** One breakpoint's identity as recorded in the manifest. */
export interface ManifestBreakpoint {
  name: string;
  width: number;
  height: number;
}

/**
 * The environment manifest committed beside the baselines (`<baselines>/
 * manifest.json`). Written only by `approve --from` (a later wave) from the
 * environment block of the candidate run's `results.json`; read by `run --ci`
 * to detect when the current capture environment has drifted from the one the
 * committed baselines were rendered under.
 *
 * `tuffgalVersion` and `playwrightVersion` are informational only — they are
 * recorded for debugging but never contribute to a mismatch (a tuffgal patch
 * release or a Playwright bump that does not move the bundled browser leaves
 * pixels untouched). Every other field is pixel-affecting; see
 * {@link PIXEL_AFFECTING_KEYS}.
 */
export interface EnvironmentManifest {
  schemaVersion: number;
  captureSchema: number;
  /** Informational: the tuffgal release that captured the baselines. */
  tuffgalVersion: string;
  /** Informational: the Playwright release used. */
  playwrightVersion: string;
  browser: string;
  browserVersion: string;
  platform: string;
  captureMode: string;
  breakpoints: ManifestBreakpoint[];
  deviceScaleFactor: number;
  frozenTime: string;
}

/**
 * The manifest keys whose divergence between the committed manifest and the
 * current run shifts rendered pixels, so a difference must gate the run (exit
 * 3) and prompt a re-approve. `schemaVersion` is excluded (it versions the file
 * shape, not the pixels); `tuffgalVersion`/`playwrightVersion` are excluded as
 * informational. `browser` is excluded because a browser-*name* change is
 * already implied by `browserVersion` (which carries the vendor+version string)
 * and the runner only launches chromium today — comparing the name would add a
 * redundant key with no independent signal.
 */
export const PIXEL_AFFECTING_KEYS = [
  'captureSchema',
  'browserVersion',
  'platform',
  'captureMode',
  'breakpoints',
  'deviceScaleFactor',
  'frozenTime',
] as const;

export type PixelAffectingKey = (typeof PIXEL_AFFECTING_KEYS)[number];

/**
 * Result of reading `<baselines>/manifest.json`. Three outcomes the caller must
 * distinguish, because they gate differently:
 *   - `ok` — a well-formed manifest was read; compare it against the run.
 *   - `missing` — no file on disk. The bootstrap case: the first `approve
 *     --from` has not written a manifest yet, so `run --ci` treats it as "no
 *     expectation to violate" — `environment.expected: null`, no mismatch, no
 *     exit 3. Never gate a project that has simply not been approved once.
 *   - `malformed` — a file exists but is not valid JSON or fails shape checks.
 *     A committed manifest that cannot be parsed is a real problem the run
 *     should surface, but crashing the whole comparison is too blunt. Treated
 *     as a mismatch-with-note: `expected: null`, `mismatch: true`, and
 *     `mismatchKeys: ['manifest']` so the report/comment can say "the committed
 *     manifest is unreadable — re-approve to rewrite it" without aborting.
 */
export type ManifestReadResult =
  | { status: 'ok'; manifest: EnvironmentManifest }
  | { status: 'missing' }
  | { status: 'malformed'; reason: string };

/** The sentinel `mismatchKeys` entry for an unreadable committed manifest. */
export const MALFORMED_MANIFEST_KEY = 'manifest';

/** The filename of the environment manifest inside `paths.baselines`. */
export const MANIFEST_FILENAME = 'manifest.json';

/**
 * Reads and shape-checks `<baselinesDir>/manifest.json`. Tolerant by design
 * (see {@link ManifestReadResult}): a missing file is the bootstrap case, a
 * malformed one is surfaced as a note rather than a crash. Shape validation is
 * intentionally shallow — enough to trust the field reads in {@link
 * compareEnvironment}, not a full structural mirror.
 */
export async function readManifest(
  baselinesDir: string,
): Promise<ManifestReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(baselinesDir, MANIFEST_FILENAME), 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { status: 'malformed', reason };
  }
  const validation = validateManifestShape(parsed);
  if (validation) {
    return { status: 'malformed', reason: validation };
  }
  return { status: 'ok', manifest: parsed as EnvironmentManifest };
}

/**
 * Returns a human-readable reason string when `value` is not a well-formed
 * {@link EnvironmentManifest}, or `undefined` when it passes. Checks every key
 * the comparison reads so a truncated or wrong-typed manifest is caught here
 * (surfaced as `malformed`) rather than producing a garbage per-key delta.
 */
function validateManifestShape(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'manifest is not an object';
  }
  const manifest = value as Record<string, unknown>;
  for (const key of [
    'schemaVersion',
    'captureSchema',
    'deviceScaleFactor',
  ] as const) {
    if (typeof manifest[key] !== 'number') {
      return `\`${key}\` must be a number`;
    }
  }
  for (const key of [
    'tuffgalVersion',
    'playwrightVersion',
    'browser',
    'browserVersion',
    'platform',
    'captureMode',
    'frozenTime',
  ] as const) {
    if (typeof manifest[key] !== 'string') {
      return `\`${key}\` must be a string`;
    }
  }
  if (!Array.isArray(manifest.breakpoints)) {
    return '`breakpoints` must be an array';
  }
  for (const entry of manifest.breakpoints) {
    if (typeof entry !== 'object' || entry === null) {
      return '`breakpoints[]` must be objects';
    }
    const breakpoint = entry as Record<string, unknown>;
    if (typeof breakpoint.name !== 'string') {
      return '`breakpoints[].name` must be a string';
    }
    if (
      typeof breakpoint.width !== 'number' ||
      typeof breakpoint.height !== 'number'
    ) {
      return '`breakpoints[].width`/`height` must be numbers';
    }
  }
  return undefined;
}

/** Outcome of comparing the committed manifest against the current run's env. */
export interface EnvironmentComparison {
  mismatch: boolean;
  mismatchKeys: string[];
}

/**
 * Compares a committed manifest read result against the environment captured
 * this run, returning which pixel-affecting keys diverged.
 *
 *   - `missing` — bootstrap: nothing to violate. `{ mismatch: false }`.
 *   - `malformed` — unreadable committed manifest: mismatch-with-note,
 *     `mismatchKeys: ['manifest']` (see {@link MALFORMED_MANIFEST_KEY}).
 *   - `ok` — diff each {@link PIXEL_AFFECTING_KEYS}. `breakpoints` compares deep
 *     and order-sensitively: the manifest records an ordered list, and a
 *     reorder (even at identical dimensions) is treated as a change worth a
 *     re-approve prompt rather than silently equal — order-sensitivity is the
 *     conservative pixel-safety choice. Informational keys
 *     (`tuffgalVersion`/`playwrightVersion`) are never compared.
 */
export function compareEnvironment(
  expected: ManifestReadResult,
  actual: EnvironmentManifest,
): EnvironmentComparison {
  if (expected.status === 'missing') {
    return { mismatch: false, mismatchKeys: [] };
  }
  if (expected.status === 'malformed') {
    return { mismatch: true, mismatchKeys: [MALFORMED_MANIFEST_KEY] };
  }
  const manifest = expected.manifest;
  const mismatchKeys: string[] = [];
  for (const key of PIXEL_AFFECTING_KEYS) {
    if (key === 'breakpoints') {
      if (!breakpointsEqual(manifest.breakpoints, actual.breakpoints)) {
        mismatchKeys.push(key);
      }
      continue;
    }
    if (manifest[key] !== actual[key]) {
      mismatchKeys.push(key);
    }
  }
  return { mismatch: mismatchKeys.length > 0, mismatchKeys };
}

/**
 * Deep, order-sensitive equality of two breakpoint lists: same length, and each
 * position matches on `name`/`width`/`height`. Order-sensitive on purpose — see
 * {@link compareEnvironment}.
 */
function breakpointsEqual(
  a: ManifestBreakpoint[],
  b: ManifestBreakpoint[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.name === other.name &&
      entry.width === other.width &&
      entry.height === other.height
    );
  });
}

const requirePackage = createRequire(import.meta.url);

/**
 * Reads tuffgal's own version from its `package.json`. Resolved relative to this
 * module so it works from both `src/` (dev/test) and the built `dist/` tree —
 * `../../package.json` is the package root in both layouts. Informational only.
 */
function readTuffgalVersion(): string {
  const pkg = requirePackage('../../package.json') as { version: string };
  return pkg.version;
}

/**
 * Reads the installed Playwright version from its `package.json` via module
 * resolution (not a hardcoded string), so a dependency bump is reflected
 * automatically. Informational only.
 */
function readPlaywrightVersion(): string {
  const pkg = requirePackage('playwright/package.json') as { version: string };
  return pkg.version;
}

/** The captured browser identity for one run. */
export interface CapturedBrowser {
  name: string;
  version: string;
}

/**
 * Builds the environment manifest describing THIS run — the "actual" side of
 * the comparison and the block a later `approve --from` promotes into the
 * committed manifest. Everything except the live browser version is derived
 * from the resolved config and the host, so the caller only supplies the
 * browser identity it read from the launched Playwright browser.
 *
 * `deviceScaleFactor` is hardcoded `1`: the runner never sets `deviceScaleFactor`
 * on `browser.newContext` (see `runStory.ts`), so Playwright's default of `1`
 * applies. If a future wave makes the scale factor configurable, thread it here
 * and this constant must track it — the manifest's whole job is to notice a DSF
 * change, so a stale hardcode here would silently defeat that.
 */
export function captureEnvironment(
  config: ResolvedConfig,
  browser: CapturedBrowser,
): EnvironmentManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    captureSchema: CAPTURE_SCHEMA,
    tuffgalVersion: readTuffgalVersion(),
    playwrightVersion: readPlaywrightVersion(),
    browser: browser.name,
    browserVersion: browser.version,
    platform: process.platform,
    captureMode: config.captureMode,
    breakpoints: config.breakpoints.map((breakpoint) => ({
      name: breakpoint.name,
      width: breakpoint.width,
      height: breakpoint.height,
    })),
    deviceScaleFactor: 1,
    frozenTime: config.frozenTime,
  };
}
