/**
 * Playwright failures as tuffgal's own code receives them, for suites
 * that mock the browser away. Each one is verbatim from a real Chromium
 * run, prefix and all: the client prefixes the call it was making, so an
 * unprefixed copy of the throw site in playwright-core is not what
 * arrives, and a suite built on one would pass while production missed.
 *
 * These live in one place so the wording is restated once. Nothing here
 * observes Playwright, so re-check them against a real browser when
 * upgrading it.
 */

/**
 * `keyboard.press` rejecting a key name, as `_keyDescriptionForString`
 * words it and `press` delivers it: `keyboard.press: Unknown key: "esc"`.
 */
export function unknownKeyFailure(token: string): Error {
  return new Error(`keyboard.press: Unknown key: "${token}"`);
}
