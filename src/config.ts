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
 * CI-friendly result emitters. Optional. The default reporter (HTML at
 * `paths.report/index.html`) always runs.
 */
export interface CiConfig {
  /** Path to write SARIF results.json for GitHub code scanning. */
  sarif?: string;
  /** Paths to advertise as `actions/upload-artifact` candidates. */
  artifactPaths?: string[];
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
  /** CI integration knobs. */
  ci?: CiConfig;
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
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  frozenTime: string;
  workers: number | undefined;
  database: DatabaseBridge | undefined;
  devServers: DevServerBridge | undefined;
  flowInventory: string | undefined;
  ci: CiConfig | undefined;
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
    return resolveConfig(module.default, resolve(cwd, '.'));
  }
  throw new Error(
    `No tuffgal.config.ts or tuffgal.config.js found in ${cwd}. Run ` +
      `\`npx tuffgal init\` to scaffold one.`,
  );
}

function resolveConfig(input: TuffgalConfig, rootDir: string): ResolvedConfig {
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
    viewport: input.viewport ?? DEFAULTS.viewport,
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
    ci: input.ci,
  };
}
