import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';

/**
 * Bridge supplied by the consumer for tearing down + reseeding their test
 * database between runs. Both methods are optional: a static-site project
 * with no backend can omit `database` entirely.
 */
export interface DatabaseBridge {
  /**
   * Wipes the test database and reseeds the deterministic test user. Called
   * once before the scheduler dispatches the first story.
   */
  reset?: () => Promise<void>;
  /**
   * Map of named fixture functions. Each story declares
   * `fixtures: ["name"]` and the runner invokes the matching entry before
   * launching the browser. Fixtures must be idempotent (apply twice safely)
   * because Tuffgal applies them per-story without per-story DB reset.
   */
  fixtures?: Record<string, () => Promise<void>>;
}

/**
 * Bridge for the optional `--manage-servers` mode. When supplied, Tuffgal
 * spawns the command in a detached process group, polls the healthcheck
 * URLs, and tears the process tree down at end-of-run.
 */
export interface DevServerBridge {
  /** Shell command. Run via `sh -c` so pipes and `&&` work. */
  command: string;
  /** Working directory, relative to the config file's location. */
  cwd?: string;
  /**
   * URLs to poll before considering the dev server stack ready. Each entry
   * is probed via TCP `connect` (not HTTP) so self-signed certificates and
   * 404 responses do not block readiness.
   */
  healthCheck: Array<{ url: string; timeoutMs?: number }>;
  /** Signal sent on shutdown. Defaults to `SIGTERM`. */
  shutdownSignal?: NodeJS.Signals;
  /** Grace period before `SIGKILL`. Defaults to 5000. */
  shutdownGraceMs?: number;
}

/**
 * Built-in named viewport modes. Widths track Tailwind's default dimensional
 * breakpoints (sm=640, md=768, lg=1024, xl=1280) so a project's Tuffgal runs
 * line up with the responsive cutoffs its CSS already keys off of:
 *   - mobile  sits below the sm=640 cutoff (small-phone portrait)
 *   - tablet  lands exactly on md=768
 *   - laptop  lands exactly on lg=1024
 *   - desktop lands exactly on xl=1280, and preserves the historical
 *     1280x800 default so projects that never opt into breakpoints render
 *     identically to before this feature existed.
 * Heights are conventional companions to each width, not Tailwind values
 * (Tailwind breakpoints are width-only).
 */
export const BREAKPOINTS = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1024, height: 768 },
  desktop: { width: 1280, height: 800 },
} as const;

/** A built-in breakpoint name. Other modules reuse this for per-mode work. */
export type BreakpointName = keyof typeof BREAKPOINTS;

/**
 * Static paths Tuffgal reads + writes. All relative to the config file's
 * location.
 */
export interface PathsConfig {
  /** Action JSON files. Recurses into subdirectories. */
  actions: string;
  /** Story JSON files. Recurses into subdirectories. */
  stories: string;
  /** Committed PNG baselines + a11y snapshots. */
  baselines: string;
  /** Generated HTML report + traces. Gitignore this. */
  report: string;
  /** Storage state cache for `produces`/`needs` label inheritance. */
  authState?: string;
}

/**
 * Root config shape passed to `defineConfig()`.
 */
export interface TuffgalConfig {
  /** Where actions, stories, baselines, and reports live. */
  paths: PathsConfig;
  /** Base URL of the running app. */
  baseUrl: string;
  /**
   * Origin (scheme + host + port) of the consumer's API. Intercept
   * patterns that begin with this host stay scoped to API traffic and
   * avoid accidentally matching Vite source modules.
   */
  apiHost?: string;
  /**
   * localStorage keys to persist across stories. Cookie-based apps may
   * leave this empty — cookies always persist via Playwright's storage
   * state.
   */
  storageStatePins?: string[];
  /** Browser viewport. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Named breakpoint modes this project runs, drawn from the built-in
   * {@link BREAKPOINTS} registry (`mobile` | `tablet` | `laptop` |
   * `desktop`). Order is preserved and duplicates are dropped. When set, this
   * supersedes `viewport`. When omitted, Tuffgal falls back to `viewport`
   * (if set) and finally to a single `desktop` breakpoint, so existing
   * single-viewport projects keep working unchanged.
   */
  breakpoints?: BreakpointName[];
  /** Default Playwright locator + action timeout. Defaults to 10_000. */
  defaultTimeoutMs?: number;
  /** Default navigation timeout. Defaults to 15_000. */
  navigationTimeoutMs?: number;
  /**
   * Frozen ISO timestamp passed to `page.clock.install`. Pins
   * `Date.now()` for any relative-time UI ("3 minutes ago") so screenshot
   * diffs do not flicker.
   */
  frozenTime?: string;
  /** Worker pool size. Default: `min(cpus / 2, 4)`. */
  workers?: number;
  /** Consumer-provided database bridge. */
  database?: DatabaseBridge;
  /** Consumer-provided dev-server bridge (only used with `--manage-servers`). */
  devServers?: DevServerBridge;
  /**
   * Path to a markdown file listing the consumer's user journeys (one per
   * row in a single markdown table). Tuffgal counts how many stories
   * declare a matching `flow:` field and exposes the ratio as
   * `customCoverage.flows` in the report.
   */
  flowInventory?: string;
}

