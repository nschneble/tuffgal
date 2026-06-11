# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

### Added

- Stories can override the config-level `viewport` per story. Width and
  height must be positive integers; stories without an override inherit
  the config default. The override does not cascade onto consumers that
  inherit storage state via `needs`/`produces`.
- `tuffgal approve --new-only` promotes only actions whose status is `new`,
  leaving existing baselines untouched. Lets you baseline newly-introduced
  stories without accepting drift on the rest of the suite.
- HTML report has a status filter above the stories list. Pick `passed`,
  `changed`, or `failed` to hide non-matching rows; `all` restores them.
  Screen-reader users get a debounced polite-region announcement of the
  resulting count.
- HTML report toolbar has `expand all` / `collapse all` buttons that toggle
  every visible story's screenshot details panel at once. Respects the active
  status filter — hidden rows stay collapsed. Announcements reuse the existing
  status-filter live region.

### Changed

- Release workflow now skips `npm publish` and the GitHub release step when
  `package.json` version is already on npm, instead of failing noisily. Lets
  a `v*` tag be re-pushed (or pushed without a version bump) without breaking
  the workflow.
- `tuffgal run` stdout now groups changed + failed stories under labeled
  `Changed:` / `Failed:` sections at the tail of the run (after the streaming
  progress), so you don't have to scroll up through every passing story to
  find what needs review. The `Report:` line is now a `file://` URL that
  terminals like iTerm2, Warp, and VS Code render as a clickable link.

### Fixed

- `tuffgal run`, `tuffgal supervise`, and `tuffgal init` now error out
  when `--new-only` is passed instead of silently ignoring it. The flag
  is only meaningful for `tuffgal approve`.
- HTML report's filter and bulk-toggle (`expand all` / `collapse all`)
  now share a single live-region writer, so a bulk-toggle clicked within
  150ms of a filter change cancels the filter's pending announcement and
  the screen reader hears only the most-recent action.

## [0.1.0-alpha.5] — 2026-06-11

### Added

`navigate` step accepts an optional `waitUntil` field (`'load' |
'domcontentloaded' | 'networkidle' | 'commit'`) that overrides Playwright's
`page.goto` ready signal on a per-step basis. Defaults to `'networkidle'`.
Use `'domcontentloaded'` for dev-mode pages with long-tail external fetches
that prevent `networkidle` from settling.

## [0.1.0-alpha.4] — 2026-06-06

### Added

- `tuffgal approve` now updates the a11y snapshot at the same time as the screenshot
- `--story` works the same way on both `tuffgal run` and `tuffgal approve`
- Two stories with the same filename in different folders is now an error

### Changed

- Stories that get skipped b/c a prereq failed now show up in the run report + totals
- Screenshot comparison uses SSIM only
- README and `docs/` pages now match how the code actually works lol

### Removed

- **Breaking:** Removed the legacy `diff.maxDiffRatio` setting
- **Breaking:** Dropped the `ci` block from `TuffgalConfig` and the public API
- Removed stale `bin/**` and `schema/**` paths

## [0.1.0-alpha.3] — 2026-06-06

Grants clipboard permissions in browser contexts.

Without `permissions: ['clipboard-read', 'clipboard-write']` Playwright
default-denies clipboard API access, which breaks any story using the Web
Clipboard API.

## [0.1.0-alpha.2] — 2026-06-04

`npm run build` now copies `src/reporter/assets/{report.css,report.js}`
into `dist/reporter/assets/`. Earlier alpha builds shipped without the
reporter's static assets, so the generated HTML report rendered without
styling or interactivity.

## [0.1.0-alpha.1] — 2026-06-04

### Changed

- Package now ships compiled `dist/` instead of raw `.ts` sources
- CLI entry point is `./dist/cli.js`

### Fixed

- Corrected `bin` extension and publish flags for the alpha channel

## [0.1.0-alpha.0] — 2026-06-04

Initial public alpha. Tuffgal extracted from [Linklater](https://github.com/nschneble/linklater)'s
in-tree visual testing workspace.

[Unreleased]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.5...HEAD
[0.1.0-alpha.5]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.0
