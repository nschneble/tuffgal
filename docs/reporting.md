# Reporting data (`results.json`)

Every `tuffgal run` writes a machine-readable `results.json` alongside the HTML
report, so CI and other tooling can fork on the outcome without scraping
stdout. This page is the contract for that file. For the CLI that produces it,
see [cli.md](cli.md); for a worked GitHub Actions recipe, see [ci.md](ci.md).

## Where it is

`run` writes three things into `paths.report` (from your
[config](config.md#paths-pathsconfig)):

```
<paths.report>/
  index.html      # the human report
  results.json    # the machine contract documented here
  assets/         # report CSS + JS
```

The file is rewritten on every run. It is overwrite-safe to read after the
`run` process exits; the exit code (see below) tells you the headline outcome
without parsing anything.

The TypeScript shape is exported from the package, so a Node consumer can type
its parse:

```ts
import { type RunResult } from 'tuffgal';
const result: RunResult = JSON.parse(
  await readFile('tuffgal/report/results.json', 'utf8'),
);
```

## Top level: `RunResult`

```jsonc
{
  "startedAt": "2026-06-26T12:00:00.000Z", // ISO 8601, run start
  "finishedAt": "2026-06-26T12:00:35.490Z", // ISO 8601, run end
  "durationMs": 35490, // wall-clock for the whole run
  "mode": "ci", // "ci" | "local": the comparison contract this run executed under
  "totals": {
    /* see below */
  },
  "environment": {
    /* capture-environment provenance + drift, see below */
  },
  "customCoverage": {
    /* see below */
  },
  "deleted": [
    /* DeletedBaseline[], orphaned committed baselines, see below */
  ],
  "stories": [
    /* StoryResult[], see below */
  ],
}
```

`mode` records the comparison contract the run executed under: `ci` compares
against the committed baselines and gates the build; `local` is an advisory
self-diff against the per-machine cache. It is optional only as a defensive
parse guard for pre-`0.2.0` artifacts; every current run stamps it. See
[the CI-owned baselines model](../README.md#ci-owns-the-baselines) for what
each mode reads and writes.

## `totals`

One run-wide tally. Every count is **stories**, not actions. A story that runs
at several breakpoints is counted once, under its worst-across-breakpoints
status.

| Field     | Type   | Meaning                                                                                                                                                                                                                            |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stories` | number | Total stories run (`= passed + new + changed + failed`).                                                                                                                                                                           |
| `passed`  | number | Stories where every screenshot matched its baseline.                                                                                                                                                                               |
| `new`     | number | Stories that wrote at least one fresh baseline and had no drift or failure. Nothing to compare against yet.                                                                                                                        |
| `changed` | number | Stories where a screenshot drifted past threshold (and none failed). A review decision, not an error.                                                                                                                              |
| `failed`  | number | Stories where an action threw (or was skipped because an earlier action failed).                                                                                                                                                   |
| `deleted` | number | Orphaned committed baselines detected this run (the length of `deleted[]`). CI + unfiltered runs only; `0` in local mode and on any `--story`-filtered run. Counts baselines, not stories, so it is not part of the `stories` sum. |

`new + changed + failed` are the stories a human probably wants to look at;
`passed` is the quiet majority.

## `customCoverage`

Two ratios layered on top of V8 line coverage, each a `CoverageMetric`:

| Field     | Type     | Meaning                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `total`   | number   | Denominator (declared screens, or journeys in `flowInventory`).                |
| `covered` | number   | Numerator (screens with a baseline, or stories tagged with a matching `flow`). |
| `ratio`   | number   | `covered / total`, `0`–`1`.                                                    |
| `missing` | string[] | The uncovered names.                                                           |

```jsonc
"customCoverage": {
  "screens": { "total": 12, "covered": 9, "ratio": 0.75, "missing": ["/admin"] },
  "flows":   { "total": 5,  "covered": 3, "ratio": 0.6,  "missing": ["checkout"] }
}
```

`screens` = baselined `visit-*` actions / declared screens. `flows` = stories
carrying a `flow` tag / journeys listed in `config.flowInventory`.

## `environment`: `EnvironmentReport`

Capture-environment provenance for the run: what it rendered under, and (in CI
mode) whether that drifted from the committed baselines' manifest. Drives the
report's environment-mismatch banner and the `3` exit code. Optional only as a
defensive parse guard for pre-`0.2.0` artifacts; every current run emits it.

```jsonc
"environment": {
  "expected": { /* the committed baselines/manifest.json, or null */ },
  "actual":   { /* the environment this run actually captured under */ },
  "mismatch": false,       // true when a pixel-affecting key diverged
  "mismatchKeys": []       // the diverging keys, or ["manifest"] if unreadable
}
```

| Field          | Type     | Meaning                                                                                                                                                          |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected`     | object?  | The committed `<baselines>/manifest.json` when one exists and parses, else `null`. `null` covers both the bootstrap case (no manifest yet) and local mode.       |
| `actual`       | object   | The capture environment this run rendered under (capture schema, browser version, platform, capture mode, breakpoints, device scale factor, frozen time).        |
| `mismatch`     | boolean  | `true` when a pixel-affecting key diverged (CI mode with a present manifest) or the committed manifest was unreadable. Always `false` in local mode / bootstrap. |
| `mismatchKeys` | string[] | The specific diverging keys, or `["manifest"]` when the manifest could not be parsed. Empty when `mismatch` is `false`.                                          |

## `deleted[]`: `DeletedBaseline`

Orphaned committed baselines: entries under `paths.baselines` whose action ran
no story this run, so nothing compared against them. Populated only for an
unfiltered CI run; empty in local mode and on filtered runs, where a baseline
going unvisited says nothing about whether its story still exists. Detection
only. `approve --from --prune` is what retires them.

```jsonc
"deleted": [
  {
    "action": "visit-admin",         // orphaned action name
    "breakpoint": "desktop",         // mode name, or "legacy" for the pre-breakpoint <action>/0.png layout
    "baselinePaths": ["…/visit-admin/desktop.png", "…/visit-admin/desktop.a11y.yaml"]
  }
]
```

## `stories[]`: `StoryResult`

One entry per story run. Order is dependency/completion order.

| Field                      | Type             | Meaning                                                                                                                           |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `story`                    | string           | The story's prose title.                                                                                                          |
| `file`                     | string           | Source story file name.                                                                                                           |
| `status`                   | `StoryStatus`    | Rollup across breakpoints. `pass` \| `new` \| `changed` \| `failed` (worst wins, `failed` > `changed` > `new` > `pass`).          |
| `startedAt` / `finishedAt` | string           | ISO 8601 window for the story.                                                                                                    |
| `durationMs`               | number           | Wall-clock for the story across its breakpoints.                                                                                  |
| `actions`                  | `ActionResult[]` | One entry per action per breakpoint (see below).                                                                                  |
| `tracePath`                | string?          | Absolute path to the Playwright trace zip; present only when the story failed. Open with `npx playwright show-trace <tracePath>`. |

## `actions[]`: `ActionResult`

One entry per action, per breakpoint it rendered at. A story run at two
breakpoints contributes two entries per action, each tagged with its mode.

| Field                                  | Type           | Meaning                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                               | string         | Action name.                                                                                                                                                                                                                                                                                                                        |
| `status`                               | `ActionStatus` | `pass` \| `new` \| `changed` \| `failed` \| `skipped`. `skipped` means an earlier action in this breakpoint failed.                                                                                                                                                                                                                 |
| `breakpoint`                           | string?        | Mode name (`mobile` / `desktop` / …).                                                                                                                                                                                                                                                                                               |
| `breakpointWidth` / `breakpointHeight` | number?        | The actual capture viewport, including per-story or per-config overrides.                                                                                                                                                                                                                                                           |
| `parameters`                           | object?        | Author-declared parameters, verbatim.                                                                                                                                                                                                                                                                                               |
| `startedAt` / `finishedAt`             | string         | ISO 8601 window.                                                                                                                                                                                                                                                                                                                    |
| `durationMs`                           | number         | Wall-clock for the action.                                                                                                                                                                                                                                                                                                          |
| `baselinePath`                         | string?        | Committed baseline PNG compared against.                                                                                                                                                                                                                                                                                            |
| `actualPath`                           | string?        | Screenshot captured this run.                                                                                                                                                                                                                                                                                                       |
| `diffPath`                             | string?        | Pixel-diff overlay PNG. Present only on a pixel-drifted `changed` action with matching dimensions. An a11y-only `changed` row (pixels matched, aria snapshot drifted) has no `diffPath`.                                                                                                                                            |
| `diffPixels`                           | number?        | Count of differing pixels.                                                                                                                                                                                                                                                                                                          |
| `diffRatio`                            | number?        | `diffPixels / totalPixels`, `0`–`1`. Absent when dimensions mismatched (no diff could be computed).                                                                                                                                                                                                                                 |
| `ssimScore`                            | number?        | Mean structural similarity, `0`–`1`. `1.0` = identical. Drives `pass` vs `changed` on pixels, but it is not the sole gate in CI mode, where a drifted accessibility tree also flips a pixel-passing action to `changed` (see `a11yChanged`).                                                                                        |
| `failedStepIndex`                      | number?        | 0-based index of the step that threw.                                                                                                                                                                                                                                                                                               |
| `failureMessage`                       | string?        | Error or mismatch message (also surfaced in the report).                                                                                                                                                                                                                                                                            |
| `sizeMismatch`                         | object?        | Structured baseline/actual dimensions, `{ baseline: { width, height }, actual: { width, height } }`. Set ONLY on the size-mismatch `changed` branch (baseline and actual differ in size, so no pixel diff could be computed), a structured mirror of the same fact `failureMessage` carries as prose. Absent on every other result. |
| `a11yChanged`                          | boolean?       | `true` when the captured accessibility tree differs from baseline. In CI mode this gates status: pixels can match while the aria snapshot drifts, and that flips the action to `changed`. In local (advisory) mode it stays informational and does not gate.                                                                        |
| `a11yBaselinePath` / `a11yActualPath`  | string?        | Accessibility-tree snapshots (`a11y.yaml`).                                                                                                                                                                                                                                                                                         |

## Exit code

`tuffgal run`'s exit code depends on the run mode. **Local (advisory) mode**
exits `1` when `totals.failed > 0`, otherwise `0`. `new`, `changed`, and
`deleted` never fail a local run, they are review states surfaced in the report
and `results.json`. **CI mode** adds two gating codes: `3` when the committed
environment manifest diverged (`environment.mismatch`), and `2` when there are
pending baseline changes (`new`, `changed`, or `deleted`) a human must approve.
Precedence, highest wins: `1` > `3` > `2` > `0`. See [cli.md](cli.md#exit-codes)
for the full table. Read `results.json` when you want to act on the review
states directly:

```bash
# Is there drift to review (independent of the exit code)?
jq -e '.totals.changed > 0 or .totals.new > 0' tuffgal/report/results.json

# List the stories that failed
jq -r '.stories[] | select(.status == "failed") | .file' tuffgal/report/results.json

# Which breakpoints drifted in a changed story?
jq -r '.stories[] | select(.status == "changed")
       | .actions[] | select(.status == "changed")
       | "\(.breakpoint): \(.diffRatio)"' tuffgal/report/results.json
```

When `results.json` is absent (the harness crashed before writing it), treat the
run as failed rather than assuming success. See
[ci.md](ci.md) for the full upload-and-fork pattern.

## Stability

The fields above are the public contract. The runner validates `results.json`
shallowly on re-read (it must be an object with a `stories` array); a truncated
or stale file fails loudly with its path. New optional fields may be added in a
minor release; existing fields will not change meaning without a changelog
note.
