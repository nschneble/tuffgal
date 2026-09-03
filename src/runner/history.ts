import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from '../config.ts';
import { readJsonBaseline } from '../screenshots/baselineStore.ts';
import type { ActionResult, StoryResult } from '../schema/result.ts';
import type { RunMode } from './mode.ts';

/** The filename of the history store, inside `paths.localCache` (local mode) or `paths.baselines` (CI mode). */
export const HISTORY_FILENAME = 'history.json';

/** Entries beyond this many (per action+breakpoint key) are dropped, oldest first. */
export const MAX_HISTORY_ENTRIES = 20;

export interface HistoryEntry {
  /** ISO 8601, the run's `finishedAt`. */
  finishedAt: string;
  diffPixels: number;
  diffRatio: number;
}

/** Keyed by `historyKey(action, breakpoint)`; each series is oldest -> newest. */
export type HistoryStore = Record<string, HistoryEntry[]>;

/** `::` is safe as a separator: action/breakpoint names are validated `[a-z0-9-]+`/`[a-z0-9_-]+`, so it never appears inside either half. */
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

/** Shared by {@link readHistory} and `approveFrom`'s promotion gate, so both agree on what counts as valid. */
export function isHistoryStoreShape(value: unknown): value is HistoryStore {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (series) => Array.isArray(series) && series.every(isHistoryEntry),
  );
}

/** CI mode's `paths.baselines` result is READ-ONLY here; `run --ci` writes its appended store to the candidate tree instead (see `runAll`, `docs/ci.md`). */
export function historyPathFor(config: ResolvedConfig, mode: RunMode): string {
  const root = mode === 'ci' ? config.paths.baselines : config.paths.localCache;
  return join(root, HISTORY_FILENAME);
}

/** Tolerant past `readJsonBaseline`, which throws on an unreadable path: missing, unreadable, unparseable, or wrong-shaped all read as an empty store. Advisory, never gates pass/fail. */
export async function readHistory(path: string): Promise<HistoryStore> {
  let raw: string | undefined;
  try {
    raw = await readJsonBaseline(path);
  } catch {
    return {};
  }
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return isHistoryStoreShape(parsed) ? parsed : {};
}

/** Trailing newline mirrors `writeManifest`'s convention. */
export async function writeHistory(
  path: string,
  store: HistoryStore,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** Pure: returns a new store, never mutates `store` or any series array it holds. */
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
 * Folds this run's `pass`/`changed` actions (with a computed diff) into
 * `store`, attaching each qualifying action's updated series as
 * `action.history`. The same action+breakpoint can recur across stories in
 * one run; each occurrence appends its own entry, undeduplicated, since each
 * is a genuinely independent comparison. Pure throughout.
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
