# Configuration reference

`tuffgal.config.ts` is the single integration point between your project and Tuffgal. This document lists every field on `TuffgalConfig` with its type, default, and intent.

Run `npx tuffgal init` to scaffold a starter config in the current directory.

## Top-level shape

```ts
import { defineConfig } from 'tuffgal';

export default defineConfig({
  paths:     { /* … */ },
  baseUrl:   'http://localhost:5173',
  // optional fields below
});
```

`defineConfig` is an identity helper. Its only job is type-checking the object against `TuffgalConfig`. The default export is what Tuffgal loads at startup.

All file-path fields are resolved relative to the directory containing `tuffgal.config.ts`.

## Required fields

### `paths: PathsConfig`

Where Tuffgal reads + writes content. All paths are relative to the config file's location.

| Field        | Type      | Default    | Meaning                                                                      |
| ------------ | --------- | ---------- | ---------------------------------------------------------------------------- |
| `actions`    | `string`  | _required_ | Directory of action JSON files. Recurses into subdirectories.                |
| `stories`    | `string`  | _required_ | Directory of story JSON files. Recurses into subdirectories.                 |
| `baselines`  | `string`  | _required_ | Committed PNG baselines + a11y snapshots.                                    |
| `report`     | `string`  | _required_ | Generated HTML report + traces. **Gitignore this.**                          |
| `authState`  | `string?` | `.auth`    | Storage state cache for `produces`/`needs` label inheritance. Gitignore too. |

### `baseUrl: string`

Base URL of the running app. Every `navigate` step path is resolved against this. Typical values: `http://localhost:5173` (Vite), `http://localhost:3000` (Next.js dev), `https://localhost:5173` (Vite + HTTPS).

## Optional fields

### `apiHost?: string`

Origin (scheme + host + port) of your API. `intercept` patterns that begin with this host stay scoped to API traffic and do not accidentally match Vite source-module URLs or hot-reload sockets.

Set this only when your API runs on a different origin than your web app.

### `storageStatePins?: string[]`

`localStorage` keys to persist across stories via the storage-state cache. Cookie-based apps can leave this empty — cookies always persist through Playwright's storage state.

JWT, refresh tokens, dark-mode preference, accessibility preferences are common candidates.

### `viewport?: { width: number; height: number }`

Browser viewport. Defaults to `{ width: 1280, height: 800 }`. Choose dimensions that match the breakpoint most of your stories should screenshot at. Per-story overrides are not yet supported.

### `defaultTimeoutMs?: number`

Default Playwright locator and action timeout. Defaults to `10_000`. Applies to every `click`, `input`, `waitFor`, and `expect` candidate that does not declare its own `timeoutMs`.

### `navigationTimeoutMs?: number`

Default navigation timeout for `navigate` steps. Defaults to `15_000`. Bump this if your app's initial render is slow under test mode.

### `frozenTime?: string`

ISO timestamp passed to `page.clock.install`. Pins `Date.now()` and `new Date()` inside the browser to a known instant. Relative-time UI ("3 minutes ago") becomes deterministic and screenshot diffs stop flickering.

Default: `2026-01-15T12:00:00.000Z`. Pick any instant that lands inside the date range your stories exercise. Server-side time is *not* affected; see [app-contract.md](app-contract.md) for the server-clock pattern.

### `workers?: number`

Story-pool worker count. Default: `min(cpus / 2, 4)`. Override only when measuring — more workers = more parallel browser contexts = more memory.

### `database?: DatabaseBridge`

Consumer-supplied DB bridge. Skip the entire block for static sites.

```ts
database: {
  reset:    async () => { /* truncate + reseed */ },
  fixtures: {
    'name-1': async () => { /* idempotent inserts */ },
    'name-2': async () => { /* idempotent inserts */ },
  },
}
```

- `reset` runs once before the scheduler dispatches the first story.
- `fixtures[name]` runs before any story that declares `fixtures: ["name"]`.

Fixtures must be idempotent. Tuffgal applies them per story without per-story DB reset. See [examples/postgres-prisma/](../examples/postgres-prisma/).

### `devServers?: DevServerBridge`

Used by `tuffgal run --manage-servers` and `tuffgal supervise`. Skip when you run dev servers yourself.

| Field             | Type                                              | Default      | Meaning                                          |
| ----------------- | ------------------------------------------------- | ------------ | ------------------------------------------------ |
| `command`         | `string`                                          | _required_   | Shell command. Run via `sh -c` so pipes + `&&` work. |
| `cwd`             | `string?`                                         | `rootDir`    | Working directory, relative to the config file.  |
| `healthCheck`     | `Array<{ url: string; timeoutMs?: number }>`      | _required_   | URLs probed via TCP `connect` before ready.      |
| `shutdownSignal`  | `NodeJS.Signals?`                                 | `'SIGTERM'`  | Signal sent on shutdown.                         |
| `shutdownGraceMs` | `number?`                                         | `5000`       | Grace period before `SIGKILL`.                   |

Health-check URLs are probed via TCP (not HTTP) so self-signed certificates and 404 responses do not block readiness.

### `flowInventory?: string`

Path to a markdown file listing your user journeys (one per row in a single markdown table). Tuffgal counts how many stories declare a matching `flow:` field and exposes the ratio as `customCoverage.flows` in the report.

Useful for tracking "have we written a story for every flow in our PRD yet?"

### `ci?: CiConfig`

CI integration knobs. Optional. The HTML reporter at `paths.report/index.html` always runs.

| Field           | Type        | Meaning                                                   |
| --------------- | ----------- | --------------------------------------------------------- |
| `sarif`         | `string?`   | Path to write SARIF `results.json` for GitHub code scanning. |
| `artifactPaths` | `string[]?` | Paths to advertise as `actions/upload-artifact` candidates. |

See [ci.md](ci.md) for the recipe.

## Loading order

1. `loadConfig(cwd)` searches `cwd` for `tuffgal.config.ts`, then `tuffgal.config.js`.
2. First match is dynamically imported. The default export is read.
3. Missing `default` export → descriptive error.
4. Optional fields are filled with the defaults above. Result is `ResolvedConfig`.

`ResolvedConfig` is the shape downstream code consumes. Every optional input field has a concrete value on the resolved side, so internal code does not need per-field `??` fallbacks.

## Environment overrides

Tuffgal does not auto-read environment variables on your behalf. If you want runtime overrides, read them in your config file:

```ts
baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
workers: process.env.CI ? 2 : undefined,
```

This keeps the override surface visible in one file rather than hidden in framework convention.

## Public API

The `tuffgal` package's barrel re-exports the following:

```ts
import {
  defineConfig,
  loadConfig,
  runAll,
  approveAll,
  supervise,
  init,
  type TuffgalConfig,
  type ResolvedConfig,
  type DatabaseBridge,
  type DevServerBridge,
  type PathsConfig,
  type CiConfig,
  type RunCliOptions,
  type ApproveOptions,
  type SuperviseOptions,
  type InitOptions,
  type Action,
  type Step,
  type Hint,
  type Story,
  type RunResult,
  type StoryResult,
  type ActionResult,
  type ActionStatus,
  type StoryStatus,
} from 'tuffgal';
```

Anything not re-exported here is internal and may break between minor releases.
