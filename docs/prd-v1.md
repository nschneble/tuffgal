# Tuffgal product requirements (v1)

> Status: **Approved · P1–P4 complete · P5–P6 in progress** · Last updated 2026-06-04

This document captures the design intent and scope decisions behind
Tuffgal v1. It is the source-of-record for what the product _is_ and what
it deliberately _isn't_.

The source code is the source-of-truth for what currently works. This
document explains why it works how it does.

## TL;DR

Tuffgal is a JSON-driven visual-regression harness for any web app a
Playwright browser can render. **Declarative actions + stories** authored
in JSON run against the real running app. Every action ends with a
screenshot that becomes a **committable visual library**, so the regression
net is the artifact, not a coverage percentage. When a screenshot changes,
a human looks at the diff and decides.

Same Playwright substrate as `@playwright/test`. Same stability primitives
such as locator-first, masking, and route intercepts. What's different is
**there is no test code per scenario**. A team adds Tuffgal to a project,
writes 5–10 reusable actions, chains them into stories, and gets a
regression net the same day.

**Spoilers:** AI fuzzy matching + self-healing will be the eventual
differentiator. For now, v1 is a rock-solid, declarative visual regression
tool that doesn't make you write test code.

## The problem

Today's testing landscape forces a binary choice:

**Write component tests using Vitest, RTL, or Jest.** They're fast and
isolated, but mock reality. They provide false confidence because they can
pass silently when the rendered product breaks.

**Write e2e tests using Playwright or Cypress.** It's a real browser + DOM,
but every scenario is bespoke TypeScript. Authoring cost is high. The
resulting test suites are write-only and flake under animation, hydration,
and async data races.

Tuffgal sits between them. Declarative JSON actions + stories are authored
once and parameterized at use sites. They run against the real app. Visual
diffs catch what assertions can't enumerate. Authoring is fast enough that
adding a new flow can be done in a few minutes.