/**
 * Resolved config — every optional field replaced with a concrete value
 * so downstream consumers can rely on the shape without per-field `??`.
 * Returned by `loadConfig`. Not part of the public surface.
 */
export interface ResolvedConfig {
  rootDir: string;
  paths: Required<PathsConfig>;
  baseUrl: string;
  apiHost: string | undefined;
  storageStatePins: string[];
  /**
   * Resolved breakpoint modes, always non-empty. Each entry carries the
   * viewport dimensions to render at. Built from `config.breakpoints` when
   * set, else a single synthesised `viewport` entry for legacy projects,
   * else a single `desktop` default.
   */
  breakpoints: Array<{ name: string; width: number; height: number }>;
  /**
   * Single viewport the current runner still reads. Kept in sync with the
   * first resolved breakpoint until the runner is rewired to iterate
   * `breakpoints` directly, so nothing downstream breaks meanwhile.
   */
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  frozenTime: string;
  workers: number | undefined;
  database: DatabaseBridge | undefined;
  devServers: DevServerBridge | undefined;
  flowInventory: string | undefined;
}

const DEFAULTS = {
  viewport: { width: 1280, height: 800 },
  defaultTimeoutMs: 10_000,
  navigationTimeoutMs: 15_000,
  frozenTime: '2026-01-15T12:00:00.000Z',
  authStateRelative: '.auth',
} as const;

/**
 * Helper that returns its argument unchanged. Use in a `tuffgal.config.ts`
 * file to get full TypeScript type-checking against `TuffgalConfig`.
 */
export function defineConfig(config: TuffgalConfig): TuffgalConfig {
  return config;
}

/**
 * Locates + dynamically imports the consumer's `tuffgal.config.ts` (or
 * `.js`) from `cwd`. Throws a descriptive error when no config is found
 * so the user knows where to put the file.
 */
export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const candidates = ['tuffgal.config.ts', 'tuffgal.config.js'];
  for (const candidate of candidates) {
    const absolute = resolve(cwd, candidate);
    try {
      await access(absolute);
    } catch {
      continue;
    }
    const module = (await import(pathToFileURL(absolute).href)) as {
      default?: TuffgalConfig;
    };
    if (!module.default) {
      throw new Error(
        `${candidate} found at ${absolute} but does not have a default export. ` +
          `Did you forget \`export default defineConfig({ ... })\`?`,
      );
    }
    assertValidConfig(module.default, absolute);
    return resolveConfig(module.default, resolve(cwd, '.'));
  }
  throw new Error(
    `No tuffgal.config.ts or tuffgal.config.js found in ${cwd}. Run ` +
      `\`npx tuffgal init\` to scaffold one.`,
  );
}

/**
 * Shape-checks the consumer's default export before `resolveConfig`
 * dereferences it. The config module is dynamically imported, so TypeScript
 * cannot guarantee it actually matches `TuffgalConfig`; without this a missing
 * `paths` or a non-string `baseUrl` throws an opaque TypeError inside
 * `resolveConfig`. Validation covers the fields `resolveConfig` reads — the
 * `database`/`devServers` bridges hold functions and are left to fail at their
 * own call sites. `source` is the config file path, surfaced in every message.
 */
