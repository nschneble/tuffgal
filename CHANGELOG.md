# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

_Nothing right now_

## [0.1.0-alpha.10] — 2026-06-22

### Fixed

- **Per-breakpoint database isolation.** alpha.9 ran each breakpoint in its own
  browser context but applied a story's fixtures only once, before the
  breakpoint loop — so a story that mutated server state passed at the first
  mode and then ran the next mode against the mutated rows (a registered user
  collided on the second mode, an already-read link no longer showed as unread,
  an emptied list had nothing left to empty). Fixtures are now re-applied before
  **every** breakpoint, resetting that state to a known baseline per mode.
  Fixtures are idempotent, so non-mutating stories are unaffected.

### Added

- **`${breakpoint}` interpolation token.** The current mode name is exposed to
  action interpolation as `${breakpoint}`, so a story can key data it creates
  through the app (with no backing fixture to reset) per mode — e.g.
  `fresh+${breakpoint}@example.test` registers a distinct user at each viewport
  instead of colliding on a shared value. A story parameter literally named
  `breakpoint` overrides the injected value.

## [0.1.0-alpha.9] — 2026-06-21

### Added

- Breakpoint modes, replacing the single `viewport` config
  - `mobile` 375×667 / `tablet` 768×1024 / `laptop` 1024×768 / `desktop` 1280×800
  - Each mode runs in its own browser context + produces its own baselines
  - Each `config.breakpoints` entry is a bare name (registry dimensions) or `{ name, width?, height? }` to override that mode's size; an omitted axis inherits the registry default
  - Order preserved; when a name repeats, the first entry wins
  - Omit `breakpoints` to run a single `desktop` mode (1280×800)
  - Per-story `breakpoints` field, same shape, that **replaces** the project's modes for that story — a story may run a mode the project does not configure, and its overrides resolve against the registry
  - Breakpoint grouping in the HTML report, each group labelled with the real capture size; a single-mode story renders as a flat list with no breakpoint chrome
  - Pre-breakpoint baselines at `<action>/0.png` are read as fallbacks until promoted

### Removed

**Breaking:** `viewport` config field + per-story `viewport` override. Set
a single mode's size with `breakpoints: [{ name: 'desktop', width, height }]`
instead.

## [0.1.0-alpha.8] — 2026-06-20

### Fixed

- Reset page scroll to origin before each full-page capture, so `position: sticky` and `fixed` elements no longer render shifted by `scrollY`

## [0.1.0-alpha.7] — 2026-06-20

### Added

- Add `npm run preview` to render a sample HTML report

### Changed

- Capitalize the report title to "Tuffgal report" and show a friendlier timestamp
- Convey story status as a colored, marked story name instead of a badge
- Make the whole action row clickable to toggle screenshots
- Move the expand/collapse buttons to the right of the filters; the story-count status now sits beside the filters, with filter-aware labels
- Rename "pass" terminology to "passed" throughout the HTML report
- Show the status badge as plain text (no glyphs)
- Validate the consumer config before resolving it, failing with the config file path instead of an opaque `TypeError`

### Fixed

- Guard the diff core against non-RGBA PNG pixel formats so a format change fails loudly instead of scoring garbage
- Memoize coverage init so concurrent workers no longer orphan the HTML report
- Raise subtle-text contrast to clear WCAG 1.4.3 (4.5:1) in both light and dark themes
- Reject non-finite or non-positive numeric CLI flags at parse time (e.g. `--idle-limit foo` no longer busy-loops the supervisor)
- Render the HTML report's default screenshot server-side so screenshots still show when JavaScript fails or is disabled
- Serialize per-baseline writes so stories sharing an action no longer race to create the same baseline under `--workers > 1`

### Removed

- Drop redundant "Failures" section at the bottom of the HTML report
- Stop linking to Playwright trace in the HTML report

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

[Unreleased]: https://github.com/nschneble/tuffgal/compare/v0.1.0-alpha.9...HEAD
[0.1.0-alpha.9]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.0
