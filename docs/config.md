# Config reference

`tuffgal.config.ts` is the main integration point between your project and
Tuffgal. This document lists every field on `TuffgalConfig` with its type,
default, and intent.

Run `npx tuffgal init` to scaffold a starter config in the current directory.

## Top-level

```ts
import { defineConfig } from 'tuffgal';

export default defineConfig({
  /*
   * Required fields
   */

  // where Tuffgal reads + writes content
  // all paths are relative to this config file
  paths: {
    // action JSON files (recursive)
    actions: 'tuffgal/actions',

    // story JSON files (recursive)
    stories: 'tuffgal/stories',

    // PNG baselines + a11y snapshots
    baselines: 'tuffgal/baselines',

    // generated HTML report + traces
    report: 'tuffgal/report',

    // produces/needs label cache
    authState: 'tuffgal/.auth',
  },

  // base URL of the running app
  // every `navigate` path resolves against this
  baseUrl: 'http://localhost:5173',

  /*
   * Optional fields
   */

  // API origin (scheme + host + port)
  // scopes `intercept` patterns to API traffic
  // set only when the API runs on a different origin than the app
  apiHost: 'http://localhost:3000',

  // localStorage keys to persist across stories
  storageStatePins: ['auth.jwt', 'prefs.theme'],

  // viewport modes to run from the built-in registry
  // each renders in its own context + produces its own baseline
  // bare name uses registry dimensions, object overrides width/height
  // omit to default to 'desktop' at 1280x800
  breakpoints: ['mobile', { name: 'desktop', width: 1440, height: 900 }],

  // default Playwright locator + action timeout in milliseconds
  defaultTimeoutMs: 10_000,

  // default navigation timeout for `navigate` steps in milliseconds
  navigationTimeoutMs: 15_000,

  // ISO timestamp pinned to the browser for deterministic relative times
  // e.g. so "5 min ago" is always "5 min ago"
  frozenTime: '2026-01-15T12:00:00.000Z',

  // story-pool worker count
  // defaults to min(cpus / 2, 4)
  workers: 4,

  // consumer DB bridge
  // `reset` runs once per breakpoint pass, before that pass's first story
  // each `fixtures[name]` runs before any story declaring it
  // fixtures must be idempotent
  database: {
    reset: async () => {
      // truncate + reseed
    },
    fixtures: {
      'name-1': async () => {
        // idempotent inserts
      },
    },
  },

  // dev-server bridge for `--manage-servers` / `supervise`. Omit when you
  // run the dev servers yourself
  devServers: {
    // run via `sh -c` so pipes + `&&` work
    command: 'npm run dev',

    // relative to this file, defaults to root directory
    cwd: '.',

    // TCP probe
    healthCheck: [{ url: 'http://localhost:5173', timeoutMs: 30_000 }],

    shutdownSignal: 'SIGTERM',
    shutdownGraceMs: 5000,
  },

  // Markdown file listing user journeys
  // Tuffgal reports the ratio of stories w/ matching flows
  flowInventory: 'docs/flows.md',

  // render captured actions as a single image with a hover/press mouse preview
  // layered over a Baseline/Actual/Diff radio group, instead of radio tabs
  interactiveMode: false,
});
```

The example above sets every field for illustration. In practice only
`paths` and `baseUrl` are required. Every optional field falls back to the
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

### `captureMode?: 'viewport' | 'fullPage'`

How much of the page each screenshot captures. Default: `viewport`.

- `viewport` — crops to the breakpoint's `width x height` box, so a snapshot
  shows exactly what a user sees above the fold (e.g. `1280x800` for
  `desktop`). A long page is _not_ stretched to its full scroll height.
- `fullPage` — composites the entire scrollable document, however tall (a long
  settings page might render at `1280x2500`). Catches below-the-fold
  regressions at the cost of viewport fidelity.

```ts
captureMode: 'viewport',
```

This applies to every captured action across every breakpoint. Switching modes
changes the image dimensions, so existing baselines stop matching and report
`new` until you `approve` fresh ones.

### `interactiveMode?: boolean`

How each captured action's screenshots are presented in the report. Default:
`false`.

- `false` — the report renders the radio-tab viewer: Baseline, Actual, and Diff
  each sit in their own panel and you switch between them with the tabs.
- `true` — the report renders a single screenshot per action with a mouse
  preview layered over it. By default it shows the `actual` capture; hovering
  the image previews the `baseline` and pressing (mouse down) previews the
  `diff`, so you can scrub between the three without leaving the image. The
  visual preview sits on top of an accessible Baseline/Actual/Diff radio group,
  so keyboard and touch users switch variants through the radios rather than the
  mouse gesture. The image is scaled to fit the viewport height.

```ts
interactiveMode: false,
```

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

- `reset` runs once per breakpoint pass, before that pass dispatches its first
  story (a single-breakpoint run is one pass, so `reset` runs once). See
  [authoring.md](authoring.md#multiple-breakpoints-run-as-separate-passes).
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
