# Changelog

All notable changes to Tuffgal land here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
honours [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
public API is unstable until `v1.0.0`; breaking changes in `0.x` are
expected.

## [Unreleased]

### Added

- `ActionResult` carries `a11yBaselinePath` and `a11yActualPath`. `tuffgal approve` now promotes the accessibility-tree snapshot (`a11y.yaml`) alongside the PNG baseline so the two stay in lock-step.
- Shared `--story` filter semantics across `tuffgal run` and `tuffgal approve`. Either command now matches by filename, by filename without the `.json` suffix, or by the story's prose title.
- `loadStories` detects duplicate story filenames across nested subdirectories and throws a `LoadError`, preventing silent baseline + filter collisions.

### Changed

- Synthetic "blocked by failed prerequisite" results now surface in `RunResult.stories`. Previously the scheduler wrote them into the result map but never appended them to the ordered output, so they vanished from the report and totals.
- Diff gating is SSIM-only. The schema's `ssimThreshold` (default `0.99`) is the sole pass/changed gate; `pixelThreshold` still controls the diff PNG overlay.
- Doc sweep: README + `docs/authoring.md` + `docs/prd-v1.md` + `docs/supervisor.md` + `docs/ci.md` re-aligned with current code (step primitive set, diff defaults, DB reset cadence, build/ship model, supervisor probe protocol).

### Removed

- **Breaking:** `diff.maxDiffRatio` legacy gate removed from `actionSchema`. Actions that set it should switch to `ssimThreshold`.
- **Breaking:** `CiConfig` (`ci.sarif`, `ci.artifactPaths`) removed from `TuffgalConfig` and the public API exports. The fields were declared but unread; the HTML reporter + uploaded artifacts cover the same ground.
- Dead `bin/**` and `schema/**` entries pruned from `tsconfig.json`, `tsconfig.build.json`, and `eslint.config.mjs`.

## [0.1.0-alpha.3] — 2026-06-06

### Added

- Browser context now grants `clipboard-read` + `clipboard-write` permissions so stories that copy/paste no longer hit a permission prompt.

### Documentation

- README polish and clarifications across `docs/`.

## [0.1.0-alpha.2] — 2026-06-04

### Fixed

- `npm run build` now copies `src/reporter/assets/{report.css,report.js}` into `dist/reporter/assets/`. Earlier alpha builds shipped without the reporter's static assets, so the generated HTML report rendered without styling or interactivity.

## 0.1.0-alpha.1 — 2026-06-04

### Changed

- Package now ships compiled `dist/` instead of raw `.ts` sources. CLI entry point is `./dist/cli.js`.

### Fixed

- Corrected `bin` extension and publish flags for the alpha channel.

## [0.1.0-alpha.0] — 2026-06-04

Initial public alpha. Tuffgal extracted from
[Linklater](https://github.com/nschneble/linklater)'s in-tree visual
testing workspace.

### Added

- CLI commands: `run`, `approve`, `init`, `supervise`, `help`.
- Action + story JSON schema (zod-validated): 9 step primitives (`click`, `input`, `intercept`, `navigate`, `read`, `scroll`, `type`, `wait`, `waitFor`).
- DAG scheduler with `needs`/`produces` labels, cycle detection, parallel worker pool, and failure-propagation skip.
- Hint resolver with role + text → role → selector → text precedence.
- SSIM-gated visual diff plus pixelmatch overlay; accessibility-tree snapshot side-by-side with the PNG baseline.
- Playwright trace zip emitted on failed stories.
- Clock freeze via `page.clock.install` plus storage-state inheritance through label-based DAG ordering.
- Static HTML reporter at `<paths.report>/index.html` with screenshot panels, failure list, and coverage metrics (screens + flows).
- Optional V8 JS + CSS coverage via `monocart-coverage-reports` (`--coverage` flag).
- `database` bridge for consumer-supplied per-run reset and per-story fixture functions.
- `devServers` bridge for `--manage-servers` (one-shot) and `tuffgal supervise` (long-running, with healthcheck restart, idle auto-term, and wall-clock cap).
- `prepublishOnly` gate that runs lint + typecheck + build before any publish.
- Trusted Publishing (OIDC) for the `npm publish` step in the release workflow.
- `docs/`: `app-contract.md`, `authoring.md`, `ci.md`, `config.md`, `migration-cypress.md`, `migration-playwright.md`, `prd-v1.md`, `supervisor.md`.
- `examples/postgres-prisma/` recipe covering DB reset, a fixture, and one-shot setup script.

[Unreleased]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.0...v0.1.0-alpha.2
[0.1.0-alpha.0]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.0

> `0.1.0-alpha.1` was published to npm but never tagged in git, so it
> has no compare link. It exists between `alpha.0` and `alpha.2` in the
> commit history.
