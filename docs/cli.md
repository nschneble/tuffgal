# CLI reference

Every Tuffgal command and flag. Run `npx tuffgal help` for the same list at the
terminal. For the data a run leaves behind, see [reporting.md](reporting.md).

```bash
npx tuffgal <command> [options]
```

Unrecognized commands fall through to `help`. Tuffgal reads
`tuffgal.config.ts` (or `.js`) from the current working directory for every
command except `init` and `help`; a missing config throws with a pointer to
`tuffgal init`.

## Commands

| Command     | What it does                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`       | Run every story under the configured stories directory, write the report, exit non-zero if any story failed.                                                |
| `approve`   | Promote `changed` (and `new`) actuals to baselines by reading the last run's `results.json`.                                                                |
| `init`      | Scaffold a `tuffgal.config.ts` in the current directory.                                                                                                    |
| `supervise` | Long-running wrapper around `devServers.command` with healthcheck restart, idle auto-termination, and a wall-clock cap. See [supervisor.md](supervisor.md). |
| `help`      | Print usage.                                                                                                                                                |

## `run`

```bash
npx tuffgal run [options]
```

Loads actions and stories, runs the dependency schedule across a worker pool,
and writes `index.html` + `results.json` + assets to `paths.report`. A
multi-breakpoint project runs one pass per breakpoint, each behind a fresh
`database.reset()`. See
[authoring.md](authoring.md#multiple-breakpoints-run-as-separate-passes).

| Flag               | Default            | Meaning                                                                                                                 |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `--story <name>`   | all stories        | Run only stories whose file name or story text matches `<name>`. `--story=<name>` also works.                           |
| `--headed`         | off                | Show the browser while running instead of headless.                                                                     |
| `--workers <n>`    | `min(cpus / 2, 4)` | Override the worker pool size. Also `--workers=<n>`. Outranks `config.workers`.                                         |
| `--manage-servers` | off                | Spawn `devServers.command`, wait for it, run, then kill it. Without this, point `baseUrl` at an already-running server. |
| `--coverage`       | off                | Capture V8 JS + CSS coverage and emit a monocart report next to the HTML report.                                        |

**Exit code:** `1` when `totals.failed > 0`, else `0`. A `new` or `changed`
story does **not** fail the process; only a thrown action fails it. This is the
contract CI forks on. See [reporting.md](reporting.md#exit-code).

## `approve`

```bash
npx tuffgal approve [story] [options]
```

Re-reads the previous run's `results.json` and promotes each captured actual to
its committed baseline, so the next run compares against the accepted image.
Prints `Approved N baselines; skipped M actions.`

The optional filters narrow the set as an **AND**: an action is promoted only
when it clears every filter you pass. With none, every `changed` and `new`
action is approved.

| Argument / Flag                                    | Default     | Meaning                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[story]`                                          | all stories | Positional story to approve: a name (`user-logs-in`, `.json` optional), a prose title, or a path (`tuffgal/stories/user-logs-in.json`, reduced to its file name). Sugar for `--story`; passing both errors. |
| `--story <name>`                                   | all stories | Same selection as the positional, in flag form. Also `--story=<name>`.                                                                                                                                      |
| `--breakpoint <name>`                              | all modes   | Approve only this breakpoint (matched by mode name). Repeatable: `--breakpoint desktop --breakpoint mobile`. Also `--breakpoint=<name>`.                                                                    |
| `--desktop` / `--mobile` / `--tablet` / `--laptop` | —           | Shorthand for `--breakpoint <name>` on the four registry modes. Combine freely.                                                                                                                             |
| `--new-only`                                       | off         | Promote only `new` baselines; leave `changed` actuals untouched. Baseline brand-new stories without accepting drift on existing ones.                                                                       |

`--new-only` and the breakpoint filters are valid only on `approve`. Passing
them (or a stray positional) to `run`, `supervise`, or `init` exits `1` with an
error on stderr.

## `init`

```bash
npx tuffgal init
```

Writes a starter `tuffgal.config.ts` to the current directory. Does not read an
existing config. See [config.md](config.md) for every field.

## `supervise`

```bash
npx tuffgal supervise [options]
```

Wraps `devServers.command` as a long-running process: probes its health, restarts
on failure, and self-terminates on idle or a wall-clock cap. Full behavior in
[supervisor.md](supervisor.md).

| Flag                          | Default   | Meaning                                                           |
| ----------------------------- | --------- | ----------------------------------------------------------------- |
| `--healthcheck-interval <ms>` | `30000`   | Health-probe interval. Also `=<ms>`.                              |
| `--idle-limit <ms>`           | `600000`  | Milliseconds with no `tuffgal run` heartbeat before exit.         |
| `--max-runtime <ms>`          | `3600000` | Wall-clock cap before exit.                                       |
| `--max-respawns <n>`          | `3`       | Respawn budget after the wrapped process goes unhealthy or exits. |

Every numeric flag rejects non-finite or non-positive values at parse time with
an error on stderr rather than silently coercing to `0`.

## Exit codes

| Command     | `0`                                   | non-zero                                                                                                                                                                         |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`       | no failed stories                     | `1` when `totals.failed > 0`                                                                                                                                                     |
| `approve`   | approval completed                    | `1` on a thrown error (e.g. missing/stale `results.json`)                                                                                                                        |
| `init`      | config written                        | `1` on a thrown error                                                                                                                                                            |
| `supervise` | clean shutdown (idle, cap, or signal) | `1` on a thrown error                                                                                                                                                            |
| any         | —                                     | `1` on an approve-only flag (`--new-only`, `--breakpoint`/`--desktop`/…) or a positional outside `approve`, or any uncaught error (message on stderr, prefixed `tuffgal error:`) |

## Examples

```bash
# One story, headed, while iterating locally
npx tuffgal run --story user-changes-password --headed

# Full run that boots and tears down the dev server itself
npx tuffgal run --manage-servers

# Accept the new baselines a first run produced, but not drift
npx tuffgal approve --new-only

# Accept just the desktop drift on one story
npx tuffgal approve user-logs-in --desktop

# New desktop baselines for one story, leaving its changed mobile shots alone
npx tuffgal approve user-logs-in --desktop --new-only

# Coverage run with a wider worker pool
npx tuffgal run --coverage --workers 8
```
