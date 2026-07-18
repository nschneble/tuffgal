# DOM tests

Real-browser tests for the report's client-side behavior — the filter
intersection, empty-state, and live-region wording that `report.js` owns.
The `src/**/*.test.ts` suite renders HTML strings and never builds a live DOM,
so it cannot reach this logic; these tests launch Chromium and drive the actual
report.

They live outside `src/` on purpose. `npm test` stays pure-unit and mocks
Playwright, so CI needs no browser; a real-Chromium test in that glob would
break it. Run these separately:

```sh
npm run install:browsers   # once, if Chromium isn't installed
npm run test:dom
```

They are still type-checked and linted with the rest of the tree.
