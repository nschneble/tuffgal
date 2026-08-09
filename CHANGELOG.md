# 🪵 Changelog

**All notable project changes will be documented in this file.** The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Pride Versioning](https://pridever.org) → `PROUD.DEFAULT.SHAME`

## [Unreleased]

_Nothing just yet_

## [0.2.0-alpha.6] – 2026-08-09

### Added

- Key glyph and abbreviation aliases for the `type` step: `Ctrl`,
  `Cmd`/`⌘`, `Opt`/`⌥`, `Esc`, and `Return` resolve to their Playwright
  key names, on their own and inside a combo

### Changed

- An unrecognized key in a `type` step now fails with an error naming the
  rejected key, the step value, and the aliases tuffgal accepts, in place
  of Playwright's bare `Unknown key`

## [0.2.0-alpha.5] – 2026-07-28

### Fixed

- A11y drift false positives from serialization-only changes

## [0.2.0-alpha.4] – 2026-07-18

### Changed

- `navigate` now defaults `waitUntil` to `'load'` because `networkidle`
  causes every navigation to stall to the full navigation timeout
- `navigate` rejects protocol-relative, backslash, and absolute-URL paths
  that could drive the browser off the target origin

### Fixed

- Playwright navigation timeouts fail an action on the first timeout

## [0.2.0-alpha.3] – 2026-07-16

### Added

Deep links for HTML report stories. Allows Tuffgal action to link directly
to changed stories in PR comments.

## [0.2.0-alpha.2] – 2026-07-12

Report improvements. The HTML report picks up a breakpoint filter, sharper
status filtering, and an interactive viewer redesigned around
blink-comparing what changed.

### Added

- Breakpoint filter pills in the report summary
- `npm run preview -- --interactive` renders sample report in interactive mode
- `sizeMismatch` on `results.json` action results

### Changed

- A status-filtered story now shows only its matching actions
- Candidate note names its referent
- Redesigned interactive mode so resting state is the selected variant
  - Press and hold the screenshot to flip to its baseline counterpart
  - The Baseline/Actual/Diff chips are always visible
  - The Showing caption tracks whatever is displayed
- Resized-screenshot note folded into one accessible sentence
- Summary status filters restyled as colorful pills

### Fixed

- A press-to-native-image-drag no longer leaves the preview stuck
- Bulk expand/collapse no longer pre-expands hidden screenshot panels
- "Expanded changed in 1 stories" pluralization in bulk-toggle announcement
- `npm run preview` silently never rendered interactive mode

## [0.2.0-alpha.1] – 2026-07-10

CI-owned baselines. CI is now the sole writer of committed baselines. Local
runs are advisory self-diffs. Committed visual changes are a PR review
gate, approved from a CI candidate tree rather than by any local `approve`.

### Added

- Run modes. `tuffgal run` resolves `--ci` / `--local`
  - Explicit flag wins
  - With neither, CI when `$CI` is truth-y, else local
- CI mode writes a self-contained candidate tree with a `results.json` copy
  - Never writes committed baselines
  - A missing baseline is `new` (candidate only)
  - An orphaned one is `deleted`
- `approve --from <dir>` promotes a CI candidate tree into `paths.baselines`
  - The only code path that writes committed baselines
  - Refuses any candidate whose `results.json` is not a clean CI run (`mode !== 'ci'` or `totals.failed > 0`)
  - `--prune` retires baselines marked `deleted`
- Environment manifest at `baselines/manifest.json`
  - Written by `approve --from` and checked by `run --ci`
  - Pixel-affecting mismatch still runs the comparison but banners the report and exits `3`
- Local advisory mode compares against a git-ignored per-machine cache
  - Plain `approve` now refreshes that cache
- CI exit codes
  - `2` (pending `new`/`changed`/`deleted` to approve)
  - `3` (environment mismatch)
  - Precedence `1` > `3` > `2`
- `results.json` fields
  - `mode`
  - `environment` (`expected`/`actual`/`mismatch`/`mismatchKeys`)
  - `deleted[]`
  - `totals.deleted`
  - `totals.new`
- Report additions
  - Environment-mismatch banner
  - Deleted baselines section
  - Per-action candidate + a11y-only-drift notes

### Changed

- **Breaking:** `tuffgal approve` no longer writes committed baselines
  - Plain `approve` targets the local cache only
  - Committed baselines are written solely by `approve --from` (CI/bot promo path)
  - Local runs are advisory
    - Exit `0` on visual drift
    - Exit `1` on failed stories only
    - Exit codes `2` and `3` are CI-mode only
- In CI mode an accessibility-tree drift now gates status
  - Pixels can match while the aria snapshot differs
  - Flips the action to `changed`
  - Stays advisory (informational) in local mode
- Every committed baseline, candidate, and cache write is losslessly recompressed
  - pngjs, deflate level 9 + adaptive filtering
  - Never lossy, never quantized

## [0.1.0-alpha.14] – 2026-07-04

### Fixed

A `viewport` capture no longer resets the page's scroll offset before shooting.

## [0.1.0-alpha.13] – 2026-06-30

### Changed

HTML report filters have been merged with the summary row. Plus a few other
miscellaneous UI/UX improvements.

## [0.1.0-alpha.12] – 2026-06-27

### Fixed

`tuffgal` did nothing when launched through the installed `.bin` symlink,
e.g. `npm run`, `npx`, or a bare `tuffgal`. The entry-point check compared
the unresolved symlink path against the symlink-resolved module URL, so
`main()` never ran. The script now resolves `argv[1]` through realpath
before the comparison.

## [0.1.0-alpha.11] – 2026-06-26

### Added

- Approve by breakpoint (e.g. `approve --desktop`, `approve --breakpoint <name>`)
- Approve by story (e.g. `approve user-logs-in`)
- `captureMode` config to limit screenshots to viewport-only or full page
- Documentation for CLI and reports
- `interactiveMode` config to view baseline/actual/diffs in a single-image view
- New baselines can now be filtered in the HTML report
- New baselines are now listed in the terminal summary report

### Changed

- Screenshots default to viewport-only (were previously full page)

### Fixed

- Multiple breakpoint runs no longer leak database state
- Report filters now only show matching actions inside each story

## [0.1.0-alpha.10] – 2026-06-22

### Added

- `${breakpoint}` interpolation token

### Fixed

- Per-breakpoint database isolation

## [0.1.0-alpha.9] – 2026-06-21

### Added

- Breakpoint modes, replacing the single `viewport` config
  - `mobile` 375×667 / `tablet` 768×1024 / `laptop` 1024×768 / `desktop` 1280×800
  - Each mode runs in its own browser context + produces its own baselines
  - Each `config.breakpoints` entry is a bare name (registry dimensions) or `{ name, width?, height? }` to override that mode's size; an omitted axis inherits the registry default
  - Order preserved; when a name repeats, the first entry wins
  - Omit `breakpoints` to run a single `desktop` mode (1280×800)
  - Per-story `breakpoints` field, same shape, that **replaces** the project's modes for that story; a story may run a mode the project does not configure, and its overrides resolve against the registry
  - Breakpoint grouping in the HTML report, each group labelled with the real capture size; a single-mode story renders as a flat list with no breakpoint chrome
  - Pre-breakpoint baselines at `<action>/0.png` are read as fallbacks until promoted

### Removed

**Breaking:** `viewport` config field + per-story `viewport` override. Set
a single mode's size with `breakpoints: [{ name: 'desktop', width, height }]`
instead.

## [0.1.0-alpha.8] – 2026-06-20

### Fixed

- Reset page scroll to origin before each full-page capture, so `position: sticky` and `fixed` elements no longer render shifted by `scrollY`

## [0.1.0-alpha.7] – 2026-06-20

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

## [0.1.0-alpha.6] – 2026-06-11

### Added

- Add per-story overrides for browser `viewport` optional config field
- Add `tuffgal approve --new-only` flag to limit baselines to new stories
- Allow reports to be filtered by passed, changed, or failed
- Allow reports to expand/contract all screenshots

### Changed

- Edit `tuffgal run` output to group changed, failed at end w/ report link
- Skip npm release if no version bump

## [0.1.0-alpha.5] – 2026-06-11

### Added

`navigate` step accepts an optional `waitUntil` field (`'load' |
'domcontentloaded' | 'networkidle' | 'commit'`) that overrides Playwright's
`page.goto` ready signal on a per-step basis. Defaults to `'networkidle'`.
Use `'domcontentloaded'` for dev-mode pages with long-tail external fetches
that prevent `networkidle` from settling.

## [0.1.0-alpha.4] – 2026-06-06

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

## [0.1.0-alpha.3] – 2026-06-06

Grants clipboard permissions in browser contexts.

Without `permissions: ['clipboard-read', 'clipboard-write']` Playwright
default-denies clipboard API access, which breaks any story using the Web
Clipboard API.

## [0.1.0-alpha.2] – 2026-06-04

`npm run build` now copies `src/reporter/assets/{report.css,report.js}`
into `dist/reporter/assets/`. Earlier alpha builds shipped without the
reporter's static assets, so the generated HTML report rendered without
styling or interactivity.

## [0.1.0-alpha.1] – 2026-06-04

### Changed

- Package now ships compiled `dist/` instead of raw `.ts` sources
- CLI entry point is `./dist/cli.js`

### Fixed

- Corrected `bin` extension and publish flags for the alpha channel

## [0.1.0-alpha.0] – 2026-06-04

Initial public alpha. Tuffgal extracted from [Linklater](https://github.com/nschneble/linklater)'s
in-tree visual testing workspace.

[Unreleased]: https://github.com/nschneble/tuffgal/compare/v0.2.0-alpha.6...HEAD
[0.2.0-alpha.6]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.6
[0.2.0-alpha.5]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.5
[0.2.0-alpha.4]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.4
[0.2.0-alpha.3]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/nschneble/tuffgal/releases/tag/v0.2.0-alpha.1
[0.1.0-alpha.14]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.11
[0.1.0-alpha.10]: https://github.com/nschneble/tuffgal/releases/tag/v0.1.0-alpha.10
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