The pilot consumer ([Linklater](https://github.com/nschneble/linklater))
proves this works in production: 24 stories, 21 user-journey flows, and
zero flakes across multiple consecutive runs while replacing 462 component
tests.

## Goals

**Framework agnostic.** Support any browser-renderable web app, including
React + Vite, Next.js, Vue, Svelte, and SolidJS. Plus server-rendered
stacks such as Ruby on Rails, Vapor/Leaf, Django, and Express/EJS.

**Lean harness, rich actions/stories.** The core contains the schema,
scheduler, and runner. App-specific logic (e.g. fixtures, dev servers, and
the test-mode contract) lives in the consumer project in a config file.

**Zero new step primitives at extraction time.** The existing primitives
(`click`, `input`, `intercept`, `navigate`, `scroll`, `wait`, `waitFor`)
are sufficient. New primitives must clear a high bar: a real user-facing
scenario the existing set cannot express.

**First-class CI story.** GitHub Action for `uses:`, conditional artifact
upload, and SARIF-compatible output for code-scanning integrations.

**Example directory.** Should contain at least one runnable recipe per
supported tech stack.

## Non-goals (v1)

**AI fuzzy matching.** Schema reserves the `position` field and an `AI=1`
env hook for LLM fallback, but there's no provider integration yet. Will be
the main feature and driving force in a future release.

**Hosted SaaS.** OSS only. Cloud runs, dashboards, and team accounts are
deferred for a future release.

**Native mobile.** React Native, iOS, and Android are out of scope. The
Playwright substrate cannot drive them. It's a separate product.

**Multi-format authoring.** JSON only. No YAML, no TypeScript DSLs.

**Sub-Playwright substrate swap.** Tuffgal is built on Playwright library
mode. Consider WebDriver or Puppeteer adapters in a future release.

**Browser breadth.** Chromium only for now. Firefox and WebKit deferred to
a future release, or until a consumer requires them.

## Users + scenarios

### Primary persona: "Pragmatic full-stack engineer"

Owns or maintains a small-to-medium web app. 10 screens, 20 flows. Wants
confidence that UI changes don't regress without writing a 1,000 lines of
test code. Already uses Playwright or Cypress and finds them costly to
maintain.

### Adoption scenarios

| Scenario                              | Tuffgal value                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| New project, no tests yet             | Author 5–10 actions, chain into stories. Get a regression net the same day               |
| Existing React app w/ component tests | Delete component tests covered by Tuffgal stories. Keep utility/hook unit tests          |
| Server-rendered Rails app             | Same JSON actions. Replace the "no component test" gap with cross-flow visual regression |
| CI adoption                           | Drop in the GitHub Action. Commit baselines. PR comments on visual changes               |

## Architecture overview

Tuffgal core is framework-agnostic because it operates at the HTTP + DOM
layer via Playwright. Everything app-specific lives behind four pluggable
bridges declared in `tuffgal.config.ts`.

```
┌─────────────────────────────────────────────────────┐
│                   Tuffgal harness                   │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│ │ Schema   │ │ Runner   │ │ Reporter │ │ CLI      │ │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│ │ Steps    │ │ Locator  │ │ Diff     │ │ Trace    │ │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
└─────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐ ┌───────────────────┐ ┌──────────────┐
│ DB bridge    │ │ Dev-server bridge │ │ App contract │
└──────────────┘ └───────────────────┘ └──────────────┘
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                   ┌───────────────┐
                   │ Consumer app  │
                   └───────────────┘
```

### What stays in core (framework-agnostic)

- Schema: `action.ts`, `story.ts`, `result.ts`; zod-validated JSON
- Scheduler: DAG topo-sort + cycle detection + parallel workers
- Runner: action dispatch, step retry, `expect.anyOf`, masking
- Step primitives: `click`, `input`, `intercept`, `navigate`, `scroll`, `wait`, `waitFor`
- Locator resolver: role+text → role → selector → text precedence (`position` reserved for AI)
- Screenshot capture + SSIM + pixelmatch + a11y tree snapshot
- Baseline store + approve flow
- Reporter: HTML + traces + SARIF output
- Coverage collector: V8 (monocart) wrapped (optional)
- Clock freeze + storage state persistence + DAG-based label sharing

### What lives in the consumer project

- DB reset + fixture callbacks → declared on `config.database`
- Dev-server command + health check → declared on `config.devServers`
- `actions/`, `stories/`, `baselines/` content → consumer-owned directories
- Test-mode contract (env var-driven behavior changes in the app) → consumer documents and implements; Tuffgal supplies a recommended recipe in [`app-contract.md`](app-contract.md)
- Flow inventory path → `config.flowInventory`

## Public API

### Config file: `tuffgal.config.ts`

The single source of truth at consumer-project root. Full reference in
[`config.md`](config.md).

```ts
import { defineConfig } from 'tuffgal';

export default defineConfig({
  apiHost: 'http://localhost:3000',
  baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  database: {
    reset: async () => {
      /* TRUNCATE, reseed test user */
    },
    fixtures: {
      name: async () => {
        /* idempotent inserts */
      },
    },
  },
  defaultTimeoutMs: 10_000,
  devServers: {
    command: 'npm run dev:test',
    healthCheck: [
      { url: 'http://localhost:3000', timeoutMs: 60_000 },
      { url: 'http://localhost:5173', timeoutMs: 60_000 },
    ],
  },
  flowInventory: 'docs/user-journeys.md',
  paths: {
    actions: 'tuffgal/actions',
    baselines: 'tuffgal/baselines',
    report: 'tuffgal/report',
    stories: 'tuffgal/stories',
  },
  storageStatePins: ['session_token'],
  viewport: { width: 1280, height: 800 },
  workers: undefined,
});
```

### CLI

```bash
npx tuffgal approve [--story <name>]  # accept changed baselines
npx tuffgal init                      # scaffold tuffgal.config.ts
npx tuffgal run                       # run all stories
npx tuffgal run --coverage            # V8 coverage
npx tuffgal run --headed              # show browser
npx tuffgal run --manage-servers      # spawn devServers per config
npx tuffgal run --story <name>        # one story
npx tuffgal run --workers <n>         # parallelism
npx tuffgal supervise                 # long-running devServers wrapper
```

### GitHub Action (planned)

```yaml
- uses: tuffgal/tuffgal-action@v1
  with:
    config: tuffgal.config.ts
    manage-servers: true
    upload-on: change-or-fail # change | fail | change-or-fail
```

Sibling repo `tuffgal/tuffgal-action`. Ships in P5.

### Homebrew (planned, post-v1)

```bash
brew install tuffgal/tap/tuffgal
tuffgal run
```

Same CLI under a different distribution path. Useful for non-Node projects
(e.g. Ruby on Rails) where the team would otherwise install Node just to
run tests. Tuffgal would bundle the Node runtime in the formula. Deferred
until post-v1 stabilization.

### Programmatic API

```ts
import { loadConfig, runAll, type RunResult } from 'tuffgal';

const config = await loadConfig(process.cwd());
const result: RunResult = await runAll(config, { headed: false });
```

See [`src/index.ts`](../src/index.ts) for more.

## Pluggable bridge design

### DB bridge, callback-based

Consumer supplies functions on `config.database`. No driver opinion. No
imports of pg/mysql/sqlite/mongo in Tuffgal core. See
[`examples/postgres-prisma/`](../examples/postgres-prisma/) for a working
Postgres + Prisma recipe.

```ts
database: {
  reset:    async () => { /* truncate + reseed */ },
  fixtures: { 'user-with-records': async () => { /* insert */ } },
}
```

Tuffgal calls `reset()` once per run (before the scheduler starts) and
`fixtures[name]()` per story declaration. The story DAG handles ordering.

### Dev-server bridge

Consumer declares the shell command + health check URLs.

```ts
devServers: {
  command: 'npm run dev:test',
  cwd: '..', // optional
  healthCheck: [
    { url: 'http://localhost:3000', timeoutMs: 60_000 },
    { url: 'http://localhost:5173', timeoutMs: 60_000 },
  ],
  shutdownGraceMs: 5_000,    // SIGKILL after
  shutdownSignal: 'SIGTERM', // default
}
```

Used by:

- `--manage-servers` (one-shot, CI-style)
- `tuffgal supervise` (long-running, local iteration-style)

See [`supervisor.md`](supervisor.md).

### App contract, test-mode env

Tuffgal documents a _recommended_ contract for the consumer app to
implement. See [`app-contract.md`](app-contract.md).

The important bits:

- Set `TUFFGAL=1` (or any chosen env var) when the app runs under the harness
- Bypass rate limiters
- Return deterministic responses where the production path is non-deterministic (random recommendations, third-party reads)
- Skip background jobs (RSS polls, email sends)
- Pin clock if the app does any time-driven UI server-side

The contract is **not enforced** by Tuffgal. The consumer's app is wholly
responsible. Tuffgal supplies route-intercept primitives so consumers can
short-circuit non-deterministic endpoints at the browser layer when the
server-side contract isn't feasible (e.g. third-party APIs).

### Storage state pins

Configurable list of `localStorage` keys Tuffgal persists across stories.

```ts
storageStatePins: ['session_token', 'refresh_token'],
```

Set `storageStatePins: []` for session cookie-based apps (e.g. Rails)
because cookies auto-persist via Playwright's storage state. The field
becomes a no-op for cookie apps.

## Release plan

| Phase                        | Output                                                                  | Status         |
| ---------------------------- | ----------------------------------------------------------------------- | -------------- |
| **P1: Repo bootstrap**       | New repo, license, README, package.json, CI skeleton                    | ✅ Complete    |
| **P2: Core extraction**      | Move framework-agnostic code, wire up config interface                  | ✅ Complete    |
| **P3: Docs + scaffolder**    | Docs, `init`, `supervise`, `examples/postgres-prisma`                   | ✅ Complete    |
| **P4: Pilot migration**      | First consumer fully on Tuffgal, verify parity                          | ✅ Complete    |
| **P5: GitHub Action**        | Sibling repo + composite action wrapping `tuffgal run --manage-servers` | 🔄 In progress |
| **P6: v0.1.0-alpha release** | npm publish with provenance, smoke from public install                  | 🔄 In progress |
| **P7: v1.0.0**               | README polish, additional examples directory, public announce           | Planned        |
| **P8: v1.1.0 (AI)**          | LLM fallback in resolver, BYOLLM via `AI_PROVIDER` env                  | Deferred       |

## Open questions / risks

**Storage state for cookie-based apps.** Playwright auto-persists cookies
via `context.storageState()`. Tuffgal's abstraction layers over this. Needs
confirmation from a server-rendered consumer that cookie flows survive
label-based storage-state inheritance.

**Homebrew formula bundling.** Distributing Node + Chromium via brew is
non-trivial. May need `pkg` or a similar tool to produce a standalone
binary. Deferred to post-v1 if it blocks launch.

**Documentation site.** README + `docs/` are enough for v1, but a docs site
such as Astro Starlight or Mintlify raises the bar for adoption. Deferred
unless adoption traction justifies the maintenance cost.

**Trademark search.** "Tuffgal" needs USPTO + EU IPO check before
commercial use. v1 is OSS-only so lower urgency, but worth running before
any logo work.

**AI fallback shape for v1.1.0.** BYOLLM is the working assumption; the
consumer brings their own provider key and Tuffgal calls out for hint
disambiguation. Provider abstraction TB. Thinking of OpenAI-compatible API,
Anthropic, and local via Ollama. Out of scope for v1.

## Appendix, final decisions baked in

- **AI:** v1.1 (BYOLLM)
- **Browser:** Chromium only (v1)
- **DB integration:** Callback-based (no driver opinion)
- **Format:** JSON only (zod-validated)
- **Framework scope:** React + Vite, Next, Vue/Svelte/Solid, server-rendered (Rails/Vapor/Django/Express)
- **Hosted:** OSS only at launch
- **License:** MIT
- **Name:** Tuffgal
- **Node:** 22+ (`--experimental-strip-types` mode; no build step)
- **Packaging:** npm + CLI + GitHub Action; Homebrew formula (post-v1)
- **Repo strategy:** Standalone open-source product, MIT licensed
- **Substrate:** Playwright library mode
