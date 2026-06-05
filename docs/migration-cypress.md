# Migrating from Cypress

> **This is a stub.** Tuffgal has no official Cypress consumers yet. This
> guide will be filled in by the first team to migrate. Until then, it tracks
> the high-level details so a future author can start from a baseline instead
> of an empty page. Open an issue if you want to be that team!

Migrating from Cypress to Tuffgal is bigger than migrating from Playwright
Test, for two reasons. First, Cypress runs in the browser using its own
command runner. Tuffgal runs in Node and drives the browser through
Playwright's library API. Second, Cypress's command chaining
(`.get().type().should()`) does not map one-to-one to Tuffgal's JSON step
model. Most teams should expect to rewrite their tests.

## What translates conceptually

| Cypress concept                         | Tuffgal equivalent                                              |
| --------------------------------------- | --------------------------------------------------------------- |
| `cy.click()`                            | `{ kind: 'click', hint }`                                       |
| `cy.get(selector)` + role/text matchers | `hint: { role, text }` or `hint: { selector }`                  |
| `cy.intercept(pattern, response)`       | `{ kind: 'intercept', pattern, method, respond }`               |
| `cy.matchImageSnapshot()`               | Implicit (every action screenshots on success)                  |
| `cy.session('label', loginFn)`          | Story-level `needs` + `produces` labels                         |
| `cy.task(name)` for DB seeding          | `database.reset` + `database.fixtures.<name>` in tuffgal.config |
| `cy.type(value)`                        | `{ kind: 'input', hint, value }`                                |
| `cy.visit(url)`                         | `{ kind: 'navigate', path: '/…' }`                              |
| `cy.wait('@alias')`                     | `expect.anyOf` candidate matching the post-success state        |

## What changes substantially

**No retry-until-true semantics.** Cypress retries every command until it
succeeds or times out. Tuffgal makes the wait explicit: `expect.anyOf` for
success criteria and `retry` for `LocatorNotFoundError` on bounded retries.
Stories that depended on implicit retry for race absorption will need a
`wait` or a tighter `expect`.

**No fixture system in the browser.** Cypress fixtures load JSON from disk
into the browser context. Tuffgal stubs network responses through
`intercept` instead. It's the same effect, but a different mechanism.

**No `cy.window()` escape hatch.** Stories cannot reach into app code from
the harness. State must be observable through DOM or network. Where you
used `cy.window().its('app.store').invoke(…)` you will need to drive the
same change through real UI interactions.

**Parallel execution by default.** Cypress runs tests serially per spec
file. Tuffgal schedules stories on a worker pool with topo-sorted
`needs`/`produces` ordering. Stories that mutate shared state need explicit
serialization labels.

## Translation cookbook

(To be filled in by the first migrating consumer)

- [ ] `describe` blocks → directory structure under `paths.stories/`
- [ ] `beforeEach` with `cy.task('db:reset')` → `database.reset` in `tuffgal.config.ts`
- [ ] `cy.session` for cached login → producer story with `produces: ["logged-in"]`
- [ ] `cy.intercept` aliases used by `cy.wait` → either `expect.anyOf` candidates or `intercept` step + later locator-based `expect`
- [ ] Plugin-based fixtures (`cy.fixture('records.json')`) → `intercept` with inline `respond.body`

## Open questions for the migration author

- Whether to keep Cypress for end-to-end assertions while moving visual regression to Tuffgal (split-tool repos work fine)
- Strategy for `cy.window()` escape-hatch tests that have no DOM-observable equivalent
- Handling of custom Cypress commands; Tuffgal's equivalent is composing actions, but a single Cypress command often expands into 5+ steps that need to be authored as a multi-step action
