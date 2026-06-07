# Authoring actions + stories

Quick reference for how to write reliable Tuffgal content. Read once before
authoring your first dozen actions. The harness will only catch real
regressions if its inputs are precise.

## The mental model

### Action

A reusable unit of user behavior. Atomic. Ends with at most one screenshot.
Lives under `paths.actions/`. Composed of `steps` plus optional `expect`,
`mask`, `retry`, `diff`, and `parameters`.

### Story

An ordered chain of actions that model a user journey. Lives under
`paths.stories/`. Declares `needs` (label prerequisites) and `produces`
(labels it emits if it passes) for the dependency graph.

#### Authoring rule of thumb

**Actions describe the HOW, stories describe the WHY.** A `save-record`
action says "navigate, click add, fill out form, submit." A
`user-saves-record` story says "As a logged-in user, I save a record."

## Hint resolution

Every interactive step (e.g. `click`, `input`, `waitFor`) takes a `hint`,
which is essentially the locator description. It's resolved in this
precedence order:

1. `{ role, text }:` Strongest contract. Uses Playwright's `getByRole(role, { name: text })`
2. `{ role }:` When the screen only has one of that role
3. `{ selector }:` Explicit CSS / Playwright selector engine
4. `{ text }:` A last resort. Loose `getByText(text)`

Prefer the highest level you can manage. A `role + text` hint survives
style refactors and CSS rewrites, but a raw CSS selector breaks the moment
a class name changes. Use `selector` only when role-based selection cannot
disambiguate.

`text` interpolates `${name}` placeholders against the action's
`parameters`. `selector` does too.

## Step primitives

| Kind        | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `click`     | Click the element matching `hint`                      |
| `input`     | Type `value` into the element matching `hint`          |
| `intercept` | Install a route handler for the rest of the story      |
| `navigate`  | Visit a path relative to `baseUrl`                     |
| `read`      | Assert `hint` resolves to an attached element          |
| `scroll`    | Scroll the page up or down by a pixel `amount`         |
| `type`      | Press a key/combo on the page (e.g. `Esc`, `Ctrl+K`)   |
| `wait`      | Block for `ms` milliseconds (use sparingly; see below) |
| `waitFor`   | Block until `hint` resolves (no interaction)           |

