import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import type { ActionResult, StoryResult } from '../schema/result.ts';
import type { RunMode } from './mode.ts';

/** The filename of the history store, inside `paths.localCache` (local mode) or `paths.baselines` (CI mode). */
export const HISTORY_FILENAME = 'history.json';

/**
 * Retention cap: entries beyond this many (per action+breakpoint key) are
 * dropped, oldest first. 20 covers roughly a month of daily CI cadence or
 * several weeks of frequent local iteration, enough runs for a "parked near
 * tolerance" pattern to become visible, while keeping the committed file
 * small (a project with 50 actions x 1 breakpoint x 20 entries x ~70
 * bytes/entry is well under 100KB, trivially diffable in a baselines PR).
 */
export const MAX_HISTORY_ENTRIES = 20;

export interface HistoryEntry {
  /** ISO 8601, the run's `finishedAt`. */
  finishedAt: string;
  diffPixels: number;
  diffRatio: number;
}

/** Keyed by `historyKey(action, breakpoint)`; each series is oldest -> newest. */
export type HistoryStore = Record<string, HistoryEntry[]>;

/**
 * The store key for one action+breakpoint. Action names are validated
 * `[a-z0-9-]+` and breakpoint segments `[a-z0-9_-]+` (`baselineStore.ts`), so
 * `::` can never appear inside either half and the joined key is always
 * unambiguous. This is a JSON object key, not a filesystem path, so neither
 * half needs the path-safety handling `baselineStore.ts` applies.
 */
export function historyKey(
  action: string,
  breakpoint: string | undefined,
): string {
  return `${action}::${breakpoint ?? ''}`;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.finishedAt === 'string' &&
    typeof entry.diffPixels === 'number' &&
    typeof entry.diffRatio === 'number'
  );
}

/**
 * Shape-checks an unknown value as a {@link HistoryStore}: a plain object
 * whose every value is an array of well-formed {@link HistoryEntry}
 * objects. Reused by the tolerant runtime reader ({@link readHistory}) and
 * by `approveFrom`'s promotion gate, so both agree on what counts as valid.
 */
export function isHistoryStoreShape(value: unknown): value is HistoryStore {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (series) => Array.isArray(series) && series.every(isHistoryEntry),
  );
}

/**
 * The history store path for this run's mode: the per-machine
 * `paths.localCache` in local mode (self-managed, read+written every run,
 * mirroring how local mode already auto-manages its baseline cache), or the
 * committed `paths.baselines` in CI mode (READ-ONLY here; `run --ci` never
 * writes `paths.baselines`, see `docs/ci.md` "CI owns the baselines" -- the
 * caller writes the CI-mode appended store to the candidate tree instead,
 * see `runAll`).
 */
export function historyPathFor(config: ResolvedConfig, mode: RunMode): string {
  const root = mode === 'ci' ? config.paths.baselines : config.paths.localCache;
  return join(root, HISTORY_FILENAME);
}

/**
 * Reads a history store from disk. Tolerant by design, like
 * `readJsonBaseline`: a missing file, unparseable JSON, or a well-formed-JSON-
 * but-wrong-shaped value all read as an empty store rather than throwing.
 * History is advisory (it never gates pass/fail), so there is no
 * missing/malformed distinction worth surfacing to the caller, unlike
 * `readManifest`'s three-way result.
 */
export async function readHistory(path: string): Promise<HistoryStore> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return isHistoryStoreShape(parsed) ? parsed : {};
}

/**
 * Writes a history store to disk, creating its parent directory if needed.
 * Trailing newline mirrors `approveFrom.ts`'s `writeManifest` convention.
 */
export async function writeHistory(
  path: string,
  store: HistoryStore,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/**
 * Appends `entry` to `store[key]`, capped to {@link MAX_HISTORY_ENTRIES}
 * (oldest dropped first). Pure: returns a new store, never mutates `store`
 * or any series array it holds.
 */
export function appendEntry(
  store: HistoryStore,
  key: string,
  entry: HistoryEntry,
): HistoryStore {
  const existing = store[key] ?? [];
  const series = [...existing, entry].slice(-MAX_HISTORY_ENTRIES);
  return { ...store, [key]: series };
}

/**
 * Folds this run's `pass`/`changed` actions into `store`, and returns both
 * the updated store and a new `results` array where each qualifying action
 * carries its updated series as `action.history` (oldest -> newest, this
 * run's own new entry last).
 *
 * Qualifying: `status` is `pass` or `changed` AND both `diffPixels` and
 * `diffRatio` are defined (excludes `new`/`failed`/`skipped`, and a
 * size-mismatch `changed` whose diff could not be computed). Everything else
 * passes through unchanged, with no `history` field.
 *
 * The same action+breakpoint can appear in more than one story in a single
 * run (baselines are keyed by action name alone, see `baselineStore.ts`
 * `pathsFor`), each such occurrence appends its OWN entry, in encounter
 * order; entries are not de-duplicated within a run, since each is a
 * genuinely independent comparison.
 *
 * Pure: neither `store` nor any `StoryResult`/`ActionResult` in `results` is
 * mutated. `results`'s stories that contain no qualifying action are
 * returned as the SAME object (no unnecessary clone), so a caller comparing
 * references can tell which stories actually changed.
 */
export function applyRunHistory(
  store: HistoryStore,
  results: StoryResult[],
  finishedAtIso: string,
): { store: HistoryStore; results: StoryResult[] } {
  let nextStore = store;
  const nextResults = results.map((story) => {
    let changed = false;
    const nextActions = story.actions.map((action) => {
      if (
        (action.status !== 'pass' && action.status !== 'changed') ||
        action.diffPixels === undefined ||
        action.diffRatio === undefined
      ) {
        return action;
      }
      const key = historyKey(action.action, action.breakpoint);
      nextStore = appendEntry(nextStore, key, {
        finishedAt: finishedAtIso,
        diffPixels: action.diffPixels,
        diffRatio: action.diffRatio,
      });
      changed = true;
      const withHistory: ActionResult = {
        ...action,
        history: nextStore[key],
      };
      return withHistory;
    });
    return changed ? { ...story, actions: nextActions } : story;
  });
  return { store: nextStore, results: nextResults };
}
