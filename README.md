# Tuffgal

> JSON-driven visual regression for web apps. Authoring stays declarative,
> screenshots become a committable build artifact.

**Status:** Pre-release. `v0.1.0-alpha.0` in active extraction from the
`apps/testing-ui` workspace in [Linklater](https://github.com/nschneble/linklater).
Public API is unstable until `v1.0.0`.

## The idea

Tuffgal sits between component tests (fast but mocked) and end-to-end
tests (real but verbose). You write **actions** (atomic user steps) and
**stories** (chains of actions) as JSON. The harness runs them in a real
browser, captures a screenshot after each story, and pixel-diffs against
a baseline you commit alongside your code.

When a screenshot changes, a human reviews the diff and decides.

## What ships in v1

- 10 step primitives: `navigate`, `click`, `input`, `scroll`, `intercept`,
  `waitFor`, `read`, `type`, `wait` (plus `screenshot` as the implicit
  capture point)
- DAG scheduler with `needs` / `produces` labels and parallel workers
- SSIM-gated visual diff (default 0.99 threshold) + pixelmatch overlay +
  a11y-tree snapshot for semantic drift
- Trace zip on failure (Playwright trace viewer)
- Clock freeze (`page.clock.install`)
- Storage-state persistence across stories
- Static HTML reporter + optional SARIF for GitHub code scanning
- V8 coverage (optional, via `monocart-coverage-reports`)
- Per-story DB reset + fixture hooks (consumer-supplied via config)
- Process supervisor for dev-server hot-reload rot

## What is explicitly out of scope at v1

- AI fuzzy locator matching (deferred to v1.1, BYOLLM)
- Hosted SaaS / cloud runs
- Native mobile (Playwright cannot drive it)
- WebDriver / Puppeteer substrate
- Browsers other than Chromium

## Quick start (when alpha releases)

```bash
npm install -D tuffgal
npx tuffgal init     # scaffolds tuffgal.config.ts
npx tuffgal run      # runs all stories
```

## Documentation

- [Authoring guide](docs/authoring.md) (TBD)
- [App contract](docs/app-contract.md) (TBD)
- [CI integration](docs/ci.md) (TBD)
- [Migrating from Playwright](docs/migration-playwright.md) (TBD)

## License

MIT. See [LICENSE](LICENSE).

## Roadmap

| Milestone | Status |
| --- | --- |
| Repo bootstrap | ✅ |
| Core extraction from Linklater | 🚧 |
| Bridges (DB, dev-server, storage state) | ⏳ |
| Linklater migration | ⏳ |
| GitHub Action | ⏳ |
| `v0.1.0-alpha.0` npm publish | ⏳ |
| `v1.0.0` public launch | ⏳ |
| `v1.1` AI fuzzy matching | Deferred |
