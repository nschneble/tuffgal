# Migrating from Playwright

> **This is a stub.** Tuffgal has no official Playwright-test consumers
> yet. This guide will be filled in by the first team to migrate. Until
> then, it tracks the high-level details so a future author can start from
> a baseline instead of an empty page. Open an issue if you want to be that
> team!

Tuffgal sits on top of Playwright's library API, so migrating _from_
`@playwright/test` is less of a rewrite than it sounds. The locator
patterns, browser context model, and intercept primitives are all the same.
What you trade is the imperative test code for a JSON action library that
other authors can compose without reading TypeScript.

## What translates directly

| Playwright Test concept                    | Tuffgal equivalent                                          |
| ------------------------------------------ | ----------------------------------------------------------- |
| `await expect(…).toBeVisible()`            | `expect.anyOf` on the action                                |
| `page.click(locator)`                      | `{ kind: 'click', hint }`                                   |
| `page.fill(locator, value)`                | `{ kind: 'input', hint, value }`                            |
| `page.getByRole(role, { name })`           | `hint: { role, text }`                                      |
| `page.goto(url)`                           | `{ kind: 'navigate', path: '/…' }`                          |
| `page.locator(selector)`                   | `hint: { selector }`                                        |
| `page.route(pattern, handler)`             | `{ kind: 'intercept', pattern, method, respond }`           |
| `page.screenshot()` + `toHaveScreenshot()` | Implicit (every action screenshots on success)              |
| `page.waitForSelector(…)`                  | `{ kind: 'waitFor', hint }` or `expect.anyOf` on the action |
| `test.use({ storageState })`               | Story-level `needs` + `produces` labels                     |

## What changes

**No imperative test code.** Each story becomes a JSON file declaring an
ordered list of action references, plus `needs` and `produces`. Each action
becomes a JSON file declaring its steps plus `expect`, `mask`, `retry`,
and `diff`.

**No per-test setup/teardown.** DB reset is a single consumer-supplied
callback. Fixtures are named functions referenced from stories.

**Storage state inheritance is automatic.** A producer story persists its
state to `paths.authState/<label>.json` and consumer stories with matching
`needs` inherit it.

## Translation cookbook

(To be filled in by the first migrating consumer)

- [ ] `test.describe` → directory structure under `paths.stories/`
- [ ] `test.beforeAll` for DB seeding → `database.reset` in `tuffgal.config.ts`
- [ ] `test.beforeEach` for storage state → `needs` label on the story
- [ ] Snapshot directory → `paths.baselines/`
- [ ] `test.use({ baseURL })` → `baseUrl` in `tuffgal.config.ts`

## Open questions for the migration author

- Granularity of action splitting (one big action vs many small composable actions)
- How to keep parameterized tests cheap (Playwright Test's `test.each` has no direct Tuffgal equivalent, so stories must be enumerated)
- Whether to keep some non-visual assertions in `@playwright/test` for now (mixed-tool repos work fine; nothing prevents it)
