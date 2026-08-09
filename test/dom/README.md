# DOM tests

Real-browser tests for behavior the `src/**/*.test.ts` suite cannot reach,
because it renders HTML strings and mocks Playwright rather than driving
either one.

- `breakpoint-filter` covers the report's client-side filter intersection,
  empty-state, and live-region wording, which `report.js` owns and a
  string render never builds a live DOM for.
- `type-keys` covers the `type` step's key handling against a real
  keyboard. Relabelling Playwright's unknown-key failure depends on
  matching its message text, which is internal to playwright-core, so a
  reworded release would leave the mocked suite green while authors
  silently fell back to the bare upstream error. This is what notices.
  It also proves every alias resolves to a key Playwright really knows.

They live outside `src/` on purpose. `npm test` stays pure-unit and mocks
Playwright, so CI needs no browser; a real-Chromium test in that glob would
break it. Run these separately:

```sh
npm run install:browsers   # once, if Chromium isn't installed
npm run test:dom
```

They are still type-checked and linted with the rest of the tree.
