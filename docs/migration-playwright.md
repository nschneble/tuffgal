# Migrating from Playwright

> **Stub.** Tuffgal has no Playwright-test consumers yet. This guide will be filled in by the first team to migrate; until then it tracks the high-level shape so a future author starts from a baseline rather than an empty page. Open an issue if you want to be that team.

Tuffgal sits on top of Playwright's library API, so migrating *from* `@playwright/test` is less of a rewrite than it sounds: the locator patterns, browser context model, and intercept primitives are all the same. What you trade is the imperative test code for a JSON action library that other authors can compose without reading TypeScript.

## What translates directly

| Playwright Test concept              | Tuffgal equivalent                                              |
| ------------------------------------ | --------------------------------------------------------------- |
| `page.goto(url)`                     | `{ kind: 'navigate', path: '/...' }`                            |
| `page.getByRole(role, { name })`     | `hint: { role, text }`                                          |
| `page.locator(selector)`             | `hint: { selector }`                                            |
| `page.fill(locator, value)`          | `{ kind: 'input', hint, value }`                                |
| `page.click(locator)`                | `{ kind: 'click', hint }`                                       |
| `page.waitForSelector(...)`          | `{ kind: 'waitFor', hint }` or `expect.anyOf` on the action     |
| `page.route(pattern, handler)`       | `{ kind: 'intercept', pattern, method, respond }`               |
| `await expect(...).toBeVisible()`    | `expect.anyOf` on the action                                    |
| `test.use({ storageState })`         | Story-level `needs` + `produces` labels                         |
| `page.screenshot()` + `toHaveScreenshot()` | Implicit. Every action screenshots on success.            |

## What changes

- **No imperative test code.** Each story becomes a JSON file declaring an ordered list of action references plus `needs` and `produces`. Each action becomes a JSON file declaring its steps plus `expect`, `mask`, `retry`, `diff`.
- **No per-test setup/teardown.** DB reset is a single consumer-supplied callback. Fixtures are named functions referenced from stories.
- **Storage state inheritance is automatic.** A producer story persists its state to `paths.authState/<label>.json`; consumer stories with matching `needs` inherit it.

## Translation cookbook

(To be filled in by the first migrating consumer.)

- [ ] `test.describe` → directory structure under `paths.stories/`.
- [ ] `test.beforeAll` for DB seeding → `database.reset` in `tuffgal.config.ts`.
- [ ] `test.beforeEach` for storage state → `needs` label on the story.
- [ ] Snapshot directory → `paths.baselines/`.
- [ ] `test.use({ baseURL })` → `baseUrl` in `tuffgal.config.ts`.

## Open questions for the migration author

- Granularity of action splitting (one big action vs many small composable actions).
- How to keep parameterised tests cheap (Playwright Test's `test.each` has no direct Tuffgal equivalent — stories must be enumerated).
- Whether to keep some non-visual assertions in `@playwright/test` for now (mixed-tool repos work fine; nothing prevents it).
