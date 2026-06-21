# Config reference

`tuffgal.config.ts` is the main integration point between your project and
Tuffgal. This document lists every field on `TuffgalConfig` with its type,
default, and intent.

Run `npx tuffgal init` to scaffold a starter config in the current directory.

## Top-level

```ts
import { defineConfig } from 'tuffgal';

export default defineConfig({
  // ── Required ───────────────────────────────────────────────────────────
  // Where Tuffgal reads + writes content. All paths relative to this file.
  paths: {
    actions: 'tuffgal/actions', // action JSON files (recurses into subdirs)
    stories: 'tuffgal/stories', // story JSON files (recurses into subdirs)
    baselines: 'tuffgal/baselines', // committed PNG baselines + a11y snapshots
    report: 'tuffgal/report', // generated HTML report + traces (gitignore)
    authState: 'tuffgal/.auth', // produces/needs label cache (gitignore); default '.auth'
  },
  // Base URL of the running app. Every `navigate` path resolves against this.
  baseUrl: 'http://localhost:5173',

  // ── Optional ───────────────────────────────────────────────────────────
  // API origin (scheme + host + port). Scopes `intercept` patterns to API
  // traffic. Set only when the API runs on a different origin than the app.
  apiHost: 'http://localhost:3000',
  // localStorage keys to persist across stories. Cookies persist regardless.
  storageStatePins: ['auth.jwt', 'prefs.theme'],
  // Viewport modes to run, from the built-in registry. Each renders in its
  // own context + produces its own baseline/diff/a11y snapshot. Bare name
  // uses registry dimensions; object overrides width/height. Order kept,
  // duplicate names dropped (first wins). Omit → single `desktop` (1280×800).
  breakpoints: ['mobile', { name: 'desktop', width: 1440, height: 900 }],
  // Default Playwright locator + action timeout (ms). Default: 10_000.
  defaultTimeoutMs: 10_000,
  // Default navigation timeout for `navigate` steps (ms). Default: 15_000.
  navigationTimeoutMs: 15_000,
  // ISO timestamp pinned into the browser via `page.clock.install`, so
  // relative-time UI stays deterministic. Default: '2026-01-15T12:00:00.000Z'.
  frozenTime: '2026-01-15T12:00:00.000Z',
  // Story-pool worker count. Default: min(cpus / 2, 4).
  workers: 4,
  // Consumer DB bridge. `reset` runs once before the first story; each
  // `fixtures[name]` runs before any story declaring `fixtures: ["name"]`.
  // Fixtures must be idempotent — no per-story reset. Omit for static sites.
  database: {
    reset: async () => {
      /* truncate + reseed */
    },
    fixtures: {
      'name-1': async () => {
        /* idempotent inserts */
      },
    },
  },
  // Dev-server bridge for `--manage-servers` / `supervise`. Omit when you
  // run the dev servers yourself.
  devServers: {
    command: 'npm run dev', // run via `sh -c` so pipes + `&&` work
    cwd: '.', // relative to this file; default rootDir
    healthCheck: [{ url: 'http://localhost:5173', timeoutMs: 30_000 }], // TCP probe
    shutdownSignal: 'SIGTERM', // default 'SIGTERM'
    shutdownGraceMs: 5000, // grace before SIGKILL; default 5000
  },
  // Markdown file listing user journeys. Tuffgal reports the ratio of
  // stories with a matching `flow:` as `customCoverage.flows`.
  flowInventory: 'docs/flows.md',
});
```

The example above sets every field for illustration. In practice only
`paths` and `baseUrl` are required — every optional field falls back to the
default noted in its comment. The sections below detail each one.

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

### `breakpoints?: BreakpointSelector[]`

The viewport modes your project runs, drawn from the built-in registry. Each
selected mode renders in its own browser context, in the order you list
(duplicate names dropped, first wins), and produces its own baseline, diff,
and a11y snapshot — so a single story can be regression-tested at several
widths at once.

| Name      | Dimensions | Tailwind anchor  |
| --------- | ---------- | ---------------- |
| `mobile`  | 375 × 667  | below `sm` (640) |
| `tablet`  | 768 × 1024 | `md` (768)       |
| `laptop`  | 1024 × 768 | `lg` (1024)      |
| `desktop` | 1280 × 800 | `xl` (1280)      |

Widths track Tailwind's default dimensional breakpoints so your runs line
up with the responsive cutoffs your CSS already keys off of. Heights are
conventional companions (Tailwind breakpoints are width-only).

Each entry is either a bare registry name or a `{ name, width?, height? }`
object that overrides that mode's dimensions. An omitted `width`/`height`
inherits the registry default.

```ts
breakpoints: ['mobile', { name: 'desktop', width: 1440, height: 900 }],
```

When omitted, Tuffgal runs a single `desktop` mode (1280 × 800), so a project
that never thinks about breakpoints just works.

Baselines are keyed by mode at `<baselines>/<action>/<breakpoint>.png`. A
project that baselined before breakpoints existed has its snapshots at the
legacy `<action>/0.png`; Tuffgal reads that as a fallback so existing
baselines keep matching. As you adopt new modes, their first run reports
`new` until you `approve` a baseline for each one.

Individual stories can run their own modes via the story-level `breakpoints`
field, which **replaces** this set for that story. See
[authoring.md](authoring.md#per-story-breakpoint-selection).

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
  BREAKPOINTS,
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
  type BreakpointName,
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
