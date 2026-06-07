# Config reference

`tuffgal.config.ts` is the main integration point between your project and
Tuffgal. This document lists every field on `TuffgalConfig` with its type,
default, and intent.

Run `npx tuffgal init` to scaffold a starter config in the current directory.

## Top-level

```ts
import { defineConfig } from 'tuffgal';

export default defineConfig({
  paths: {
    /* … */
  },
  baseUrl: 'http://localhost:5173',
  // optional fields below
});
```

`defineConfig` is an identity helper. Its only job is type-checking the
object against `TuffgalConfig`. The default export is what Tuffgal loads at
startup.

All file-path fields are resolved relative to the directory containing
`tuffgal.config.ts`.

## Required fields

### `paths: PathsConfig`

Where Tuffgal reads + writes content. All paths are relative to the config
file's location.

| Field       | Type      | Default    | Meaning                                                                              |
| ----------- | --------- | ---------- | ------------------------------------------------------------------------------------ |
| `actions`   | `string`  | _required_ | Directory of action JSON files. Recurses into subdirectories                         |
| `authState` | `string?` | `.auth`    | Storage state cache for `produces`/`needs` label inheritance (**add to .gitignore**) |
| `baselines` | `string`  | _required_ | Committed PNG baselines and a11y snapshots                                           |
| `stories`   | `string`  | _required_ | Directory of story JSON files. Recurses into subdirectories                          |
| `report`    | `string`  | _required_ | Generated HTML report and traces. (**add to .gitignore**)                            |

> `tuffgal init` scaffolds `authState: 'tuffgal/.auth'` so the cache stays
> inside the `tuffgal/` content directory next to actions, stories, and
> baselines. The lone `.auth` default applies only when you write the
> config by hand and omit the field.

### `baseUrl: string`

Base URL of the running app. Every `navigate` step path is resolved against
this. Typical values are `http://localhost:5173` for Vite and
`http://localhost:3000` for Next.js.

## Optional fields

### `apiHost?: string`

Origin (scheme + host + port) of your API. `intercept` patterns that begin
with this host stay scoped to API traffic and do not accidentally match
Vite source-module URLs or hot-reload sockets.

Set this only when your API runs on a different origin than your web app.

### `storageStatePins?: string[]`

`localStorage` keys to persist across stories via the storage-state cache.
Cookie-based apps can leave this empty because cookies always persist
through Playwright's storage state.

JWTs, refresh tokens, dark-mode preferences, and accessibility preferences
are common candidates.

### `viewport?: { width: number; height: number }`

Browser viewport. Defaults to `{ width: 1280, height: 800 }`. Choose
dimensions that match the breakpoint most of your stories should screenshot
at. Per-story overrides are not yet supported.

### `defaultTimeoutMs?: number`

Default Playwright locator and action timeout. Defaults to `10_000`.
Applies to every `click`, `input`, `waitFor`, and `expect` candidate that
does not declare its own `timeoutMs`.

### `navigationTimeoutMs?: number`

Default navigation timeout for `navigate` steps. Defaults to `15_000`. Bump
this if your app's initial render is slow under test mode.

### `frozenTime?: string`

ISO timestamp passed to `page.clock.install`. Pins `Date.now()` and
`new Date()` inside the browser to a known instant. Relative-time UI
("3 minutes ago") becomes deterministic and screenshot diffs stop
flickering.

Default: `2026-01-15T12:00:00.000Z`. Pick any instant that lands inside the
date range your stories exercise. Server-side time is _not_ affected. See
[app-contract.md](app-contract.md) for the server-clock pattern.

### `workers?: number`

Story-pool worker count. Default: `min(cpus / 2, 4)`. Override only when
measuring. More workers = more parallel browser contexts = more memory.

### `database?: DatabaseBridge`

Consumer-supplied DB bridge. Skip the entire block for static sites.

```ts
database: {
  reset: async () => { /* truncate + reseed */ },
  fixtures: {
    'name-1': async () => { /* idempotent inserts */ },
    'name-2': async () => { /* idempotent inserts */ },
  },
}
```

- `reset` runs once before the scheduler dispatches the first story
- `fixtures[name]` runs before any story that declares `fixtures: ["name"]`

Fixtures must be idempotent. Tuffgal applies them per story without a
per-story database reset. See
[examples/postgres-prisma/](../examples/postgres-prisma/).

### `devServers?: DevServerBridge`

Used by `tuffgal run --manage-servers` and `tuffgal supervise`. Skip when
you run the dev servers yourself.

| Field             | Type                                         | Default     | Meaning                                             |
| ----------------- | -------------------------------------------- | ----------- | --------------------------------------------------- |
| `command`         | `string`                                     | _required_  | Shell command. Run via `sh -c` so pipes + `&&` work |
| `cwd`             | `string?`                                    | `rootDir`   | Working directory relative to the config file       |
| `healthCheck`     | `Array<{ url: string; timeoutMs?: number }>` | _required_  | URLs probed via TCP `connect` before ready          |
| `shutdownGraceMs` | `number?`                                    | `5000`      | Grace period before `SIGKILL`                       |
| `shutdownSignal`  | `NodeJS.Signals?`                            | `'SIGTERM'` | Signal sent on shutdown                             |

Health-check URLs are probed via TCP (not HTTP) so self-signed certificates
and 404 responses do not block readiness.

### `flowInventory?: string`

Path to a Markdown file listing your user journeys. One per row in a single
table. Tuffgal counts how many stories declare a matching `flow:` field and
exposes the ratio as `customCoverage.flows` in the report.

Useful for tracking "have we written stories for every flow in our PRD?"

## Loading order

1. `loadConfig(cwd)` searches `cwd` for `tuffgal.config.ts`, then `tuffgal.config.js`
2. First match is dynamically imported and the default export is read
3. Missing `default` export → descriptive error
4. Optional fields are filled with the defaults above (result is `ResolvedConfig`)

`ResolvedConfig` is what downstream code consumes. Every optional input
field has a concrete value on the resolved side, so internal code does not
need per-field `??` fallbacks.

## Environment overrides

Tuffgal does not auto-read environment variables on your behalf. If you
want runtime overrides, read them in your config file:

```ts
baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
workers: process.env.CI ? 2 : undefined,
```

This keeps the override surface visible in one file rather than hidden in
framework convention.

## Public API

The `tuffgal` package's barrel re-exports the following:

```ts
import {
  approveAll,
  defineConfig,
  init,
  loadConfig,
  runAll,
  supervise,
  type Action,
  type ActionResult,
  type ActionStatus,
  type ApproveOptions,
  type DatabaseBridge,
  type DevServerBridge,
  type Hint,
  type InitOptions,
  type PathsConfig,
  type ResolvedConfig,
  type RunCliOptions,
  type RunResult,
  type Step,
  type Story,
  type StoryResult,
  type StoryStatus,
  type SuperviseOptions,
  type TuffgalConfig,
} from 'tuffgal';
```

Anything not re-exported here is internal and may break between releases.