export function assertValidConfig(input: unknown, source: string): void {
  const fail = (detail: string): never => {
    throw new Error(`Invalid tuffgal config at ${source}: ${detail}`);
  };
  if (typeof input !== 'object' || input === null) {
    fail('the default export must be a config object.');
  }
  const config = input as Record<string, unknown>;

  if (typeof config.paths !== 'object' || config.paths === null) {
    fail('`paths` is required and must be an object.');
  }
  const paths = config.paths as Record<string, unknown>;
  for (const key of ['actions', 'stories', 'baselines', 'report'] as const) {
    if (typeof paths[key] !== 'string') {
      fail(`\`paths.${key}\` is required and must be a string.`);
    }
  }
  if (paths.authState !== undefined && typeof paths.authState !== 'string') {
    fail('`paths.authState` must be a string when provided.');
  }

  if (typeof config.baseUrl !== 'string') {
    fail('`baseUrl` is required and must be a string.');
  }

  for (const key of [
    'defaultTimeoutMs',
    'navigationTimeoutMs',
    'workers',
  ] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== 'number' || value <= 0)) {
      fail(`\`${key}\` must be a positive number when provided.`);
    }
  }

  for (const key of ['apiHost', 'frozenTime', 'flowInventory'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      fail(`\`${key}\` must be a string when provided.`);
    }
  }

  if (config.viewport !== undefined) {
    const viewport = config.viewport as Record<string, unknown>;
    if (
      typeof viewport !== 'object' ||
      viewport === null ||
      typeof viewport.width !== 'number' ||
      typeof viewport.height !== 'number'
    ) {
      fail('`viewport` must be `{ width: number, height: number }`.');
    }
  }

  if (config.breakpoints !== undefined) {
    const validNames = Object.keys(BREAKPOINTS);
    const breakpoints = config.breakpoints;
    if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
      fail('`breakpoints` must be a non-empty array of breakpoint names.');
    }
    for (const name of breakpoints as unknown[]) {
      if (typeof name !== 'string' || !validNames.includes(name)) {
        fail(
          `\`breakpoints\` contains an unknown breakpoint ${JSON.stringify(
            name,
          )}. Valid names: ${validNames.join(', ')}.`,
        );
      }
    }
  }
}

function resolveConfig(input: TuffgalConfig, rootDir: string): ResolvedConfig {
  const breakpoints = resolveBreakpoints(input);
  return {
    rootDir,
    paths: {
      actions: resolve(rootDir, input.paths.actions),
      stories: resolve(rootDir, input.paths.stories),
      baselines: resolve(rootDir, input.paths.baselines),
      report: resolve(rootDir, input.paths.report),
      authState: resolve(
        rootDir,
        input.paths.authState ?? DEFAULTS.authStateRelative,
      ),
    },
    baseUrl: input.baseUrl,
    apiHost: input.apiHost,
    storageStatePins: input.storageStatePins ?? [],
    breakpoints,
    // Keep the legacy single-viewport field in lockstep with the first
    // resolved breakpoint so the current runner keeps working until Wave 3
    // teaches it to iterate `breakpoints`.
    viewport: { width: breakpoints[0].width, height: breakpoints[0].height },
    defaultTimeoutMs: input.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    navigationTimeoutMs:
      input.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs,
    frozenTime: input.frozenTime ?? DEFAULTS.frozenTime,
    workers: input.workers,
    database: input.database,
    devServers: input.devServers,
    flowInventory: input.flowInventory
      ? resolve(rootDir, input.flowInventory)
      : undefined,
  };
}

/**
 * Collapses the three mutually-exclusive viewport-selection inputs into a
 * single always-non-empty breakpoint list, in priority order:
 *   1. explicit `breakpoints` — each name resolved to its registry
 *      dimensions, original order preserved, duplicates dropped;
 *   2. legacy `viewport` — wrapped as one synthetic `viewport` breakpoint so
 *      pre-breakpoints projects render exactly as before;
 *   3. neither — a single `desktop` breakpoint (1280x800), matching the
 *      historical `DEFAULTS.viewport`.
 * `assertValidConfig` has already rejected unknown/empty `breakpoints`, so by
 * the time we get here every name is a valid registry key.
 */
type ResolvedBreakpoint = { name: string; width: number; height: number };

function resolveBreakpoints(
  input: TuffgalConfig,
): [ResolvedBreakpoint, ...ResolvedBreakpoint[]] {
  const [head, ...tail] = input.breakpoints ?? [];
  if (head !== undefined) {
    // assertValidConfig guarantees every name is a valid registry key. Seed
    // the result with the (now provably-present) first name so the return
    // type stays a non-empty tuple, then append the rest minus duplicates.
    // Keeping the tuple shape lets callers read `breakpoints[0]` without an
    // undefined check under noUncheckedIndexedAccess.
    const seen = new Set<BreakpointName>([head]);
    const resolved: [ResolvedBreakpoint, ...ResolvedBreakpoint[]] = [
      { name: head, ...BREAKPOINTS[head] },
    ];
    for (const name of tail) {
      if (seen.has(name)) continue;
      seen.add(name);
      resolved.push({ name, ...BREAKPOINTS[name] });
    }
    return resolved;
  }
  if (input.viewport) {
    return [{ name: 'viewport', ...input.viewport }];
  }
  return [{ name: 'desktop', ...BREAKPOINTS.desktop }];
}
