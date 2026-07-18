# CI integration

Tuffgal runs cleanly in CI without anything Tuffgal-specific: install Node,
install dependencies, install Chromium, and then invoke
`tuffgal run --ci --manage-servers`. The harness produces a `results.json` you
can parse for the actual pass/new/changed/failed counts, a static HTML report
you can upload as a build artifact for reviewers, and (in CI mode) a
self-contained **candidate tree** a reviewer promotes into the committed
baselines.

This page documents the recipe for GitHub Actions. The same shape works for
GitLab CI, CircleCI, Buildkite, and Jenkins. Just adjust the artifact
upload and service container syntax to match.

## CI owns the baselines

Under the CI-owned-baselines model, **CI is the only writer of committed
baselines** and a `tuffgal run --ci` never touches `paths.baselines`. It
compares the current UI against the committed set and, for anything that drifted
(`changed`), is brand-new (`new`), or went orphaned (`deleted`), writes the
proposed images into a candidate tree at `<report>/candidates/` (mirroring the
`paths.baselines` layout exactly, plus a `results.json` copy) rather than
committing in place. The one path that writes committed baselines is
`tuffgal approve --from <candidates>`, run by a human (or bot) who has reviewed
the diff. See [the model overview](../README.md#ci-owns-the-baselines) and the
[`approve` reference](cli.md#approve).

Because the candidate tree lives **inside** `tuffgal/report/`, uploading the
report directory captures it. The recipe below also uploads it as its own slim
artifact so a reviewer can download just the proposed images and promote them.

## The `tuffgal-action` GitHub Action

The companion composite action [`nschneble/tuffgal-action`](https://github.com/nschneble/tuffgal-action)
collapses the recipe below to a single step. See its README for inputs and
outputs. The raw YAML below stays useful when you want fine-grained control
over the surrounding steps, e.g. custom DB bootstrap, conditional uploads,
and/or custom comment formats.

## Example: GitHub Actions + Postgres + Prisma

```yaml
name: tuffgal

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  tuffgal:
    runs-on: ubuntu-latest

    # TODO: drop the entire `services:` block for static-site projects.
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: myapp_testing_ui
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      # TODO: replace with your app's test-mode environment variable
      # See `docs/app-contract.md`
      TUFFGAL: '1'
      # TODO: connection string for the dedicated test database
      TEST_DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/myapp_testing_ui'

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      # TODO: remove if your project does not use Prisma
      - name: Generate Prisma client
        run: npx prisma generate

      - name: Install Chromium for Playwright
        run: npx playwright install --with-deps chromium

      # Calls `tuffgal/setup.ts` from the example recipe. Skip if your
      # consumer-side bootstrap is one-shot via Docker compose
      - name: Bootstrap test database
        run: npm run test:ui:setup

      # `--ci` forces CI mode: compare against committed baselines, never write
      # them, and gate the PR. ($CI is already truthy on Actions, so the flag is
      # belt-and-suspenders, but explicit is clearer in a gating job.)
      - name: Run Tuffgal
        id: harness
        continue-on-error: true
        run: npm run test:ui -- --ci --manage-servers

      # Read results.json so the upload steps below can fork on the actual
      # outcome rather than just the harness exit code. `changed` is drifted
      # baselines, `new` is first-run baselines that have nothing to diff
      # against yet, `deleted` is orphaned committed baselines. All three land
      # in the candidate tree for a reviewer to promote, whereas `failed` is the
      # debugging case.
      - name: Parse harness outcome
        id: outcome
        if: always()
        run: |
          results="tuffgal/report/results.json"
          if [ ! -f "$results" ]; then
            echo "failed=true" >> "$GITHUB_OUTPUT"
            echo "pending=false" >> "$GITHUB_OUTPUT"
            echo "Harness produced no results.json. Treating as failed." >&2
            exit 0
          fi
          failed=$(jq -r '.totals.failed' "$results")
          changed=$(jq -r '.totals.changed' "$results")
          new=$(jq -r '.totals.new' "$results")
          deleted=$(jq -r '.totals.deleted' "$results")
          pending=$((changed + new + deleted))
          echo "failed=$([ "$failed" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
          echo "pending=$([ "$pending" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

      # The report directory contains the human HTML report AND the candidate
      # tree (<report>/candidates/), so this one artifact carries everything a
      # reviewer needs to inspect a change.
      - name: Upload report (on failure or pending change)
        if: always() && (steps.outcome.outputs.failed == 'true' || steps.outcome.outputs.pending == 'true')
        uses: actions/upload-artifact@v4
        with:
          name: tuffgal-report
          path: tuffgal/report/
          retention-days: 14

      # The candidate tree uploads separately so a reviewer approving a change
      # can download just the proposed images and run `approve --from` against
      # them, without digging through the HTML report and traces.
      - name: Upload candidate tree (on pending change)
        if: always() && steps.outcome.outputs.pending == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: tuffgal-candidates
          path: tuffgal/report/candidates/
          retention-days: 14

      - name: Surface harness exit code
        if: always() && steps.harness.outcome == 'failure'
        run: exit 1
```

## Promoting a candidate tree

CI never commits baselines. When a run reports pending changes (exit code `2`)
and you have reviewed the diff in the uploaded report, promote the proposed
images into the committed set:

1. Download the `tuffgal-candidates` artifact the run uploaded and unzip it.
2. Run the one command that writes committed baselines:

   ```bash
   npx tuffgal approve --from ./tuffgal-candidates
   ```

   It refuses any candidate whose `results.json` is not a clean CI run
   (`mode !== 'ci'` or `totals.failed > 0`), so a local or broken run can never
   be promoted. It also writes `baselines/manifest.json` from the candidate
   run's captured environment, so the next `run --ci` can detect environment
   drift. Add `--prune` to also retire the baselines the run flagged as
   `deleted`.

3. Commit the resulting `tuffgal/baselines/` changes and push.

The intended end state is a `@tuffgal approve` PR comment that runs this same
promotion on the CI side; the Action that handles it is a downstream,
not-yet-shipped repo, so treat that as the direction of travel and use the
download-and-`approve --from` flow today.

## Exit codes

`tuffgal run --ci` gates the job through its exit code (see the
[full table](cli.md#exit-codes)):

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Clean: every story passed, no pending changes, and the environment matched      |
| `1`  | One or more stories failed (a step threw). Highest precedence                   |
| `2`  | Pending baseline changes to approve (`new`, `changed`, or `deleted`)            |
| `3`  | The committed environment manifest diverged from this run's capture environment |

Precedence is `1` > `3` > `2` > `0`. A `3` means the comparison still ran but
the baselines were captured under a different environment (platform, browser,
capture mode, …), so expect a full re-approve. The `continue-on-error` pattern
lets the harness record any of these while the upload steps still run; the final
`exit 1` step then re-surfaces a non-zero harness exit as a job failure, so a
pending change (`2`), an environment mismatch (`3`), or a failure (`1`) all gate
the PR. (Local mode never emits `2` or `3`; only CI mode gates.)

## Why use `continue-on-error: true` on the run step?

A failed or pending Tuffgal run produces the most valuable artifacts: the report
and the candidate tree. If the step fails immediately, the upload steps never
execute and the reviewer has nothing to inspect.

The pattern is to let the harness step record its exit code, upload
everything, then re-surface a non-zero exit as a job failure via the final
`exit 1` step.

## Why upload the candidate tree separately from the report?

A reviewer promoting an intentional visual change wants just the proposed images
to feed `approve --from`, not to dig through HTML + traces. The candidate tree
is already a self-contained approval artifact (it carries its own
`results.json`), so uploading it on its own keeps the promotion step a plain
download-and-`approve`.

If you'd rather have a single artifact, drop the second upload step. The full
`tuffgal/report/` upload already contains `candidates/`, so you can point
`approve --from` at `tuffgal/report/candidates` inside it.

## Why `--manage-servers` and not `tuffgal supervise` here?

`--manage-servers` is right for CI because it's a one-shot with
deterministic teardown and a propagating exit code.

`tuffgal supervise` is the long-running wrapper for local iteration with a
health check restart and idle auto-termination. Both options exist, so just
use the one that matches your workflow.

## Other CI providers

The same pattern applies to GitLab CI, CircleCI, Buildkite, and Jenkins.

Key adjustments:

- **Postgres service container:** GitLab uses `services:`; CircleCI uses `docker:` with a second image entry; Buildkite + Jenkins typically use docker-compose or a sidecar
- **Artifact upload:** GitLab `artifacts:`, CircleCI `store_artifacts:`, Buildkite `artifact_paths`, Jenkins `archiveArtifacts`
- **Job-level env vars:** Every provider has a way to set them. Keep `TUFFGAL=1` set unconditionally for the job

The rest of the code – installation, bootstrapping the database, running
with `--ci --manage-servers`, parsing results, uploading the report and
candidate tree, and surfacing the exit code doesn't change.
</content>
</invoke>
