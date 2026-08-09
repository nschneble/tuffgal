/**
 * Real-browser coverage for the `type` step's key handling, which the
 * node:test suite cannot reach: that suite mocks the keyboard, so every
 * fixture there restates Playwright's unknown-key wording rather than
 * observing it. `explainKeyPressFailure` recognises that failure by
 * matching the message text, which is internal to playwright-core, so a
 * reworded release would leave the unit suite green while authors silently
 * fell back to the bare upstream error. Pressing real keys is the only
 * thing that can notice.
 *
 * This also checks the invariant the whole error contract rests on: every
 * name an alias resolves to is a key Playwright actually knows. If one is
 * not, the token Playwright rejects could be one this layer wrote rather
 * than one the author can find in their own step value.
 *
 * NOT part of `npm test` (that suite is pure-unit and mocks Playwright so CI
 * needs no browser). Run it with `npm run test:dom`, which needs a Chromium
 * install first: `npm run install:browsers`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

import { normaliseKey, UnknownKeyError } from '../../src/runner/steps/keys.ts';
import { runType } from '../../src/runner/steps/type.ts';

// Every Playwright key name an alias resolves to, deduped. Derived from
// normaliseKey rather than hand-listed, so an alias added to the table
// without a real key behind it fails here instead of at an author's step.
const ALIASES = ['Ctrl', 'Cmd', '⌘', 'Opt', '⌥', 'Esc', 'Return'];
const ALIAS_TARGETS = [...new Set(ALIASES.map((alias) => normaliseKey(alias)))];

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<body></body>', { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * Records every keydown the page sees, in order. Reaches the page globals
 * through `globalThis`, since the project's tsconfig carries no DOM lib.
 */
type KeyRecorder = {
  __keys: string[];
  addEventListener: (
    type: string,
    listener: (event: { key: string }) => void,
  ) => void;
};

async function recordKeys(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as KeyRecorder;
    scope.__keys = [];
    scope.addEventListener('keydown', (event) => scope.__keys.push(event.key));
  });
  return () =>
    page.evaluate(() => (globalThis as unknown as KeyRecorder).__keys);
}

test('every alias resolves to a key Playwright actually knows', async () => {
  await withPage(async (page) => {
    for (const target of ALIAS_TARGETS) {
      await assert.doesNotReject(
        () => page.keyboard.press(target),
        `"${target}" is an alias target, so Playwright must know it`,
      );
    }

    const readKeys = await recordKeys(page);
    await runType(page, 'Esc');
    await runType(page, 'Return');
    await runType(page, 'Ctrl+Return');
    assert.deepEqual(
      await readKeys(),
      ['Escape', 'Enter', 'Control', 'Enter'],
      'aliases dispatch the key their target names',
    );
  });
});

test("an unknown key is relabelled from Playwright's own failure", async () => {
  await withPage(async (page) => {
    // The pin. If a Playwright release rewords its unknown-key failure,
    // explainKeyPressFailure stops recognising it and rethrows the raw
    // cause, so this stops being an UnknownKeyError and this test is the
    // only thing in the tree that notices.
    const single = await runType(page, 'esc').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(
      single instanceof UnknownKeyError,
      `expected the failure to be relabelled, got: ${String(single)}`,
    );
    assert.match(single.message, /^Unknown key "esc"\. /);
    assert.match(single.message, /Esc→Escape/);

    // A combo names the token Playwright rejected, not the whole value.
    const combo = await runType(page, 'Cmd+esc').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(combo instanceof UnknownKeyError);
    assert.match(
      combo.message,
      /^Unknown key "esc" in the `type` step value "Cmd\+esc"/,
    );

    // A trailing `+` splits to an empty token, so Playwright rejects the
    // empty string and there is no name to quote.
    const empty = await runType(page, 'Control+').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(empty instanceof UnknownKeyError);
    assert.match(
      empty.message,
      /^Unknown key in the `type` step value "Control\+"/,
    );
  });
});

test('a failure that is not an unknown key keeps its own diagnostic', async () => {
  await withPage(async (page) => {
    await page.close();
    const error = await runType(page, 'A').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof Error);
    assert.ok(
      !(error instanceof UnknownKeyError),
      'a closed page is not an unknown key, so it must pass through',
    );
  });
});
