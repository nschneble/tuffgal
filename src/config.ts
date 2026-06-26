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
 * How much of the page each screenshot captures:
 *   - `viewport` — only the breakpoint's `width x height` box, matching what a
 *     real user sees above the fold. The default.
 *   - `fullPage` — the whole scrollable document, however tall. Catches
 *     below-the-fold regressions at the cost of viewport fidelity (a long page
 *     renders at e.g. 1280x2500 instead of 1280x800).
 */
export type CaptureMode = 'viewport' | 'fullPage';

/**
 * One resolved breakpoint mode: a name plus the viewport dimensions to render
 * at. Built from a {@link BreakpointSelector} (a registry entry, optionally
 * with a dimension override). Exported so the runner consumes the same shape
 * `resolveConfig` emits instead of redeclaring its own copy.
 */
export type ResolvedBreakpoint = {
  name: string;
  width: number;
  height: number;
};

/**
 * One breakpoint selection in `config.breakpoints` (and per-story
 * `breakpoints`): either a bare registry name — render at that mode's built-in
 * dimensions — or `{ name, width?, height? }` to override the viewport for that
 * mode. An omitted `width`/`height` inherits the registry default for the
 * named mode. Bare-string entries keep older `['mobile', 'desktop']` configs
 * working unchanged.
 */
export type BreakpointSelector =
  | BreakpointName
  | { name: BreakpointName; width?: number; height?: number };

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
  /**
   * Breakpoint modes this project runs, drawn from the built-in
   * {@link BREAKPOINTS} registry (`mobile` | `tablet` | `laptop` | `desktop`).
   * Each entry is either a bare name (registry dimensions) or
   * `{ name, width?, height? }` to override that mode's viewport — an omitted
   * `width`/`height` inherits the registry default. Order is preserved; when a
   * name repeats, the first entry wins and later duplicates are dropped. Omit
   * the field to run a single `desktop` breakpoint (1280x800).
   */
  breakpoints?: BreakpointSelector[];
  /**
   * How much of the page each screenshot captures. `viewport` (default) crops
   * to the breakpoint's `width x height` so diffs reflect what the user sees
   * above the fold; `fullPage` composites the whole scrollable document. See
   * {@link CaptureMode}.
   */
  captureMode?: CaptureMode;
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
   * viewport dimensions to render at. Built from `config.breakpoints` when set,
   * else a single `desktop` default. Typed as a non-empty tuple so callers can
   * read `breakpoints[0]` without an undefined check under
   * noUncheckedIndexedAccess.
   */
  breakpoints: [ResolvedBreakpoint, ...ResolvedBreakpoint[]];
  /** Resolved screenshot scope; defaults to `viewport`. */
  captureMode: CaptureMode;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  frozenTime: string;
  workers: number | undefined;
  database: DatabaseBridge | undefined;
  devServers: DevServerBridge | undefined;
  flowInventory: string | undefined;
}

const DEFAULTS = {
  captureMode: 'viewport',
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

  if (
    config.captureMode !== undefined &&
    config.captureMode !== 'viewport' &&
    config.captureMode !== 'fullPage'
  ) {
    fail("`captureMode` must be 'viewport' or 'fullPage' when provided.");
  }

  if (config.breakpoints !== undefined) {
    const validNames = Object.keys(BREAKPOINTS);
    const breakpoints = config.breakpoints;
    if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
      fail(
        '`breakpoints` must be a non-empty array of breakpoint names or ' +
          'override objects.',
      );
    }
    for (const entry of breakpoints as unknown[]) {
      const name =
        typeof entry === 'string'
          ? entry
          : (entry as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !validNames.includes(name)) {
        fail(
          `\`breakpoints\` contains an unknown breakpoint ${JSON.stringify(
            entry,
          )}. Valid names: ${validNames.join(', ')}.`,
        );
      }
      if (typeof entry === 'object' && entry !== null) {
        const override = entry as Record<string, unknown>;
        for (const dim of ['width', 'height'] as const) {
          if (
            override[dim] !== undefined &&
            (typeof override[dim] !== 'number' || (override[dim] as number) <= 0)
          ) {
            fail(
              `\`breakpoints[].${dim}\` must be a positive number when provided.`,
            );
          }
        }
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
    captureMode: input.captureMode ?? DEFAULTS.captureMode,
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
 * Resolves one {@link BreakpointSelector} to its concrete dimensions: a bare
 * name takes the registry defaults, an override object layers its `width`/
 * `height` over them. Validation guarantees the name is a valid registry key
 * by the time we get here.
 */
function normaliseSelector(selector: BreakpointSelector): ResolvedBreakpoint {
  if (typeof selector === 'string') {
    return { name: selector, ...BREAKPOINTS[selector] };
  }
  const base = BREAKPOINTS[selector.name];
  return {
    name: selector.name,
    width: selector.width ?? base.width,
    height: selector.height ?? base.height,
  };
}

/**
 * Resolves a list of selectors to concrete breakpoints, preserving order and
 * dropping duplicate names (first entry wins). Shared by config-level and
 * per-story breakpoint resolution so both normalise the same way: each list
 * stands alone, resolved against the registry, never cross-referencing the
 * other. The caller guarantees the input is non-empty.
 */
export function resolveSelectorList(
  selectors: BreakpointSelector[],
): ResolvedBreakpoint[] {
  const seen = new Set<string>();
  const resolved: ResolvedBreakpoint[] = [];
  for (const selector of selectors) {
    const breakpoint = normaliseSelector(selector);
    if (seen.has(breakpoint.name)) continue;
    seen.add(breakpoint.name);
    resolved.push(breakpoint);
  }
  return resolved;
}

/**
 * Resolves `config.breakpoints` to an always-non-empty list: the explicit
 * selectors when set (order preserved, duplicate names dropped — first wins),
 * else a single `desktop` breakpoint (1280x800). `assertValidConfig` has
 * already rejected unknown/empty `breakpoints`, so a non-empty input dedupes to
 * at least one entry; the cast restores the non-empty tuple type that lets
 * `breakpoints[0]` read without an undefined check under
 * noUncheckedIndexedAccess.
 */
function resolveBreakpoints(
  input: TuffgalConfig,
): [ResolvedBreakpoint, ...ResolvedBreakpoint[]] {
  if (input.breakpoints && input.breakpoints.length > 0) {
    return resolveSelectorList(input.breakpoints) as [
      ResolvedBreakpoint,
      ...ResolvedBreakpoint[],
    ];
  }
  return [{ name: 'desktop', ...BREAKPOINTS.desktop }];
}
