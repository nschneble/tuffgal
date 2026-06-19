# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

_Nothing just yet_

## [0.1.0-alpha.7] — 2026-06-19

### Changed

- Capitalize the report title to "Tuffgal report" and show a friendlier timestamp
- Convey story status as a colored, marked story name instead of a badge
- Show the status badge as plain text (no letter glyph)
- Rename "pass" terminology to "passed" throughout the report
- Make the whole action row clickable to toggle screenshots (replaces the "view" link)
- Draw continuous tree connector lines down the action list
- Move the expand/collapse buttons to the right of the filters; the story-count status now sits beside the filters, with filter-aware labels (e.g. "Expand all changed screenshots")
- Split story totals and coverage in the summary with justify-between

### Removed

- Drop the redundant "Failures" section at the bottom of the report (failures now surface inline and via the failed filter)
- Stop linking the Playwright trace from the HTML report; its path is recorded in `results.json`

## [0.1.0-alpha.6] — 2026-06-11

### Added

- Add per-story overrides for browser `viewport` optional config field
- Add `tuffgal approve --new-only` flag to limit baselines to new stories
- Allow reports to be filtered by passed, changed, or failed
- Allow reports to expand/contract all screenshots

### Changed

- Edit `tuffgal run` output to group changed, failed at end w/ report link
- Skip npm release if no version bump

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

[Unreleased]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.7...HEAD
[0.1.0-alpha.7]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.0