Avoid `wait` whenever `waitFor` would do. A locator-aware wait survives
layout speedups, but a wall-clock wait does not. The legitimate use for
`wait` is absorbing a paint race that no DOM signal exposes. This is
typically something like a staggered enter-animation tier (e.g. cards
fading in 100ms apart). See the
[mask + wait toolkit](#mask--wait-toolkit-for-staggered-enter-animations)
below for more guidance.

`read` is `waitFor` without the poll. Use it as a mid-flow checkpoint right
after a `click` or `input` that synchronously updates the DOM. It fails
immediately if the element isn't already attached, which surfaces a broken
hint faster than `waitFor`'s timeout. If the change could be asynchronous,
such as a network call, use `waitFor` or `expect.anyOf` instead.

```json
{ "kind": "read", "hint": { "role": "status", "text": "Saved" } }
```

`type` dispatches keyboard input on the page, outside of any focused input
field. Use it for hotkeys (`Ctrl+K` to open a command palette), modal
dismissal (`Esc`), or focus cycling (`Tab`). Individual keys (`"A"`), named
keys (`"Esc"`, `"Return"`), and key combos (`"Shift+A"`) all work.

```json
{ "kind": "type", "value": "Escape" }
{ "kind": "type", "value": "Control+K" }
```

## When to use which feature

### `expect.anyOf` (success criteria)

Use on every action whose final step kicks off async work. Examples include
clicking a submit button (e.g. HTTP POST + DOM update), submitting a login
form, or clicking a navigation link.

The harness polls every candidate concurrently and waits until one
resolves. Screenshot capture only happens after success. Without `expect`,
the screenshot could snap mid-render and visual diffs become messy.

```json
"expect": {
  "anyOf": [
    { "selector": "#records-list .record-card" },
    { "role": "status", "text": "Saved" }
  ],
  "timeoutMs": 10000
}
```

Use multiple candidates when the success state has several valid
renderings, such as a list item OR toast OR status banner. The harness wins
on the first to appear.

### `mask` (volatile regions)

Use when an element on the captured screen _should_ render but its content
is non-deterministic. Examples include relative timestamps, randomized
recommendation modules, animated counters, and anything driven by external
data.

```json
"mask": [
  { "selector": "[data-time-relative]" },
  { "selector": "[aria-live='polite']" }
]
```

Masks black out the matching elements before any screenshots, so the
underlying rectangles stay stable across runs. Tune the rectangle by
masking a tighter wrapper if you can. Masking an entire content area hides
real regressions too.

### Mask + wait toolkit for staggered enter animations

Modern UIs often stagger an element's children with a small per-item delay
so they fade in 80–150ms apart. Tuffgal's `expect` resolves the moment
_any_ candidate appears, which often means the first card has appeared but
cards 2 and 3 are still animating. The result is a screenshot that lands
mid-stagger and SSIM oscillates.

The two-part fix:

1. Add a brief `wait` after the action's success criteria fire. Tune to the stagger budget; usually 600–1200ms is enough for a 3–5 item stagger
2. Add a `mask` over any sibling region that animates independently of the action under test (e.g. live regions, suggestion callouts, badge counters)

```json
{
  "action": "login",
  "steps": [
    { "kind": "navigate", "path": "/login" },
    {
      "kind": "input",
      "hint": { "role": "textbox", "text": "Email" },
      "value": "test@example.test"
    },
    {
      "kind": "input",
      "hint": { "role": "textbox", "text": "Password" },
      "value": "…"
    },
    { "kind": "click", "hint": { "role": "button", "text": "Log in" } },
    { "kind": "wait", "ms": 1200 }
  ],
  "expect": { "anyOf": [{ "role": "heading", "text": "Welcome" }] },
  "mask": [{ "selector": "[aria-live='polite']" }]
}
```

### `retry` (transient flakes)

Use when a step is provably racing with hydration or animation. Bounded
retry on `LocatorNotFoundError` only. Every other error still fails
immediately.

```json
"retry": { "attempts": 2, "backoffMs": 200 }
```

Don't reach for retry as the first fix when a step misses. Check whether
`expect` on the _preceding_ action would solve the race condition. Retry
papers over flakiness, whereas `expect` removes its source.

### `intercept` (simulated backend states + server-state isolation)

Use this to force an error path, such as a 500, 404, or malformed body,
that the real back-end never produces in development. Set `method` to scope
the route to one verb so the page can still load its data via GET whilst a
POST fails. You know this is fancy stuff because I used "whilst."

```json
{
  "kind": "intercept",
  "pattern": "**/records",
  "method": "POST",
  "respond": { "status": 500, "body": { "message": "…" } }
}
```

It's also useful as the **intercept-noop pattern** for isolating
server-state mutations from the visual baseline. If your app pings a
"mark as seen" endpoint on view, every story that visits that page would
race the server.

Instead, stub the endpoint to a 204:

```json
{
  "kind": "intercept",
  "pattern": "**/notifications/seen",
  "method": "POST",
  "respond": { "status": 204 }
}
```

The route stays active for the rest of the story. Compose with later
actions to assert the error UI.

### `diff` thresholds (per-action tolerance)

Use when a screen has unavoidable minor drift (e.g. anti-aliased icons,
random gradient noise, sub-pixel layout shifts). Loosen `ssimThreshold` to
accept more perceptual drift before flagging `changed`.

```json
"diff": { "ssimThreshold": 0.985, "pixelThreshold": 0.1 }
```

Fields and defaults:

- `ssimThreshold` defaults to `0.99`. This is the perceptual gate and the
  primary control. Action passes when the mean SSIM is at least this high
  - `1.0` is identical
  - `0.99` ≈ "no perceptible change"
  - `0.95` is noticeable
  - Under `0.9` is obvious
- `pixelThreshold` defaults to `0.1`. This is the pixelmatch per-pixel
  similarity used to render the diff image. It does not gate pass/changed
  on its own. Tightens or loosens anti-aliasing tolerance in the overlay

Tighten or loosen deliberately and don't sprinkle it into every action.

## Fixtures (preloaded DB state)

Stories that need preloaded rows in the test database declare named
fixtures that run before the browser context launches.

```json
{
  "story": "User reviews their reading history",
  "needs": ["logged-in"],
  "fixtures": ["user-with-records"],
  "actions": [{ "action": "visit-records" }]
}
```

Fixtures are functions you supply on the consumer side via
`tuffgal.config.ts`:

```ts
database: {
  reset: resetTestDatabase,
  fixtures: {
    'user-with-records': loadUserWithRecords,
  },
},
```

Each fixture is a `() => Promise<void>` that mutates your test database
directly. Tuffgal calls them by name when a story declares them. Fixtures
must be idempotent. Tuffgal applies them per story without a per-story DB
reset. See [examples/postgres-prisma/](../examples/postgres-prisma/) for a
working recipe.

Fixtures apply against the same shared test database. Two stories that
mutate overlapping rows in parallel will race. Use `needs`/`produces` to
serialize them.

## Avoiding cross-story races

The test database is shared. Fixtures run before each story's browser
launches. Stories that mutate the _same_ user row (or the same view's
content) in parallel will produce non-deterministic visual diffs.

Rules of thumb:

- A story whose action's screenshot depends on observable user state (e.g. screenshots the records list after fixtures populate it) should pin that state via a `fixture`
- A story that mutates a column another story screenshots must serialize via `produces` + `needs`, e.g. if `user-saves-record` adds a row to `Record` and `user-views-records` screenshots `/records`, the latter must `needs` a label `produces`d by the former
- Settings mutation stories that all attach to the same user row are safe in parallel only when each screenshots its own success state and none of the downstream stories observe the mutated column (When you add a story that _reads_ a mutated column, declare an explicit `needs` on it)

When in doubt, run with `--workers 1` once. If a story flickers between
runs with workers=1, the bug is in the action itself, not the schedule.

## Storage state + dependency graph

Stories declare `needs` and `produces`. Labels are opaque strings. Tuffgal
validates uniqueness and topo-sorts at load time.

```json
{ "needs": ["logged-in"], "produces": ["account-with-records"] }
```

The first story that passes and `produces` a label persists its Playwright
storage state to `paths.authState/<label>.json`. Every story that `needs`
that label inherits the file as its initial context state, so there's no
replay of the producer's actions.

Common patterns:

- A `login` story `produces: ["logged-in"]`
- Stories that don't care about auth pass over `needs`
- Don't create cycles (Don't produce the same label from two stories)

