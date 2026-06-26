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
  "totals": {
    /* see below */
  },
  "customCoverage": {
    /* see below */
  },
  "stories": [
    /* StoryResult[], see below */
  ],
}
```

## `totals`

One run-wide tally. Every count is **stories**, not actions. A story that runs
at several breakpoints is counted once, under its worst-across-breakpoints
status.

| Field     | Type   | Meaning                                                                                                     |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `stories` | number | Total stories run (`= passed + new + changed + failed`).                                                    |
| `passed`  | number | Stories where every screenshot matched its baseline.                                                        |
| `new`     | number | Stories that wrote at least one fresh baseline and had no drift or failure. Nothing to compare against yet. |
| `changed` | number | Stories where a screenshot drifted past threshold (and none failed). A review decision, not an error.       |
| `failed`  | number | Stories where an action threw (or was skipped because an earlier action failed).                            |

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

| Field                                  | Type           | Meaning                                                                                                             |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `action`                               | string         | Action name.                                                                                                        |
| `status`                               | `ActionStatus` | `pass` \| `new` \| `changed` \| `failed` \| `skipped`. `skipped` means an earlier action in this breakpoint failed. |
| `breakpoint`                           | string?        | Mode name (`mobile` / `desktop` / …).                                                                               |
| `breakpointWidth` / `breakpointHeight` | number?        | The actual capture viewport, including per-story or per-config overrides.                                           |
| `parameters`                           | object?        | Author-declared parameters, verbatim.                                                                               |
| `startedAt` / `finishedAt`             | string         | ISO 8601 window.                                                                                                    |
| `durationMs`                           | number         | Wall-clock for the action.                                                                                          |
| `baselinePath`                         | string?        | Committed baseline PNG compared against.                                                                            |
| `actualPath`                           | string?        | Screenshot captured this run.                                                                                       |
| `diffPath`                             | string?        | Pixel-diff overlay PNG. Present only on a `changed` action with matching dimensions.                                |
| `diffPixels`                           | number?        | Count of differing pixels.                                                                                          |
| `diffRatio`                            | number?        | `diffPixels / totalPixels`, `0`–`1`. Absent when dimensions mismatched (no diff could be computed).                 |
| `ssimScore`                            | number?        | Mean structural similarity, `0`–`1`. `1.0` = identical. This is the gate that drives `pass` vs `changed`.           |
| `failedStepIndex`                      | number?        | 0-based index of the step that threw.                                                                               |
| `failureMessage`                       | string?        | Error or mismatch message (also surfaced in the report).                                                            |
| `a11yChanged`                          | boolean?       | `true` when the captured accessibility tree differs from baseline. Informational; does not gate `pass`/`changed`.   |
| `a11yBaselinePath` / `a11yActualPath`  | string?        | Accessibility-tree snapshots (`a11y.yaml`).                                                                         |

## Exit code

`tuffgal run` exits `1` when `totals.failed > 0`, otherwise `0`. **`new` and
`changed` do not fail the process** — they are review states, not errors. Read
`results.json` when you want to act on those:

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
