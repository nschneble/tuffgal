# CI integration

Tuffgal runs cleanly in CI without anything Tuffgal-specific: install Node,
install dependencies, install Chromium, and then invoke
`tuffgal run --manage-servers`. The harness produces a `results.json` you
can parse for the actual pass/changed/failed counts and a static HTML
report you can upload as a build artifact for reviewers.

This page documents the recipe for GitHub Actions. The same shape works for
GitLab CI, CircleCI, Buildkite, and Jenkins. Just adjust the artifact
upload and service container syntax to match.

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

      - name: Run Tuffgal
        id: harness
        continue-on-error: true
        run: npm run test:ui -- --manage-servers

      # Read results.json so the upload steps below can fork on the actual
      # outcome rather than just the harness exit code. `changed` includes
      # new baselines a reviewer probably wants to inspect, whereas
      # `failed` is the debugging case
      - name: Parse harness outcome
        id: outcome
        if: always()
        run: |
          results="tuffgal/report/results.json"
          if [ ! -f "$results" ]; then
            echo "failed=true" >> "$GITHUB_OUTPUT"
            echo "changed=false" >> "$GITHUB_OUTPUT"
            echo "Harness produced no results.json. Treating as failed." >&2
            exit 0
          fi
          failed=$(jq -r '.totals.failed' "$results")
          changed=$(jq -r '.totals.changed' "$results")
          echo "failed=$([ "$failed" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
          echo "changed=$([ "$changed" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

      - name: Upload report (on failure or visual change)
        if: always() && (steps.outcome.outputs.failed == 'true' || steps.outcome.outputs.changed == 'true')
        uses: actions/upload-artifact@v4
        with:
          name: tuffgal-report
          path: tuffgal/report/
          retention-days: 14

      # Baselines upload separately so reviewers approving an intentional
      # visual change can download just the new PNGs and commit them
      - name: Upload updated baselines (on visual change)
        if: always() && steps.outcome.outputs.changed == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: tuffgal-baselines
          path: tuffgal/baselines/
          retention-days: 14

      - name: Surface harness exit code
        if: always() && steps.harness.outcome == 'failure'
        run: exit 1
```

## Why use `continue-on-error: true` on the run step?

A failed Tuffgal run produces the most valuable artifacts: the report and
the new actuals. If the step fails immediately, the upload steps never
execute and the reviewer has nothing to inspect.

The pattern is to let the harness step record its exit code, upload
everything, then fork on the parsed `results.json` to decide whether to
fail the job. A non-zero exit from the harness re-surfaces as a job failure
at the end via the final `exit 1` step.

## Why upload baselines separately from the report?

Reviewers approving an intentional visual change want just the updated PNGs
to drop into a follow-up commit. Bundling baselines with the report forces
them to dig through HTML + traces.

If you'd rather have a single artifact, you can drop the second upload step
and add `path: tuffgal/baselines/` to the first.

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
with `--manage-servers`, parsing results, uploading artifacts, and
surfacing the exit code doesn't change.