## Authoring checklist

For every new action:

- [ ] Does the final step kick off async work? Add `expect.anyOf`
- [ ] Does the screen render anything random or time-based? Add `mask`
- [ ] Does the screen genuinely drift between runs? Tune `diff.ssimThreshold`
- [ ] Are hint values stable against refactors? Prefer role-based
- [ ] Are parameters explicit in `parameters: [...]`?
- [ ] Does the screen stagger its children's enter animation? Add a `wait` after the success step
- [ ] Does a step synchronously update the DOM in a way you want to assert before moving on? Add a `read` checkpoint
- [ ] Does the flow depend on a keyboard shortcut, such as `Escape`, or `Tab`? Use `type`, not `input`

For every new story:

- [ ] Does it produce something other stories should reuse? Add `produces`
- [ ] Does it depend on a state? Add `needs`
- [ ] Could it run in parallel with siblings? (usually yes)

## Debugging a failed story

1. Open `paths.report/index.html`. Read the failure section at the bottom.
2. Open the trace zip listed under the failure: `npx playwright show-trace paths.report/traces/<story>.zip`. Walk the timeline, inspect DOM snapshots, and watch network calls.
3. Compare baseline / actual / diff images in the report's screenshot panel. The diff engine flagged something, so check whether it's a real regression or new drift to absorb with `mask` or `ssimThreshold`.
4. If the locator missed, re-read the hint precedence list above and tighten it.

## Things Tuffgal will not do

- It will not silently fix bad selectors. AI fuzzy matching is in the pipeline, but for now a broken hint fails loudly
- It will not retry network calls, async navigation, or page transitions beyond what `expect` covers
- It will not de-flake suite design. Per-run DB reset plus label-based storage state get you most of the way (the rest is on you)

If you're tempted to disable an action because "it's flaky," the right move
is almost always to tighten `expect`, add a `mask`, or split the action
into two narrower ones.

You can also consider going into a dark room and having a little breakdown
before getting back to it. We've all been there.
